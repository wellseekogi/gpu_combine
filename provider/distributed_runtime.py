#!/usr/bin/env python3
"""Own one llama.cpp b10964 RPC worker or distributed model server (Python 3.10+).

RPC is experimental and unauthenticated. Use trusted, non-sensitive data on an
isolated LAN or authenticated private overlay with a peer-only firewall. Private
IP validation is not authentication. The HTTP backend is dedicated to Relay;
other processes on its host are trusted. No shell, downloads or automatic retry.
"""
import argparse
import hashlib
import ipaddress
import json
import math
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError

if __package__:
    from .provider import digest_file, request_json
    from .gguf_metadata import read_metadata_fields
else:
    from provider import digest_file, request_json
    from gguf_metadata import read_metadata_fields


PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in
                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"))
CHILD_ENV = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL",
             "LD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES", "CUDA_DEVICE_ORDER"}


def private_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        raise ValueError("Use an explicit private IPv4 address, not a hostname or IPv6.") from None
    if not any(address in network for network in PRIVATE_NETWORKS):
        raise ValueError("RPC requires RFC1918 or 100.64.0.0/10; public/wildcard/loopback IPs are refused.")
    return str(address)


def checked_file(value, expected, label):
    path = Path(value).resolve(strict=True)
    if not path.is_file() or not re.fullmatch(r"[0-9a-fA-F]{64}", expected):
        raise ValueError(label + " requires a local file and its full SHA-256.")
    if digest_file(path) != expected.lower():
        raise ValueError(label + " SHA-256 differs from the approved file.")
    return str(path)



def load_group(args):
    """Read the gateway's contract; full pool/VRAM admission remains in the Node planner."""
    with open(args.group_config, "rb") as source:
        raw = source.read(256 * 1024 + 1)
    if len(raw) > 256 * 1024:
        raise ValueError("Group config must not exceed 256 KiB.")
    config = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(config, dict) or type(config.get("version")) is not int or config["version"] != 1:
        raise ValueError("Group config.version must be 1.")
    groups = config.get("groups")
    if not isinstance(groups, list) or not 1 <= len(groups) <= 8 or any(not isinstance(group, dict) for group in groups):
        raise ValueError("Group config.groups must contain 1..8 objects.")
    selected = [group for group in groups if group.get("id") == args.group]
    if len(selected) != 1:
        raise ValueError("--group must identify exactly one configured group.")
    group = selected[0]
    if group.get("backend") != "llama.cpp" or group.get("splitMode") != "layer" or "enabled" in group:
        raise ValueError("The group must use llama.cpp layer splitting, without an enabled override.")
    if group.get("topology") not in ("lan", "wan"):
        raise ValueError("Group topology must be lan or wan.")
    for field in ("id", "model"):
        if not isinstance(group.get(field), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}", group[field]):
            raise ValueError("Group " + field + " must be a 1..256 character identifier.")
    endpoint = group.get("endpoint")
    match = re.fullmatch(r"http://127\.0\.0\.1(?::([1-9][0-9]{0,4}))?/?", endpoint) if isinstance(endpoint, str) else None
    if not match or not 1 <= int(match.group(1) or 80) <= 65535:
        raise ValueError("Launcher group endpoint must be a literal http://127.0.0.1 origin.")
    args.port = int(match.group(1) or 80)
    for field in ("modelSha256", "templateSha256"):
        if not isinstance(group.get(field), str) or not re.fullmatch(r"[a-f0-9]{64}", group[field]):
            raise ValueError("Group " + field + " must be a lowercase SHA-256.")
    def integer(value, name, minimum, maximum):
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError(name + " is outside the supported integer range.")
        return value
    args.slots = integer(group.get("slots"), "Group slots", 1, 16)
    args.context_per_slot = integer(group.get("contextTokens"), "Group contextTokens", 512, 131072)
    architecture = group.get("modelArchitecture")
    if not isinstance(architecture, dict):
        raise ValueError("Group modelArchitecture must be an object.")
    layers = integer(architecture.get("layers"), "Model layers", 1, 1024)
    integer(architecture.get("kvHeads"), "Model KV heads", 1, 1024)
    integer(architecture.get("headDim"), "Model head dimension", 1, 8192)
    if type(architecture.get("kvBytes")) is not int or architecture["kvBytes"] != 2:
        raise ValueError("Group modelArchitecture.kvBytes must be 2 for f16 KV.")
    gpus = group.get("gpus")
    if not isinstance(gpus, list) or not 1 <= len(gpus) <= 16 or any(not isinstance(gpu, dict) for gpu in gpus):
        raise ValueError("Group gpus must contain 1..16 objects.")
    stage_layers = [integer(gpu.get("layers"), "GPU layers", 1, layers) for gpu in gpus]
    if sum(stage_layers) != layers:
        raise ValueError("Group GPU stages must assign every model layer exactly once.")
    args.gpu_count = len(gpus)
    # b10964 llama-model.cpp includes the output head in the all-offloaded split.
    # Integer stage counts give the same float boundary as il / (layers + 1).
    stage_layers[-1] += 1
    args.tensor_split = ",".join(str(count) for count in stage_layers)
    args.model_sha256, args.template_sha256 = group["modelSha256"], group["templateSha256"]
    args.alias = group["model"]
    args.model_architecture = architecture



def verify_model_metadata(args):
    arch = read_metadata_fields(args.model, ["general.architecture"]).get("general.architecture")
    if arch not in ("llama", "qwen2", "qwen3"):
        raise ValueError("Only dense uniform llama, qwen2 and qwen3 GGUF architectures are supported.")
    unsupported = ("attention.sliding_window", "attention.sliding_window_pattern", "expert_count",
                   "expert_used_count", "expert_shared_count", "nextn_predict_layers", "full_attention_interval",
                   "attention.kv_lora_rank", "attention.key_length_mla", "attention.value_length_mla",
                   "attention.key_length_swa", "attention.value_length_swa", "attention.key_length_mla_swa",
                   "attention.value_length_mla_swa", "attention.kv_lora_rank_swa", "attention.shared_kv_layers",
                   "attention.recurrent_layers", "attention.compress_ratios")
    required = ("block_count", "embedding_length", "context_length", "attention.head_count",
                "attention.head_count_kv", "attention.key_length", "attention.value_length")
    data = read_metadata_fields(args.model, ["split.count", *[arch + "." + key for key in (*required, *unsupported)]])
    split_count = data.get("split.count", 1)
    if type(split_count) is not int or split_count != 1:
        raise ValueError("Only a single unsplit GGUF can be pinned by this launcher.")
    for key in unsupported:
        value = data.get(arch + "." + key, 0)
        if type(value) is not int or value != 0:
            raise ValueError("Unsupported GGUF attention/expert layout: " + arch + "." + key)
    def positive(key, default=None):
        value = data.get(arch + "." + key, default)
        if type(value) is not int or value <= 0:
            raise ValueError("GGUF " + arch + "." + key + " must be a positive scalar integer.")
        return value
    layers = positive("block_count")
    heads = positive("attention.head_count")
    embedding = positive("embedding_length")
    kv_heads = positive("attention.head_count_kv", heads)
    if heads % kv_heads:
        raise ValueError("GGUF attention heads must be divisible by KV heads.")
    default_head_dim = embedding // heads if embedding % heads == 0 else None
    key_dim = positive("attention.key_length", default_head_dim)
    value_dim = positive("attention.value_length", default_head_dim)
    declared = args.model_architecture
    if (layers != declared["layers"] or kv_heads != declared["kvHeads"]
            or key_dim != declared["headDim"] or value_dim != declared["headDim"]):
        raise ValueError("GGUF layers/KV heads/key-value dimensions differ from group.modelArchitecture.")
    if positive("context_length") < args.context_per_slot:
        raise ValueError("Configured context exceeds the GGUF model context_length.")


def validate(args):
    if not args.trusted_private_network:
        raise ValueError("--trusted-private-network is required: RPC peers must be isolated and trusted.")
    if args.role == "server":
        load_group(args)
    if not 1 <= args.port <= 65535 or not math.isfinite(args.startup_timeout) or args.startup_timeout <= 0:
        raise ValueError("Use port 1..65535 and a finite, positive startup timeout.")
    devices = args.device.split(",")
    if (not devices or len(set(devices)) != len(devices)
            or any(not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]*", device) for device in devices)):
        raise ValueError("--device requires unique device names from llama-server --list-devices.")
    if args.role == "rpc":
        args.bind = private_ipv4(args.bind)
        if any(re.fullmatch(r"RPC\d+", device) for device in devices):
            raise ValueError("RPC workers must expose local devices, not another RPC worker.")
    else:
        peers = []
        for value in args.rpc.split(","):
            host, separator, port = value.rpartition(":")
            if not separator or not port.isascii() or not port.isdigit() or not 1 <= int(port) <= 65535:
                raise ValueError("--rpc requires privateIPv4:port pairs.")
            peers.append(private_ipv4(host) + ":" + str(int(port)))
        if len(set(peers)) != len(peers):
            raise ValueError("Duplicate RPC peers are not allowed.")
        args.rpc = ",".join(peers)
        if not any(re.fullmatch(r"RPC\d+", device) for device in devices):
            raise ValueError("Include at least one remote RPC device in --device.")
        if len(devices) != args.gpu_count:
            raise ValueError("--device order/count must match the selected group.gpus entries.")
        # ponytail: one GGUF; add a complete shard hash manifest when split files are needed.
        if re.search(r"-\d{5}-of-\d{5}\.gguf$", args.model, re.IGNORECASE):
            raise ValueError("Use one GGUF file; split GGUF needs a hash for every shard and is not supported here.")
        args.model = checked_file(args.model, args.model_sha256, "Model")
        verify_model_metadata(args)
        args.template = checked_file(args.template, args.template_sha256, "Template")
        Path(args.template).read_bytes().decode("utf-8")
    args.binary = checked_file(args.binary, args.binary_sha256, "Runtime")
    if Path(args.binary).suffix.lower() in {".cmd", ".bat", ".ps1", ".sh", ".py"}:
        raise ValueError("--binary must be the native executable, not a script.")
    return args


class DistributedRuntime:
    def __init__(self, args):
        self.args = validate(args)
        self.process = None
        self.stopping = False
        self.slot_directory = None

    def command(self):
        a = self.args
        if a.role == "rpc":
            return [a.binary, "--host", a.bind, "--port", str(a.port), "--device", a.device]
        return [a.binary, "--model", a.model, "--chat-template-file", a.template, "--jinja",
                "--alias", a.alias, "--rpc", a.rpc, "--device", a.device,
                "--split-mode", "layer", "--tensor-split", a.tensor_split,
                "--gpu-layers", "all", "--fit", "off", "--offline",
                "--ctx-size", str(a.slots * a.context_per_slot), "--parallel", str(a.slots),
                "--no-context-shift", "--no-kv-unified", "--cache-type-k", "f16",
                "--cache-type-v", "f16", "--cache-ram", "0", "--no-cache-idle-slots",
                "--ctx-checkpoints", "0", "--slots", "--slot-save-path", self.slot_directory.name,
                "--host", "127.0.0.1", "--port", str(a.port)] + (["--metrics"] if a.metrics else []) + (["--verbose"] if a.verbose else [])

    def request_stop(self, *_):
        self.stopping = True

    def stop_runtime(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            self.process = None
        if self.slot_directory is not None:
            self.slot_directory.cleanup()
            self.slot_directory = None

    def check_server_contract(self):
        a = self.args
        base = "http://127.0.0.1:" + str(a.port)
        request_json(base + "/health", timeout=2)
        props = request_json(base + "/props", timeout=2)
        if (props.get("total_slots") != a.slots
                or props.get("default_generation_settings", {}).get("n_ctx") != a.context_per_slot
                or props.get("model_alias") != a.alias
                or not props.get("endpoint_slots")
                or os.path.normcase(os.path.realpath(props.get("model_path", ""))) != os.path.normcase(a.model)
                or hashlib.sha256(props.get("chat_template", "").encode()).hexdigest() != a.template_sha256.lower()):
            raise RuntimeError("Active model/template/alias/slots/context differs from the approved contract.")

    def start(self):
        if self.process is not None or self.stopping:
            raise RuntimeError("This launcher starts one owned process once.")
        a = self.args
        host = a.bind if a.role == "rpc" else "127.0.0.1"
        try:
            # Never attach to a pre-existing service. This host must be trusted.
            with socket.socket() as probe:
                probe.bind((host, a.port))
            if a.role == "server":
                self.slot_directory = tempfile.TemporaryDirectory(prefix="relay-kv-slots-")
            self.process = subprocess.Popen(
                self.command(), shell=False, stdin=subprocess.DEVNULL,
                env={key: value for key, value in os.environ.items() if key.upper() in CHILD_ENV},
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            deadline = time.monotonic() + a.startup_timeout
            while not self.stopping and time.monotonic() < deadline:
                code = self.process.poll()
                if code is not None:
                    raise RuntimeError("Owned runtime exited during startup (code " + str(code) + ").")
                try:
                    if a.role == "server":
                        self.check_server_contract()
                    else:
                        with socket.create_connection((host, a.port), timeout=2):
                            pass
                    return
                except HTTPError as exc:
                    if exc.code != 503:
                        raise
                except (URLError, OSError):
                    pass
                time.sleep(0.2)
            if not self.stopping:
                raise RuntimeError("Runtime startup timed out; check peers, memory, device order and logs.")
        except BaseException:
            self.stop_runtime()
            raise

    def run(self):
        try:
            self.start()
            if not self.stopping:
                print("Owned " + self.args.role + " is ready; keep this launcher running.", flush=True)
            while not self.stopping:
                code = self.process.poll()
                if code is not None:
                    raise RuntimeError("Owned runtime exited (code " + str(code) + "); no automatic model restart.")
                time.sleep(0.2)
        finally:
            self.stop_runtime()


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    roles = p.add_subparsers(dest="role", required=True)
    for role in ("rpc", "server"):
        child = roles.add_parser(role, help="Own a remote GPU worker" if role == "rpc" else "Own the distributed model")
        child.add_argument("--binary", required=True, help="Native b10964 executable with RPC enabled; never downloaded")
        child.add_argument("--binary-sha256", required=True, help="Approved SHA-256 of this exact executable")
        child.add_argument("--device", required=True, help="Explicit device list; server tensor proportions follow this order")
        child.add_argument("--startup-timeout", type=float, default=600, help="Seconds including model transfer/loading (default 600)")
        child.add_argument("--trusted-private-network", action="store_true", help="Acknowledge trusted peers, firewall isolation and non-sensitive data; RPC has no authentication")
        if role == "rpc":
            child.add_argument("--port", type=int, default=50052)
            child.add_argument("--bind", required=True, help="Explicit RFC1918 or private-overlay 100.64/10 IPv4; never 0.0.0.0")
        else:
            child.add_argument("--group-config", required=True, help="The same version 1 JSON used by RELAY_INFERENCE_CONFIG; run its Node planner before launch")
            child.add_argument("--group", required=True, help="Configured group ID; derives hashes, alias, port, slots, context and layer split")
            child.add_argument("--model", required=True, help="One local, unsplit GGUF matching group.modelSha256")
            child.add_argument("--template", required=True, help="Exact UTF-8 chat template")
            child.add_argument("--rpc", required=True, help="Ordered comma-separated privateIPv4:port peers")
            child.add_argument("--metrics", action="store_true", help="Enable loopback Prometheus endpoint")
            child.add_argument("--verbose", action="store_true", help="Show debug layer placement; logs may include prompt contents")
            child.epilog = "First inspect: llama-server --rpc PEERS --list-devices. RPC0/RPC1 names depend on peer order and exposed devices. Match --device order to group.gpus. Split counts include the output head on the last GPU; verify actual allocation and memory in logs. HTTP is loopback-only with Relay as its only client."
    return p


def main(argv=None):
    p = parser()
    try:
        runtime = DistributedRuntime(p.parse_args(argv))
    except (ValueError, OSError) as exc:
        p.error(str(exc))
    previous = {sig: signal.signal(sig, runtime.request_stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        runtime.run()
        return 0
    except (RuntimeError, OSError, ValueError) as exc:
        print("Distributed runtime: " + str(exc), file=sys.stderr)
        return 1
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    sys.exit(main())

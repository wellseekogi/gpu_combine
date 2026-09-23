"""Launcher contract and owned-child lifecycle checks; no GPU is exercised."""
import hashlib
import importlib.util
import json
import struct
from bisect import bisect_right
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

spec = importlib.util.spec_from_file_location("provider.distributed_runtime", Path(__file__).parents[1] / "provider" / "distributed_runtime.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def model_fixture(fields):
    def text(value):
        raw = value.encode("utf-8")
        return struct.pack("<Q", len(raw)) + raw
    entries = []
    for key, value in fields.items():
        if isinstance(value, str):
            kind, raw = 8, text(value)
        elif isinstance(value, list):
            kind, raw = 9, struct.pack("<IQ", 4, len(value)) + b"".join(struct.pack("<I", item) for item in value)
        elif isinstance(value, bool):
            kind, raw = 7, struct.pack("<?", value)
        else:
            kind, raw = 4, struct.pack("<I", value)
        entries.append(text(key) + struct.pack("<I", kind) + raw)
    return b"GGUF" + struct.pack("<IQQ", 3, 0, len(entries)) + b"".join(entries)


class DistributedRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        root = Path(self.folder.name)
        self.files = {}
        self.model_fields = {"general.architecture": "llama", "llama.block_count": 64,
                             "llama.embedding_length": 4096, "llama.context_length": 8192,
                             "llama.attention.head_count": 32, "llama.attention.head_count_kv": 8}
        for name, body in (("runtime.exe", b"fake-native-binary"), ("model.gguf", model_fixture(self.model_fields)),
                           ("template.jinja", b"approved\r\ntemplate")):
            path = root / name
            path.write_bytes(body)
            self.files[name] = (str(path), hashlib.sha256(body).hexdigest())
        self.common = ["--binary", self.files["runtime.exe"][0], "--binary-sha256", self.files["runtime.exe"][1],
                       "--trusted-private-network", "--device", "CUDA0"]
        self.config_path = root / "inference.json"
        self.config = {"version": 1, "groups": [{
            "id": "large", "model": "relay-large", "backend": "llama.cpp", "splitMode": "layer",
            "topology": "lan", "endpoint": "http://127.0.0.1:8082",
            "modelSha256": self.files["model.gguf"][1], "templateSha256": self.files["template.jinja"][1],
            "slots": 2, "contextTokens": 4096,
            "modelArchitecture": {"layers": 64, "kvHeads": 8, "headDim": 128, "kvBytes": 2},
            "gpus": [{"id": "local", "layers": 32}, {"id": "remote", "layers": 32}]}]}
        self.config_path.write_text("\ufeff" + json.dumps(self.config), encoding="utf-8")
        self.server = ["server", *self.common, "--device", "CUDA0,RPC0", "--rpc", "100.64.1.2:50052",
                       "--group-config", str(self.config_path), "--group", "large",
                       "--model", self.files["model.gguf"][0], "--template", self.files["template.jinja"][0]]

    def runtime(self, argv=None):
        runtime = module.DistributedRuntime(module.parser().parse_args(self.server if argv is None else argv))
        self.addCleanup(runtime.stop_runtime)
        return runtime

    def props(self, runtime):
        return {"total_slots": 2, "default_generation_settings": {"n_ctx": 4096},
                "model_alias": "relay-large", "endpoint_slots": True, "model_path": runtime.args.model,
                "chat_template": "approved\r\ntemplate"}

    def test_private_boundary_hash_and_device_contract_before_spawn(self):
        for bad in ("0.0.0.0", "8.8.8.8", "127.0.0.1", "169.254.1.1", "::1", "localhost", "100.128.0.1"):
            with self.subTest(address=bad), self.assertRaises(ValueError):
                self.runtime(["rpc", *self.common, "--bind", bad])
        with self.assertRaisesRegex(ValueError, "trusted-private-network"):
            self.runtime([value for value in self.server if value != "--trusted-private-network"])
        for flags in (("--binary-sha256", "0" * 64), ("--device", "CUDA0,CUDA0"),
                      ("--device", "RPC0"), ("--rpc", "10.0.0.2:80,10.0.0.2:080")):
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                self.runtime([*self.server, *flags])
        rpc = self.runtime(["rpc", *self.common, "--bind", "100.64.1.2"])
        self.assertEqual(rpc.command()[1:], ["--host", "100.64.1.2", "--port", "50052", "--device", "CUDA0"])

    def test_shared_manifest_pins_contract_and_rejects_invalid_or_oversized_config(self):
        runtime = self.runtime()
        self.assertEqual((runtime.args.alias, runtime.args.port, runtime.args.slots, runtime.args.context_per_slot),
                         ("relay-large", 8082, 2, 4096))
        for field, value in (("slots", True), ("slots", 17), ("contextTokens", 511),
                             ("endpoint", "http://localhost:8082"), ("endpoint", "http://[::1]:8082"),
                             ("endpoint", "http://127.0.0.1:8082/path"), ("splitMode", "row"),
                             ("modelSha256", "0" * 64), ("templateSha256", "0" * 64),
                             ("gpus", [{"layers": 10}, {"layers": 10}])):
            config = json.loads(json.dumps(self.config))
            config["groups"][0][field] = value
            self.config_path.write_text(json.dumps(config), encoding="utf-8")
            with self.subTest(field=field, value=value), patch.object(module.subprocess, "Popen") as popen:
                with self.assertRaises(ValueError):
                    self.runtime()
                popen.assert_not_called()
        self.config_path.write_text(json.dumps({"version": 1, "groups": self.config["groups"] * 2}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.runtime()
        self.config_path.write_bytes(b" " * (256 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "256 KiB"):
            self.runtime()

    def test_layer_split_includes_output_head_and_matches_b10964_float_boundaries(self):
        def float32(value):
            return struct.unpack("<f", struct.pack("<f", value))[0]
        for stages, expected in (([32, 32], "32,33"), ([16, 48], "16,49")):
            for gpu, count in zip(self.config["groups"][0]["gpus"], stages):
                gpu["layers"] = count
            self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
            runtime = self.runtime()
            self.assertEqual(runtime.args.tensor_split, expected)
            split = [int(value) for value in expected.split(",")]
            total = sum(split)
            boundaries = [float32(sum(split[:i + 1]) / total) for i in range(len(split))]
            # b10964 uses upper_bound(cumulative split, float(il) / act_gpu_layers).
            assignments = [bisect_right(boundaries, float32(layer / total)) for layer in range(total)]
            self.assertEqual([assignments[:-1].count(i) for i in range(len(split))], stages)
            self.assertEqual(assignments[-1], len(split) - 1)

    def test_actual_gguf_dimensions_and_attention_layout_are_checked_after_hash(self):
        for field, value in (("general.architecture", "deepseek2"), ("llama.block_count", 32),
                             ("llama.attention.head_count_kv", 4), ("llama.attention.head_count", [32] * 64),
                             ("llama.attention.head_count_kv", [8] * 64), ("llama.block_count", [64]),
                             ("llama.embedding_length", 2048), ("llama.attention.key_length", 256),
                             ("llama.attention.value_length", 256), ("llama.context_length", 2048),
                             ("llama.attention.sliding_window", 4096), ("llama.expert_count", 8),
                             ("llama.nextn_predict_layers", 1), ("llama.attention.kv_lora_rank", 512),
                             ("llama.attention.recurrent_layers", [0] * 64), ("split.count", 2)):
            body = model_fixture({**self.model_fields, field: value})
            Path(self.files["model.gguf"][0]).write_bytes(body)
            self.config["groups"][0]["modelSha256"] = hashlib.sha256(body).hexdigest()
            self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
            with self.subTest(field=field, value=value), patch.object(module.subprocess, "Popen") as popen:
                with self.assertRaises(ValueError):
                    self.runtime()
                popen.assert_not_called()

    def test_dense_architectures_explicit_head_dims_and_mha_fallback(self):
        for arch in ("llama", "qwen2", "qwen3"):
            fields = {key.replace("llama.", arch + "."): value for key, value in self.model_fields.items()}
            fields["general.architecture"] = arch
            # Explicit Qwen-style dimensions need not equal embedding / attention heads.
            fields[arch + ".embedding_length"] = 2560
            fields[arch + ".attention.key_length"] = 128
            fields[arch + ".attention.value_length"] = 128
            body = model_fixture(fields)
            Path(self.files["model.gguf"][0]).write_bytes(body)
            self.config["groups"][0]["modelSha256"] = hashlib.sha256(body).hexdigest()
            self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
            self.runtime()
        fields = dict(self.model_fields)
        del fields["llama.attention.head_count_kv"]
        fields["llama.attention.head_count"] = 8
        fields["llama.embedding_length"] = 1024
        body = model_fixture(fields)
        Path(self.files["model.gguf"][0]).write_bytes(body)
        self.config["groups"][0]["modelSha256"] = hashlib.sha256(body).hexdigest()
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        self.runtime()

    def test_fixed_slots_exact_template_minimum_environment_and_cleanup(self):
        runtime = self.runtime([*self.server, "--verbose"])
        process = Mock()
        process.poll.return_value = None
        def response(url, **kwargs):
            return self.props(runtime) if url.endswith("/props") else {"status": "ok"}
        with patch.object(module.socket, "socket"), patch.object(module, "request_json", side_effect=response), \
                patch.object(module.subprocess, "Popen", return_value=process) as popen, \
                patch.dict(module.os.environ, {"SYSTEMROOT": "windows", "RELAY_NODE_TOKEN": "secret",
                                              "OPENAI_API_KEY": "secret", "LLAMA_ARG_HOST": "0.0.0.0"}, clear=True):
            runtime.start()
        command = popen.call_args.args[0]
        for option, value in (("--ctx-size", "8192"), ("--parallel", "2"), ("--split-mode", "layer"),
                              ("--host", "127.0.0.1"), ("--fit", "off"), ("--gpu-layers", "all"),
                              ("--cache-ram", "0"), ("--ctx-checkpoints", "0")):
            self.assertEqual(command[command.index(option) + 1], value)
        for option in ("--no-kv-unified", "--no-context-shift", "--no-cache-idle-slots", "--offline", "--verbose"):
            self.assertIn(option, command)
        self.assertFalse(popen.call_args.kwargs["shell"])
        self.assertEqual(popen.call_args.kwargs["env"], {"SYSTEMROOT": "windows"})
        slot_path = Path(runtime.slot_directory.name)
        self.assertTrue(slot_path.exists())
        runtime.stop_runtime()
        process.terminate.assert_called_once()
        self.assertFalse(slot_path.exists())

    def test_startup_contract_mismatch_fails_closed_without_retry(self):
        runtime = self.runtime()
        process = Mock()
        process.poll.return_value = None
        for changes in ({"chat_template": "approved\ntemplate"}, {"total_slots": 1},
                        {"model_alias": "different"}, {"model_path": "other.gguf"},
                        {"default_generation_settings": {"n_ctx": 8192}}):
            with self.subTest(changes=changes):
                bad = {**self.props(runtime), **changes}
                with patch.object(module.socket, "socket"), patch.object(module.subprocess, "Popen", return_value=process), \
                        patch.object(module, "request_json", side_effect=[{}, bad]) as request:
                    with self.assertRaisesRegex(RuntimeError, "contract"):
                        runtime.start()
                self.assertEqual(request.call_count, 2)
                self.assertIsNone(runtime.process)
                self.assertIsNone(runtime.slot_directory)

    def test_loading_503_retries_but_owned_child_exit_is_not_success(self):
        runtime = self.runtime()
        process = Mock()
        process.poll.side_effect = [None, 7, 7]
        with patch.object(module.socket, "socket"), patch.object(module.subprocess, "Popen", return_value=process), \
                patch.object(module.time, "sleep"), patch.object(module, "request_json", side_effect=HTTPError("local", 503, "loading", {}, None)):
            with self.assertRaisesRegex(RuntimeError, "code 7"):
                runtime.start()
        self.assertIsNone(runtime.process)
        process.terminate.assert_not_called()

    def test_occupied_port_never_spawns_and_stop_escalates_only_owned_child(self):
        runtime = self.runtime()
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            runtime.args.port = occupied.getsockname()[1]
            with patch.object(module.subprocess, "Popen") as popen:
                with self.assertRaises(OSError):
                    runtime.start()
            popen.assert_not_called()
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("owned", 5), 0]
        runtime.process = process
        runtime.request_stop()
        runtime.stop_runtime()
        self.assertTrue(runtime.stopping)
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        self.assertIsNone(runtime.process)

    def test_run_always_cleans_up_after_stop_and_inference_child_failure(self):
        for stopped in (True, False):
            runtime = self.runtime()
            process = Mock()
            process.poll.return_value = 0
            def fake_start():
                runtime.process = process
                runtime.stopping = stopped
            with patch.object(runtime, "start", side_effect=fake_start):
                if stopped:
                    runtime.run()
                else:
                    with self.assertRaisesRegex(RuntimeError, "no automatic"):
                        runtime.run()
            self.assertIsNone(runtime.process)

    def test_reporting_checks_origin_credentials_and_only_local_gpu_ids_before_spawn(self):
        for origin in ("http://example.com", "https://user:password@example.com", "https://example.com/path",
                       "https://example.com/?key=secret", "https://example.com:0", "https://example.com\\evil"):
            with self.subTest(origin=origin), patch.dict(module.os.environ, {"RELAY_INFERENCE_PROVIDER_TOKEN": "k" * 32}):
                with self.assertRaises(ValueError):
                    self.runtime([*self.server, "--coordinator", origin, "--gpu-id", "local"])
        with patch.dict(module.os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, "PROVIDER_TOKEN"):
            self.runtime([*self.server, "--coordinator", "https://relay.example", "--gpu-id", "local"])
        with patch.dict(module.os.environ, {"RELAY_INFERENCE_PROVIDER_TOKEN": "k" * 32}):
            for ids in ([], ["remote"], ["local", "remote"], ["local", "local"]):
                options = [item for gpu_id in ids for item in ("--gpu-id", gpu_id)]
                with self.subTest(ids=ids), self.assertRaises(ValueError):
                    self.runtime([*self.server, "--coordinator", "https://relay.example", *options])

    def test_reclaim_finishes_while_coordinator_is_blocked_and_reports_in_order(self):
        entered, unblock = threading.Event(), threading.Event()
        reported = []
        transports = []
        process = Mock()
        process.poll.return_value = None
        process.wait.return_value = 0
        with patch.dict(module.os.environ, {"RELAY_INFERENCE_PROVIDER_TOKEN": "k" * 32}):
            runtime = self.runtime([*self.server, "--coordinator", "https://relay.example", "--gpu-id", "local"])
            def response(url, payload=None, token=None, **kwargs):
                if url.startswith("https://"):
                    reported.append(payload)
                    transports.append((token, kwargs["timeout"]))
                    if payload["state"] == "providing":
                        entered.set()
                        unblock.wait(timeout=5)
                        raise URLError("coordinator offline")
                    return {"ok": True}
                return self.props(runtime) if url.endswith("/props") else {}
            try:
                with patch.object(module.socket, "socket"), patch.object(module, "request_json", side_effect=response), \
                        patch.object(module.subprocess, "Popen", return_value=process) as popen:
                    runtime.start()
                    self.assertTrue(entered.wait(timeout=2))
                    runtime.request_stop()
                    self.assertEqual(runtime.state, "released")
                    self.assertIsNone(runtime.process)
                    process.terminate.assert_called_once()
                    process.wait.assert_called_once()
                    self.assertFalse(unblock.is_set())
                    self.assertNotIn("RELAY_INFERENCE_PROVIDER_TOKEN", popen.call_args.kwargs["env"])
                    unblock.set()
                    runtime._notifications.put(None)
                    runtime._notifier.join(timeout=2)
            finally:
                unblock.set()
                if runtime._notifier.is_alive():
                    runtime._notifications.put(None)
                    runtime._notifier.join(timeout=2)
        self.assertEqual([entry["state"] for entry in reported], ["providing", "reclaiming", "released"])
        self.assertEqual(transports, [("k" * 32, 2)] * 3)
        self.assertTrue(all(entry["runtimeId"] == runtime.runtime_id and entry["startedAt"] == runtime.started_at
                            and entry["groupId"] == "large" and entry["gpuIds"] == ["local"] for entry in reported))

    def test_failed_owned_process_exit_never_reports_return_complete(self):
        runtime = self.runtime()
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired("owned", 5)
        runtime.process = process
        with self.assertRaises(subprocess.TimeoutExpired):
            runtime.request_stop()
        self.assertEqual(runtime.state, "reclaiming")
        self.assertIs(runtime.process, process)
        process.kill.assert_called_once()
        process.wait.side_effect = None
        runtime.stop_runtime()
        self.assertEqual(runtime.state, "released")

    def test_stop_confirms_real_owned_process_exit_without_a_gpu(self):
        runtime = self.runtime()
        def response(url, **kwargs):
            return self.props(runtime) if url.endswith("/props") else {}
        with patch.object(module.socket, "socket"), patch.object(module, "request_json", side_effect=response), \
                patch.object(runtime, "command", return_value=[sys.executable, "-c", "import time; time.sleep(30)"]):
            runtime.start()
        process = runtime.process
        self.assertIsNone(process.poll())
        runtime.request_stop()
        self.assertIsNotNone(process.poll())
        self.assertEqual(runtime.state, "released")


if __name__ == "__main__":
    unittest.main()

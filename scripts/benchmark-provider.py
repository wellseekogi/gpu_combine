"""Measure provider HTTP reuse and SHA allocations; synthetic loopback, no GPU/TLS claim.

python scripts/benchmark-provider.py --baseline path/to/previous/provider.py --output result.json
The baseline is optional. No credentials or running Relay instance are used.
"""
import argparse
import hashlib
import importlib.util
import json
import socket
import statistics
import tempfile
import threading
import time
import tracemalloc
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = {"messages": [{"role": "user", "content": "한글 통신 메모리 " * 1500}], "temperature": 0, "max_tokens": 1024}
COUNT = 150
REPEATS = 5


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.server.connections += 1

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        assert json.loads(raw) == PAYLOAD
        self.server.body_bytes += len(raw)
        self.send_response(200)
        self.send_header("Content-Length", "11")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *_):
        pass


def load(label, path):
    spec = importlib.util.spec_from_file_location(label, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, help="Optional previous provider.py to compare")
    parser.add_argument("--output", type=Path, help="Optional JSON report; always printed to stdout")
    args = parser.parse_args()
    modules = {}
    if args.baseline:
        modules["baseline"] = load("before", args.baseline)
    modules["optimized"] = load("after", ROOT / "provider/provider.py")
    report = {"scope": "Synthetic HTTP/1.1 loopback; TCP_NODELAY server; no TLS/WAN/GPU; 64 MiB warm-file SHA-256.",
              "requestsPerRepeat": COUNT, "repeats": REPEATS, "results": {}}
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.connections = server.body_bytes = 0
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="relay-sha-benchmark-") as folder:
            model = Path(folder) / "synthetic.gguf"
            block = bytes(range(256)) * 4096
            with model.open("wb") as output:
                for _ in range(64):
                    output.write(block)
            digest = hashlib.sha256()
            for _ in range(64):
                digest.update(block)
            expected = digest.hexdigest()
            for label, module in modules.items():
                rounds = []
                for _ in range(REPEATS):
                    if hasattr(module, "close_http_connections"):
                        module.close_http_connections()
                    server.connections = server.body_bytes = 0
                    start = time.perf_counter()
                    for _ in range(COUNT):
                        assert module.request_json("http://127.0.0.1:" + str(server.server_port), PAYLOAD) == {"ok": True}
                    rounds.append({"elapsedMs": (time.perf_counter() - start) * 1000,
                                   "tcpConnections": server.connections, "requestBodyBytes": server.body_bytes})
                if hasattr(module, "close_http_connections"):
                    module.close_http_connections()
                hash_times, hash_peaks = [], []
                for _ in range(REPEATS):
                    tracemalloc.start()
                    start = time.perf_counter()
                    assert module.digest_file(model) == expected
                    hash_times.append((time.perf_counter() - start) * 1000)
                    hash_peaks.append(tracemalloc.get_traced_memory()[1])
                    tracemalloc.stop()
                report["results"][label] = {
                    "httpMedianMs": statistics.median(item["elapsedMs"] for item in rounds),
                    "tcpConnectionsPerRepeat": [item["tcpConnections"] for item in rounds],
                    "requestBodyBytesPerRepeat": rounds[0]["requestBodyBytes"],
                    "hash64MiBMedianMs": statistics.median(hash_times),
                    "hashPeakPythonBytes": max(hash_peaks), "httpRounds": rounds,
                }
    finally:
        for module in modules.values():
            if hasattr(module, "close_http_connections"):
                module.close_http_connections()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

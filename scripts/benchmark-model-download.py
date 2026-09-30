"""Actual provider model download, synthetic loopback HTTP and full SHA-256; no TLS/GPU claim."""
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
from types import SimpleNamespace


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module", action="append", help="label=path/to/provider.py; may repeat")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--mib", type=int, default=64)
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    if not 1 <= args.mib <= 1024 or not 1 <= args.repeats <= 30:
        parser.error("Use 1..1024 MiB and 1..30 repeats")
    sources = args.module or ["current=" + str(Path(__file__).resolve().parents[1] / "provider/provider.py")]
    modules = {}
    for source in sources:
        label, path = source.split("=", 1)
        spec = importlib.util.spec_from_file_location(label, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        modules[label] = module
    block = bytes(range(256)) * 256
    size = args.mib * 1024**2
    digest = hashlib.sha256()
    for _ in range(size // len(block)):
        digest.update(block)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.send_response(200)
            self.send_header("Content-Length", str(size))
            self.end_headers()
            for _ in range(size // len(block)):
                self.wfile.write(block)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    report = {"scope": "Actual provider download+file write+SHA-256; synthetic HTTP/1.1 loopback with 64 KiB writes; no TLS/WAN/GPU.",
              "size": size, "repeats": args.repeats, "results": {label: [] for label in modules}}
    artifact = {"id": "benchmark-model-0001", "size": size, "digest": digest.hexdigest()}
    try:
        with tempfile.TemporaryDirectory(prefix="relay-download-benchmark-") as folder:
            for iteration in range(args.repeats):
                order = list(modules.items())
                if iteration % 2:
                    order.reverse()
                for label, module in order:
                    worker = module.Provider.__new__(module.Provider)
                    worker.args = SimpleNamespace(coordinator="http://127.0.0.1:" + str(server.server_port), node="synthetic-node")
                    worker.token = "synthetic-token"
                    worker.stop = False
                    worker._initialize_guards()
                    path = Path(folder) / "synthetic.gguf"
                    tracemalloc.start()
                    start = time.perf_counter()
                    worker.download_model(artifact, path)
                    elapsed = (time.perf_counter() - start) * 1000
                    peak = tracemalloc.get_traced_memory()[1]
                    tracemalloc.stop()
                    assert path.stat().st_size == size
                    path.unlink()
                    report["results"][label].append({"elapsedMs": elapsed, "peakPythonBytes": peak})
            report["summary"] = {label: {"medianMs": statistics.median(row["elapsedMs"] for row in rounds),
                                          "peakPythonBytes": max(row["peakPythonBytes"] for row in rounds)}
                                 for label, rounds in report["results"].items()}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

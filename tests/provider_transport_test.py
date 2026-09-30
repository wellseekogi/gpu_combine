"""Real loopback regressions for bounded, reusable provider transports (no GPU)."""
import hashlib
import concurrent.futures
import importlib.util
import json
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("transport_provider", Path(__file__).parents[1] / "provider/provider.py")
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


class ProviderTransportTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        suite = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def setup(self):
                super().setup()
                self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

            def handle(self):
                try:
                    super().handle()
                except ConnectionError:
                    pass  # Expected when the client rejects and closes a bad response.

            def do_GET(self):
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                suite.requests.append((self.path, self.client_address, self.headers.get("Authorization"), data))
                if self.path == "/lost-response":
                    self.close_connection = True
                    return
                if self.path == "/truncated":
                    self.send_response(200)
                    self.send_header("Content-Length", "20")
                    self.end_headers()
                    self.wfile.write(b"{}")
                    self.close_connection = True
                    return
                if self.path == "/oversized-header":
                    self.send_response(200)
                    self.send_header("Content-Length", "1000001")
                    self.end_headers()
                    self.close_connection = True
                    return
                if self.path == "/oversized-chunk":
                    self.send_response(200)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    self.wfile.write(b"F4241\r\n" + b"x" * 1000001 + b"\r\n0\r\n\r\n")
                    self.close_connection = True
                    return
                status = 307 if self.path == "/redirect" else 401 if self.path == "/denied" else 200
                body = b"invalid" if self.path == "/bad-json" else b"{}"
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                if self.path == "/redirect":
                    self.send_header("Location", "/must-not-follow")
                if self.path == "/close":
                    self.send_header("Connection", "close")
                if self.path == "/short-keepalive":
                    self.send_header("Keep-Alive", "timeout=1, max=100")
                self.end_headers()
                self.wfile.write(body)

            do_POST = do_GET

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        provider.close_http_connections()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_reuses_connection_with_compact_utf8_and_fresh_auth_and_timeout(self):
        payload = {"messages": [{"role": "user", "content": "한글 😀" * 100}], "stream": False}
        for token, timeout in (("first-token", 2), (None, 0.75), ("next-token", 1)):
            self.assertEqual(provider.request_json(self.base + "/chat?q=1", payload, token, timeout), {})
            connection = next(iter(provider._HTTP_CONNECTIONS.connections.values()))[0]
            self.assertEqual(connection.sock.gettimeout(), timeout)
        self.assertEqual(len({entry[1] for entry in self.requests}), 1)
        self.assertEqual([entry[2] for entry in self.requests], ["Bearer first-token", None, "Bearer next-token"])
        raw = self.requests[0][3]
        self.assertEqual(json.loads(raw), payload)
        self.assertEqual(raw, json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode())
        self.assertLess(len(raw), len(json.dumps(payload).encode()))

    def test_bad_responses_discard_socket_and_next_request_recovers(self):
        for path, error in (("/truncated", provider.IncompleteRead), ("/bad-json", ValueError),
                            ("/oversized-header", ValueError), ("/oversized-chunk", ValueError),
                            ("/denied", HTTPError), ("/redirect", HTTPError)):
            with self.subTest(path=path):
                with self.assertRaises(error):
                    provider.request_json(self.base + path)
                failed_address = self.requests[-1][1]
                self.assertEqual(provider.request_json(self.base + "/ok"), {})
                self.assertNotEqual(failed_address, self.requests[-1][1])
        self.assertNotIn("/must-not-follow", [entry[0] for entry in self.requests])

    def test_lost_post_response_is_not_automatically_replayed(self):
        with self.assertRaises(provider.TRANSPORT_ERRORS):
            provider.request_json(self.base + "/lost-response", {"action": "submit"})
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(provider.request_json(self.base + "/ok"), {})

    def test_server_close_header_reconnects_without_extra_failed_request(self):
        provider.request_json(self.base + "/close")
        provider.request_json(self.base + "/ok")
        self.assertEqual(len(self.requests), 2)
        self.assertNotEqual(self.requests[0][1], self.requests[1][1])

    def test_idle_connections_expire_before_default_and_advertised_server_limits(self):
        for path, advance in (("/ok", 4.01), ("/short-keepalive", 0.51)):
            clock = [10.0]
            provider.close_http_connections()
            with self.subTest(path=path), patch.object(provider, "time", SimpleNamespace(monotonic=lambda: clock[0])):
                provider.request_json(self.base + path)
                address = self.requests[-1][1]
                clock[0] += advance
                provider.request_json(self.base + "/ok")
                self.assertNotEqual(address, self.requests[-1][1])

    def test_worker_and_poll_thread_use_independent_connections(self):
        provider.request_json(self.base + "/main")
        errors = []

        def worker():
            try:
                for _ in range(2):
                    provider.request_json(self.base + "/worker")
            except Exception as exc:
                errors.append(exc)
            finally:
                provider.close_http_connections()

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        provider.request_json(self.base + "/main")
        addresses = {path: {entry[1] for entry in self.requests if entry[0] == path} for path in ("/main", "/worker")}
        self.assertEqual([len(value) for value in addresses.values()], [1, 1])
        self.assertFalse(addresses["/main"] & addresses["/worker"])

    def test_pool_is_bounded_and_evicted_socket_closes(self):
        # Failed connections still create pool entries; no extra servers are necessary.
        provider.request_json(self.base + "/ok")
        first = next(iter(provider._HTTP_CONNECTIONS.connections.values()))[0]
        for hostname in ("localhost", "127.0.0.2"):
            with socket.socket() as unused:
                unused.bind(("127.0.0.1", 0))
                port = unused.getsockname()[1]
                with self.assertRaises(provider.TRANSPORT_ERRORS):
                    provider.request_json("http://" + hostname + ":" + str(port), timeout=0.2)
        self.assertEqual(len(provider._HTTP_CONNECTIONS.connections), 2)
        self.assertIsNone(first.sock)

    def test_untrusted_url_syntax_is_refused_before_connection(self):
        for url in ("file:///secret", self.base + "/#fragment", self.base + "/\nheader",
                    self.base + "\\other", "http://token@127.0.0.1/", "http://@127.0.0.1/", "http://127.0.0.1:0/"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                provider.request_json(url)
        self.assertEqual(self.requests, [])

    def test_streaming_digest_handles_empty_and_partial_buffers(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "model.gguf"
            for size in (0, 1, 256 * 1024, 2 * 1024 * 1024 + 17):
                payload = bytes(range(256)) * (size // 256) + bytes(range(size % 256))
                path.write_bytes(payload)
                self.assertEqual(provider.digest_file(path), hashlib.sha256(payload).hexdigest())

    def test_work_wait_preserves_heartbeat_and_lease_deadlines(self):
        worker = provider.Provider.__new__(provider.Provider)
        future = concurrent.futures.Future()
        with patch.object(provider.time, "monotonic", return_value=10), patch.object(provider.concurrent.futures, "wait") as wait:
            for lease, expected in ((None, 3), (20, 3), (10.25, 0.25), (9, 0)):
                worker.lease = lease
                worker._sleep(3, future)
                wait.assert_called_with((future,), timeout=expected)

    def test_long_poll_opt_in_never_delays_lease_renewals_or_active_rentals(self):
        worker = provider.Provider.__new__(provider.Provider)
        worker.args = SimpleNamespace(coordinator=self.base, pool="test", node="node")
        worker.token = "test-token"
        worker.stop = False
        worker._initialize_guards()
        cases = [("status", {}, None, None, False), ("poll", {}, None, None, True),
                 ("poll", {"attemptId": "attempt"}, None, None, False),
                 ("poll", {"epoch": 1}, None, None, False),
                 ("poll", {"rentalId": "rental"}, None, None, False),
                 ("poll", {}, time.monotonic() + 20, None, False),
                 ("poll", {}, None, "rental", False)]
        with patch.object(provider, "request_json", return_value={"result": {}}) as request:
            for action, payload, lease, rental, expected in cases:
                worker.lease, worker.rental_id = lease, rental
                worker.api(action, payload)
                command = request.call_args.args[1]
                self.assertEqual(command.get("waitMs"), 10000 if expected else None)
                self.assertEqual(command["payload"], payload)
                self.assertLessEqual(request.call_args.kwargs["timeout"], 12)

    def test_idle_long_poll_marker_skips_extra_sleep_but_legacy_server_keeps_fallback(self):
        for supported in (False, True):
            worker = provider.Provider.__new__(provider.Provider)
            worker.args = SimpleNamespace(once=False)
            worker.token, worker.contract, worker.stop, worker.process = "test-token", {}, False, None
            worker._initialize_guards()
            worker.stop_runtime = Mock()
            polls = []

            def api(action, _payload):
                if action == "status":
                    return {"paused": False}
                polls.append(action)
                worker.stop = len(polls) == 2
                return {"task": None, **({"waitSupported": True} if supported else {})}

            worker.api = api
            with self.subTest(supported=supported), patch.object(worker, "_sleep") as sleep:
                worker.run()
                self.assertEqual(len(polls), 2)
                self.assertEqual(sleep.call_count, 0 if supported else 2)

    def test_run_submits_completed_inference_and_reports_preparation_without_three_second_delay(self):
        for preparing in (False, True):
            with self.subTest(preparing=preparing):
                worker = provider.Provider.__new__(provider.Provider)
                worker.args = SimpleNamespace(once=True, coordinator=self.base, pool="test", node="node")
                worker.token = "synthetic-test-token"
                worker.stop = False
                worker.process = None
                worker.contract = {}
                worker.lease = None
                worker._initialize_guards()
                worker.stop_runtime = Mock()
                worker._close_rental = Mock()
                started, complete, reported, ready_sent = (threading.Event() for _ in range(4))
                errors = []
                worker_connections = []
                request_json = provider.request_json
                task = {"taskId": "test-task", "lease": {"attemptId": "test-attempt", "epoch": 1}}
                rental = {"id": "rental-1234567890", "modelArtifact": {}, "model": {}, "leaseRemainingMs": 30000}

                def work(_task):
                    for _ in range(2):
                        request_json(self.base + "/worker-completion")
                    worker_connections.extend(connection for connection, _ in provider._HTTP_CONNECTIONS.connections.values())
                    started.set()
                    if not complete.wait(4):
                        raise RuntimeError("Test did not finish work")
                    return {"raw": "test answer"}

                worker.execute_task = worker._prepare_rental = work
                sleep = worker._sleep

                def stop_after_ready(seconds, pending=None):
                    if ready_sent.is_set():
                        worker.stop = True
                        reported.set()
                        return
                    sleep(seconds, pending)

                worker._sleep = stop_after_ready

                def request(_url, payload=None, token=None, **_kwargs):
                    if payload["action"] == "status":
                        return {"result": {"paused": False}}
                    if payload["action"] == "submit":
                        reported.set()
                        return {"result": {"receipt": "test-receipt"}}
                    if preparing:
                        if payload["payload"].get("rentalStage") == "ready":
                            ready_sent.set()
                        return {"result": {"rental": rental}}
                    return {"result": {"task": task, "leaseRemainingMs": 30000}}

                def run():
                    try:
                        worker.run()
                    except Exception as exc:
                        errors.append(exc)

                with patch.object(provider, "request_json", side_effect=request):
                    thread = threading.Thread(target=run)
                    thread.start()
                    try:
                        self.assertTrue(started.wait(1), str(errors))
                        complete.set()
                        self.assertTrue(reported.wait(1), "Finished work must wake the coordinator loop before its 3s heartbeat")
                    finally:
                        worker.stop = True
                        complete.set()
                        thread.join(timeout=4)
                        worker._clear_lease()
                    self.assertFalse(thread.is_alive())
                    self.assertEqual(errors, [])
                    self.assertEqual(len(worker_connections), 1, "worker calls must reuse the origin socket")
                    self.assertIsNone(worker_connections[0].sock, "executor-owned sockets close explicitly before worker teardown")

    def test_failed_worker_also_closes_its_connections(self):
        worker = provider.Provider.__new__(provider.Provider)
        connections = []

        def fail(_argument):
            provider.request_json(self.base + "/worker-failure")
            connections.extend(connection for connection, _ in provider._HTTP_CONNECTIONS.connections.values())
            raise RuntimeError("simulated failure")

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            with self.assertRaisesRegex(RuntimeError, "simulated failure"):
                executor.submit(worker._worker_call, fail, None).result()
        self.assertEqual(len(connections), 1)
        self.assertIsNone(connections[0].sock)


if __name__ == "__main__":
    unittest.main()

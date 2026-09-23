"""Independent provider acceptance tests for audited failure and recovery paths.

Run: python -m unittest discover -s tests -p "audit_provider_test.py" -v
Uses an ephemeral loopback HTTP server and a simulated monotonic clock. No GPU,
actual connection files, credentials, or Relay database is used.
"""
import concurrent.futures
import importlib.util
import json
import threading
import time
from http.client import IncompleteRead, RemoteDisconnected
from urllib.error import HTTPError
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    "audit_provider_runtime", Path(__file__).parents[1] / "provider" / "provider.py"
)
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


def bare_worker(*, once=False):
    worker = provider.Provider.__new__(provider.Provider)
    worker.args = SimpleNamespace(
        once=once, coordinator="http://127.0.0.1:1", pool="audit", node="audit-node"
    )
    worker.token = "audit-test-token"
    worker.stop = False
    worker.process = None
    worker.contract = {}
    worker.lease = None
    worker._initialize_guards()
    worker.start_runtime = Mock()
    worker.stop_runtime = Mock()
    return worker


class ProviderAuditTests(unittest.TestCase):
    def test_lost_submit_response_retries_the_identical_result_payload(self):
        worker = bare_worker(once=True)
        task = {"taskId": "audit-task", "lease": {"attemptId": "audit-attempt", "epoch": 1}}
        result = {"taskId": "audit-task", "attemptId": "audit-attempt", "epoch": 1,
                  "raw": '{"items": []}'}
        future = concurrent.futures.Future()
        future.set_result(result)
        executor = Mock()
        executor.submit.return_value = future
        submissions = []

        def request(_url, payload=None, token=None, **_kwargs):
            if payload["action"] == "status":
                return {"result": {"paused": False}}
            if payload["action"] == "poll":
                return {"result": {"task": task, "leaseRemainingMs": 30000}}
            self.assertEqual(payload["action"], "submit")
            submissions.append(payload["payload"])
            if len(submissions) == 1:
                raise TimeoutError("simulated response lost after server commit")
            return {"result": {"receipt": "audit-receipt"}}

        for error in (TimeoutError("response lost"), RemoteDisconnected("peer closed"),
                      ConnectionResetError("connection reset"), IncompleteRead(b"{", 100)):
            with self.subTest(error=type(error).__name__):
                submissions.clear()
                worker.stop = False

                def failing_once(url, payload=None, token=None, **kwargs):
                    if payload["action"] == "submit" and not submissions:
                        submissions.append(payload["payload"])
                        raise error
                    return request(url, payload, token, **kwargs)

                with patch.object(provider, "request_json", side_effect=failing_once), \
                        patch.object(provider.time, "monotonic", return_value=0), \
                        patch.object(provider.time, "sleep"), \
                        patch.object(provider.concurrent.futures, "ThreadPoolExecutor", return_value=executor):
                    worker.run()
                self.assertEqual(len(submissions), 2)
                self.assertIs(submissions[0], result)
                self.assertIs(submissions[1], result)

    def test_pause_during_renewal_reclaims_and_releases_the_original_attempt(self):
        worker = bare_worker(once=True)
        task = {"taskId": "audit-task", "lease": {"attemptId": "audit-attempt", "epoch": 7}}
        future = concurrent.futures.Future()
        future.result = Mock(side_effect=TimeoutError("simulated inference still running"))
        executor = Mock()
        executor.submit.return_value = future
        calls = []
        renewals = []

        def request(_url, payload=None, token=None, **_kwargs):
            calls.append(payload)
            if payload["action"] == "status":
                return {"result": {"paused": False}}
            if payload["action"] == "release":
                return {"result": {"released": True}}
            if "attemptId" in payload["payload"]:
                renewals.append(payload)
                return {"result": {"paused": len(renewals) > 1, "leaseRemainingMs": 30000}}
            return {"result": {"task": task, "leaseRemainingMs": 30000}}

        with patch.object(provider, "request_json", side_effect=request), \
                patch.object(provider.time, "monotonic", return_value=0), \
                patch.object(provider.time, "sleep"), \
                patch.object(provider.concurrent.futures, "ThreadPoolExecutor", return_value=executor):
            with self.assertRaisesRegex(RuntimeError, "paused"):
                worker.run()
        worker.stop_runtime.assert_called()
        self.assertEqual([call["action"] for call in calls], ["status", "poll", "poll", "poll", "release"])
        self.assertEqual(calls[2]["payload"], {"capabilities": ["chat", "renter-model", "rental-session"], "attemptId": "audit-attempt", "epoch": 7})
        self.assertEqual(calls[4]["payload"], {"taskId": "audit-task", "attemptId": "audit-attempt", "epoch": 7})
    def test_idle_worker_recovers_after_coordinator_closes_without_response(self):
        """A transient peer close must not permanently end an otherwise live worker."""
        self.assert_idle_recovers("close")

    def test_idle_worker_recovers_after_truncated_content_length_body(self):
        self.assert_idle_recovers("content-length")

    def test_idle_worker_recovers_after_incomplete_http_chunk(self):
        self.assert_idle_recovers("chunked")

    def assert_idle_recovers(self, fault):
        requests = []

        class Coordinator(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                requests.append(self.path)
                if len(requests) == 1:
                    if fault != "close":
                        self.send_response(200)
                        if fault == "content-length":
                            self.send_header("Content-Length", "100")
                            self.end_headers()
                            self.wfile.write(b'{"result":')
                        else:
                            self.send_header("Transfer-Encoding", "chunked")
                            self.end_headers()
                            self.wfile.write(b'40\r\n{"result":')
                        self.wfile.flush()
                    self.close_connection = True
                    return
                body = json.dumps({"result": {"paused": True}}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Coordinator)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        worker = bare_worker()
        worker.args.coordinator = "http://127.0.0.1:" + str(server.server_port)
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) >= 2:
                worker.stop = True

        try:
            with patch.object(provider.time, "sleep", side_effect=sleep):
                worker.run()
            self.assertGreaterEqual(len(requests), 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_network_renewal_wait_cannot_keep_gpu_running_past_server_lease(self):
        """A stalled renewal must reclaim GPU before the initial 30-second grant expires."""
        worker = bare_worker(once=True)
        clock = [0.0]
        stopped_at = []
        worker.stop_runtime.side_effect = lambda: stopped_at.append(clock[0])
        task = {"taskId": "audit-task", "lease": {"attemptId": "audit-attempt", "epoch": 1}}
        future = concurrent.futures.Future()
        # No inference thread is needed; an unfinished future represents running GPU work.
        executor = Mock()
        executor.submit.return_value = future
        # Avoid waiting seven seconds for the artificial in-flight future during cleanup.
        future.result = Mock(side_effect=TimeoutError("simulated inference still running"))
        delays = iter([5, 12, 12])
        renewals = []

        def request(_url, payload=None, token=None, timeout=12):
            action = payload["action"]
            if action == "status":
                return {"result": {"paused": False}}
            if action == "release":
                return {"result": {"released": True}}
            if "attemptId" not in payload["payload"]:
                return {"result": {"task": task, "leaseRemainingMs": 30000}}
            renewals.append(payload)
            if len(renewals) == 1:
                return {"result": {"leaseRemainingMs": 30000}}
            clock[0] += min(next(delays), timeout)
            raise TimeoutError("simulated coordinator network timeout")

        def sleep(seconds):
            clock[0] += seconds

        with patch.object(provider, "request_json", side_effect=request), \
                patch.object(provider.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(provider.time, "sleep", side_effect=sleep), \
                patch.object(provider.concurrent.futures, "ThreadPoolExecutor", return_value=executor):
            with self.assertRaises((TimeoutError, RuntimeError)):
                worker.run()
        self.assertTrue(stopped_at)
        self.assertLessEqual(stopped_at[0], 30,
                             "GPU reclaimed at %.1fs, after the server's 30s lease expired" % stopped_at[0])


    def test_expired_initial_claim_is_never_started_without_fenced_renewal(self):
        worker = bare_worker(once=True)
        task = {"taskId": "audit-task", "lease": {"attemptId": "old-attempt", "epoch": 1}}
        executor = Mock()
        actions = []

        def request(_url, payload=None, token=None, **_kwargs):
            actions.append(payload)
            if payload["action"] == "status":
                return {"result": {"paused": False}}
            if payload["action"] == "poll" and "attemptId" in payload["payload"]:
                raise HTTPError("http://127.0.0.1/", 409, "lease expired", {}, None)
            return {"result": {"task": task}}

        with patch.object(provider, "request_json", side_effect=request), \
                patch.object(provider.concurrent.futures, "ThreadPoolExecutor", return_value=executor):
            with self.assertRaises(HTTPError):
                worker.run()
        self.assertEqual([entry["action"] for entry in actions], ["status", "poll", "poll", "release"])
        self.assertEqual(actions[2]["payload"], {"capabilities": ["chat", "renter-model", "rental-session"], "attemptId": "old-attempt", "epoch": 1})
        executor.submit.assert_not_called()
        worker.stop_runtime.assert_called()

    def test_initial_renewal_uses_remaining_hard_stop_instead_of_full_lease(self):
        worker = bare_worker(once=True)
        task = {"taskId": "audit-task", "lease": {"attemptId": "old-attempt", "epoch": 1}}
        future = concurrent.futures.Future()
        future.result = Mock(side_effect=TimeoutError("simulated inference still running"))
        executor = Mock()
        executor.submit.return_value = future
        clock = [0.0]
        stopped_at = []
        worker.stop_runtime.side_effect = lambda: stopped_at.append(clock[0])

        def request(_url, payload=None, token=None, **_kwargs):
            if payload["action"] == "status":
                return {"result": {"paused": False}}
            return {"result": {"task": task, "leaseRemainingMs": 4000}}

        with patch.object(provider, "request_json", side_effect=request), \
                patch.object(provider.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(provider.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
                patch.object(provider.concurrent.futures, "ThreadPoolExecutor", return_value=executor):
            with self.assertRaisesRegex(RuntimeError, "Lease renewal not confirmed"):
                worker.run()
        executor.submit.assert_called_once()
        self.assertLessEqual(stopped_at[0], 2.0)

    def test_recovery_waits_for_old_inference_before_starting_another_runtime(self):
        worker = bare_worker()
        task = {"taskId": "audit-task", "lease": {"attemptId": "audit-attempt", "epoch": 1}}
        future = concurrent.futures.Future()
        future.set_running_or_notify_cancel()
        future.result = Mock(side_effect=TimeoutError("inference thread still unwinding"))
        executor = Mock()
        executor.submit.return_value = future
        actions = []
        drains = []
        renewals = []

        def request(_url, payload=None, token=None, **_kwargs):
            actions.append(payload["action"])
            if payload["action"] == "status":
                if future.done():
                    worker.stop = True
                    return {"result": {"paused": True}}
                return {"result": {"paused": False}}
            if payload["action"] == "release":
                return {"result": {"released": True}}
            if "attemptId" in payload["payload"]:
                renewals.append(payload)
                return {"result": {"paused": len(renewals) > 1, "leaseRemainingMs": 30000}}
            return {"result": {"task": task, "leaseRemainingMs": 30000}}

        def sleep(seconds):
            if seconds == 1:
                drains.append(seconds)
                # Runtime startup now belongs to the leased inference worker.
                self.assertEqual(worker.start_runtime.call_count, 0)
                self.assertEqual(actions, ["status", "poll", "poll", "poll", "release"])
                if len(drains) == 2:
                    future.set_result({"raw": "discarded old result"})

        with patch.object(provider, "request_json", side_effect=request), \
                patch.object(provider.time, "monotonic", return_value=0), \
                patch.object(provider.time, "sleep", side_effect=sleep), \
                patch.object(future, "cancel", wraps=future.cancel) as cancel, \
                patch.object(provider.concurrent.futures, "ThreadPoolExecutor", return_value=executor):
            worker.run()
        self.assertEqual(len(drains), 2)
        cancel.assert_called_once()
        self.assertEqual(actions, ["status", "poll", "poll", "poll", "release", "status"])
        executor.submit.assert_called_once()

    def test_slow_trickle_renewal_cannot_defer_cleanup_or_revive_expired_grant(self):
        """Keep each read active beyond the whole lease, with no real GPU needed."""
        worker = bare_worker(once=True)
        task = {"taskId": "audit-task", "lease": {"attemptId": "audit-attempt", "epoch": 1}}
        future = concurrent.futures.Future()
        future.result = Mock(side_effect=TimeoutError("simulated inference still running"))
        executor = Mock()
        executor.submit.return_value = future
        response_started = threading.Event()
        response_finished = threading.Event()
        stopped_while_reading = []
        calls = []
        renewals = []
        worker.stop_runtime.side_effect = lambda: stopped_while_reading.append(
            response_started.is_set() and not response_finished.is_set())

        class Coordinator(BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append(payload["action"])
                if payload["action"] == "poll" and "attemptId" in payload["payload"]:
                    renewals.append(payload)
                if len(renewals) > 1 and payload["action"] == "poll":
                    prefix = b'{"result":'
                    suffix = b'{"leaseRemainingMs":30000}}'
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(prefix) + 30 + len(suffix)))
                    self.end_headers()
                    response_started.set()
                    self.wfile.write(prefix)
                    self.wfile.flush()
                    # Every byte arrives within the socket timeout, but the full
                    # response takes much longer than the 0.3-second test lease.
                    for _ in range(30):
                        threading.Event().wait(0.025)
                        self.wfile.write(b" ")
                        self.wfile.flush()
                    response_finished.set()
                    self.wfile.write(suffix)
                    return
                result = {"paused": False} if payload["action"] == "status" else {"task": task, "leaseRemainingMs": 30000}
                body = json.dumps({"result": result}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Coordinator)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        worker.args.coordinator = "http://127.0.0.1:" + str(server.server_port)
        set_lease = worker._set_lease

        def short_lease(deadline):
            return set_lease(min(deadline, time.monotonic() + 0.3))

        try:
            with patch.object(worker, "_set_lease", side_effect=short_lease), \
                    patch.object(worker, "_sleep", side_effect=lambda _: threading.Event().wait(0.01)), \
                    patch.object(provider.concurrent.futures, "ThreadPoolExecutor", return_value=executor):
                with self.assertRaisesRegex(RuntimeError, "Lease renewal not confirmed"):
                    worker.run()
            self.assertTrue(response_finished.is_set(), "The slow response must finish, not hit an inactivity timeout")
            self.assertTrue(stopped_while_reading[0], "Cleanup must start while the slow response is still being read")
            self.assertEqual(calls, ["status", "poll", "poll", "poll", "release"])
            self.assertIsNone(worker.lease)
            self.assertIsNone(worker._lease_timer)
        finally:
            worker._clear_lease()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_old_watchdog_cannot_reclaim_a_replacement_grant(self):
        worker = bare_worker()
        worker._set_lease(time.monotonic() + 30)
        old_generation = worker._lease_generation
        worker._clear_lease()
        worker._set_lease(time.monotonic() + 30)
        try:
            worker._expire_lease(old_generation)
            worker.stop_runtime.assert_not_called()
            self.assertFalse(worker._lease_expired)
        finally:
            worker._clear_lease()

    def test_revoked_credentials_stop_without_transport_retry(self):
        for code in (401, 403):
            with self.subTest(code=code):
                worker = bare_worker()
                error = HTTPError("http://127.0.0.1/", code, "revoked", {}, None)
                with patch.object(provider, "request_json", side_effect=error) as request, \
                        patch.object(provider.time, "sleep") as sleep:
                    with self.assertRaisesRegex(RuntimeError, "invalid or revoked"):
                        worker.run()
                request.assert_called_once()
                sleep.assert_not_called()
                worker.start_runtime.assert_not_called()
                worker.stop_runtime.assert_called()

    def test_ready_result_is_not_submitted_after_unconfirmed_lease_expires(self):
        worker = bare_worker(once=True)
        task = {"taskId": "audit-task", "lease": {"attemptId": "audit-attempt", "epoch": 1}}
        future = concurrent.futures.Future()
        future.set_result({"raw": "already completed"})
        executor = Mock()
        executor.submit.return_value = future
        clock = [0]
        actions = []

        def request(_url, payload=None, token=None, **_kwargs):
            actions.append(payload["action"])
            if payload["action"] == "status":
                return {"result": {"paused": False}}
            return {"result": {"task": task, "leaseRemainingMs": 30000}}

        def delayed_wakeup(_seconds):
            clock[0] = 26

        with patch.object(provider, "request_json", side_effect=request), \
                patch.object(provider.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(provider.time, "sleep", side_effect=delayed_wakeup), \
                patch.object(provider.concurrent.futures, "ThreadPoolExecutor", return_value=executor):
            with self.assertRaisesRegex(RuntimeError, "Lease renewal not confirmed"):
                worker.run()
        self.assertEqual(actions, ["status", "poll", "poll", "release"])
        worker.stop_runtime.assert_called()


if __name__ == "__main__":
    unittest.main()

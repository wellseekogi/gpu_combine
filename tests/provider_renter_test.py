"""Renter uploads stay bounded data and run only inside the owned, leased runtime."""
import hashlib
import concurrent.futures
import importlib.util
import struct
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("renter_provider", Path(__file__).parents[1] / "provider" / "provider.py")
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


def gguf(template="{{ messages }}\r\n"):
    def text(value):
        raw = value.encode("utf-8")
        return struct.pack("<Q", len(raw)) + raw
    entry = b"" if template is None else text("tokenizer.chat_template") + struct.pack("<I", 8) + text(template)
    return b"GGUF" + struct.pack("<IQQ", 3, 0, int(template is not None)) + entry


class ProviderRenterTests(unittest.TestCase):
    def setUp(self):
        self.payload = gguf()
        self.downloads = []
        suite = self

        class ModelServer(BaseHTTPRequestHandler):
            def do_GET(self):
                suite.downloads.append((self.path, self.headers.get("Authorization"), self.headers.get("X-Relay-Node")))
                self.send_response(200)
                self.send_header("Content-Length", str(len(suite.payload)))
                self.end_headers()
                self.wfile.write(suite.payload)

            def log_message(self, *_):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), ModelServer)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.worker = provider.Provider.__new__(provider.Provider)
        self.worker.args = SimpleNamespace(context=8192, once=True, port=8081, gpu_layers=99,
                                          coordinator="http://127.0.0.1:" + str(self.server.server_port),
                                          pool="pool", node="provider-node", server="local-owned-runtime.exe",
                                          model="original.gguf", template="original.jinja")
        self.worker.contract = {"modelDigest": "a" * 64, "runtime": "b" * 64, "template": "c" * 64}
        self.worker.base = "http://127.0.0.1:8081"
        self.worker.token = "test-provider-token"
        self.worker.stop = False
        self.worker.process = None
        self.worker.lease = time.monotonic() + 30
        self.worker._initialize_guards()
        self.worker.start_runtime = Mock()
        self.worker.stop_runtime = Mock()
        self.artifact = {"id": "artifact-1234567890", "name": "renter.gguf",
                         "digest": hashlib.sha256(self.payload).hexdigest(), "size": len(self.payload)}
        self.task = {"kind": "chat", "taskId": "task", "lease": {"attemptId": "attempt", "epoch": 3},
                     "modelArtifact": self.artifact, "model": {"digest": self.artifact["digest"],
                     "runtime": "b" * 64, "template": None, "context": 4096},
                     "messages": [{"role": "user", "content": "내 모델로 답해줘"}], "maxOutputTokens": 512}

    def tearDown(self):
        self.worker._clear_lease()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_uploaded_model_downloads_with_node_auth_runs_and_is_reclaimed(self):
        paths = []
        original_args = self.worker.args

        def start():
            paths.append(Path(self.worker.args.model))
            self.assertEqual(paths[0].read_bytes(), self.payload)
            self.assertEqual(Path(self.worker.args.template).read_bytes(), b"{{ messages }}\r\n")
            self.assertEqual(self.worker.args.server, "local-owned-runtime.exe")
            self.assertEqual(self.worker.args.context, 4096)
            self.assertEqual(self.worker.stage, "loading")

        self.worker.start_runtime.side_effect = start
        completion = {"choices": [{"message": {"content": "사용자가 올린 모델의 답변"}, "finish_reason": "stop"}]}
        with patch.object(provider, "request_json", side_effect=[{"input_tokens": 20}, completion]):
            result = self.worker.execute_task(self.task)
        self.assertEqual(self.downloads, [("/api/provider/models/artifact-1234567890", "Bearer test-provider-token", "provider-node")])
        self.assertEqual(result["raw"], "사용자가 올린 모델의 답변")
        self.assertEqual(result["modelDigest"], self.artifact["digest"])
        self.assertEqual(result["template"], hashlib.sha256(b"{{ messages }}\r\n").hexdigest())
        self.assertEqual(result["runtime"], "b" * 64)
        self.assertEqual(self.worker.stop_runtime.call_count, 2)
        self.assertFalse(paths[0].parent.exists())
        self.assertIs(self.worker.args, original_args)
        self.assertFalse(hasattr(self.worker, "active_contract"))
        self.assertEqual(self.worker.contract["modelDigest"], "a" * 64)
        self.assertIsNone(self.worker.stage)

    def test_hash_mismatch_never_starts_runtime_and_removes_partial_artifact(self):
        self.artifact["digest"] = "d" * 64
        self.task["model"]["digest"] = "d" * 64
        with patch.object(self.worker, "download_model", wraps=self.worker.download_model) as download:
            with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                self.worker.execute_task(self.task)
        self.worker.start_runtime.assert_not_called()
        self.assertFalse(download.call_args.args[1].parent.exists())
        self.assertEqual(self.worker.last_error_code, "model-download-failed")

    def test_missing_embedded_template_never_starts_runtime(self):
        self.payload = gguf(None)
        self.artifact.update(digest=hashlib.sha256(self.payload).hexdigest(), size=len(self.payload))
        self.task["model"]["digest"] = self.artifact["digest"]
        with self.assertRaisesRegex(RuntimeError, "embedded chat template"):
            self.worker.execute_task(self.task)
        self.worker.start_runtime.assert_not_called()
        self.assertEqual(self.worker.last_error_code, "model-load-failed")

    def test_artifact_ids_cannot_address_a_foreign_host_or_filesystem_path(self):
        for identifier in ["../../secret", "https://other.example/file", "evil?token=value"]:
            self.artifact["id"] = identifier
            with self.subTest(identifier=identifier), patch.object(provider.OPENER, "open") as request:
                with self.assertRaisesRegex(RuntimeError, "artifact is invalid"):
                    self.worker.execute_task(self.task)
                request.assert_not_called()
        self.worker.start_runtime.assert_not_called()

    def test_cancellation_while_downloading_never_loads_the_model(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.headers = {"Content-Length": str(len(self.payload))}

        def partial(_size):
            self.worker._task_cancel.set()
            return self.payload[:12]

        response.read1.side_effect = partial
        with patch.object(provider.OPENER, "open", return_value=response), \
                patch.object(self.worker, "download_model", wraps=self.worker.download_model) as download:
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                self.worker.execute_task(self.task)
        self.worker.start_runtime.assert_not_called()
        self.assertFalse(download.call_args.args[1].parent.exists())

    def test_stale_execution_cannot_launch_after_lease_has_been_cleared(self):
        self.worker._task_cancel.set()
        self.worker._clear_lease()
        with patch.object(provider.subprocess, "Popen") as start:
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                provider.Provider.start_runtime(self.worker)
        start.assert_not_called()

    def test_cancellation_inside_process_launch_reclaims_returned_process(self):
        process = Mock()
        process.poll.return_value = None
        self.worker.stop_runtime = provider.Provider.stop_runtime.__get__(self.worker)

        def launch(*_args, **_kwargs):
            self.worker._task_cancel.set()
            return process

        with patch.object(provider.socket, "socket"), patch.object(provider.subprocess, "Popen", side_effect=launch), \
                patch.object(provider, "request_json") as request:
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                provider.Provider.start_runtime(self.worker)
        process.terminate.assert_called_once()
        request.assert_not_called()
        self.assertIsNone(self.worker.process)

    def test_watchdog_reclaims_loading_process_while_health_request_is_blocked(self):
        process = Mock()
        process.poll.return_value = None
        stopped = threading.Event()
        health_entered = threading.Event()
        release_health = threading.Event()
        process.terminate.side_effect = stopped.set
        self.worker.stop_runtime = provider.Provider.stop_runtime.__get__(self.worker)
        errors = []

        def health(*_args, **_kwargs):
            health_entered.set()
            release_health.wait(2)
            return {}

        def start():
            try:
                provider.Provider.start_runtime(self.worker)
            except RuntimeError as error:
                errors.append(str(error))

        with patch.object(provider.socket, "socket"), patch.object(provider.subprocess, "Popen", return_value=process), \
                patch.object(provider, "request_json", side_effect=health) as request:
            self.worker._set_lease(time.monotonic() + 0.2)
            thread = threading.Thread(target=start)
            try:
                thread.start()
                self.assertTrue(health_entered.wait(1))
                self.assertTrue(stopped.wait(1), "Watchdog must not wait for a slow runtime health response")
                release_health.set()
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())
                self.assertTrue(errors)
                self.assertEqual(request.call_count, 1)
                self.assertIsNone(self.worker.process)
            finally:
                release_health.set()
                thread.join(timeout=2)

    def test_failed_generation_stops_runtime_and_deletes_download(self):
        paths = []
        self.worker.start_runtime.side_effect = lambda: paths.append(Path(self.worker.args.model))
        original_args = self.worker.args
        with patch.object(self.worker, "infer", side_effect=RuntimeError("generation failed")):
            with self.assertRaisesRegex(RuntimeError, "generation failed"):
                self.worker.execute_task(self.task)
        self.assertEqual(self.worker.stop_runtime.call_count, 2)
        self.assertFalse(paths[0].parent.exists())
        self.assertIs(self.worker.args, original_args)
        self.assertEqual(self.worker.last_error_code, "model-inference-failed")

    def test_rental_reuses_loaded_model_for_two_prompts_then_reclaims_it(self):
        rental = {"id": "rental-1234567890", "modelArtifact": self.artifact,
                  "model": self.task["model"], "leaseRemainingMs": 30000}
        self.worker.last_poll_started = time.monotonic()
        original_args = self.worker.args
        self.assertTrue(self.worker._accept_rental(rental))
        self.worker._prepare_rental(rental)
        self.worker.rental_stage = "ready"
        model_path = Path(self.worker.args.model)
        self.assertTrue(model_path.exists())
        response = {"choices": [{"message": {"content": "답변"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 20, "completion_tokens": 3, "total_tokens": 23}}
        task = {**self.task, "rentalId": rental["id"]}
        with patch.object(provider, "request_json", side_effect=[{"input_tokens": 20}, response] * 2):
            self.assertEqual(self.worker.execute_task(task)["usage"], response["usage"])
            self.assertEqual(self.worker.execute_task(task)["usage"], response["usage"])
        self.assertEqual(len(self.downloads), 1)
        self.worker.start_runtime.assert_called_once()
        self.assertEqual(self.worker.stop_runtime.call_count, 1)
        self.worker._close_rental()
        self.assertEqual(self.worker.stop_runtime.call_count, 2)
        self.assertFalse(model_path.parent.exists())
        self.assertIs(self.worker.args, original_args)
        self.assertFalse(hasattr(self.worker, "active_contract"))

    def test_rental_rejects_unbillable_runtime_usage(self):
        rental = {"id": "rental-1234567890", "modelArtifact": self.artifact,
                  "model": self.task["model"], "leaseRemainingMs": 30000}
        self.worker.last_poll_started = time.monotonic()
        self.worker._accept_rental(rental)
        self.worker._prepare_rental(rental)
        self.worker.rental_stage = "ready"
        task = {**self.task, "rentalId": rental["id"]}
        for usage in [None, {"prompt_tokens": 19, "completion_tokens": 3, "total_tokens": 22},
                      {"prompt_tokens": 20, "completion_tokens": 513, "total_tokens": 533},
                      {"prompt_tokens": 20, "completion_tokens": 3, "total_tokens": 24},
                      {"prompt_tokens": 20, "completion_tokens": True, "total_tokens": 21}]:
            with self.subTest(usage=usage), patch.object(provider, "request_json", side_effect=[
                    {"input_tokens": 20}, {"choices": [{"message": {"content": "답변"}, "finish_reason": "stop"}], "usage": usage}]):
                with self.assertRaisesRegex(RuntimeError, "billable token usage"):
                    self.worker.execute_task(task)
        with patch.object(provider, "request_json", side_effect=[
                {"input_tokens": 20}, {"choices": [{"message": {"content": "답변"}, "finish_reason": "stop"}],
                                        "usage": {"prompt_tokens": 20, "completion_tokens": 3, "total_tokens": 23,
                                                  "prompt_tokens_details": {"cached_tokens": 21}}}]):
            with self.assertRaisesRegex(RuntimeError, "cached token usage"):
                self.worker.execute_task(task)
        self.worker._close_rental()

    def test_poll_reclaims_rental_when_server_ends_it(self):
        rental = {"id": "rental-1234567890", "modelArtifact": self.artifact,
                  "model": self.task["model"], "leaseRemainingMs": 30000}
        self.worker.args.once = False
        self.worker.lease = None
        paths = []
        self.worker.start_runtime.side_effect = lambda: paths.append(Path(self.worker.args.model))
        polls = []

        def request(url, payload=None, token=None, **_kwargs):
            action = payload["action"]
            if action == "status":
                return {"result": {"paused": False}}
            self.assertEqual(action, "poll")
            polls.append(payload["payload"])
            if len(polls) == 3:
                self.worker.stop = True
                return {"result": {"task": None}}
            return {"result": {"rental": rental, "task": None}}

        def immediate(fn, *args):
            future = concurrent.futures.Future()
            try:
                future.set_result(fn(*args))
            except BaseException as error:
                future.set_exception(error)
            return future

        executor = Mock()
        executor.submit.side_effect = immediate
        with patch.object(provider, "request_json", side_effect=request), \
                patch.object(provider.concurrent.futures, "ThreadPoolExecutor", return_value=executor), \
                patch.object(provider.time, "sleep"):
            self.worker.run()
        self.assertEqual([poll.get("rentalStage") for poll in polls], [None, "ready", "ready"])
        self.assertEqual(len(self.downloads), 1)
        self.assertFalse(paths[0].parent.exists())
        self.assertIsNone(self.worker.rental_id)

    def test_provider_download_includes_matching_gguf_metadata_parser(self):
        root = Path(__file__).parents[1]
        self.assertEqual((root / "provider/gguf_metadata.py").read_bytes(), (root / "public/gguf_metadata.py").read_bytes())


if __name__ == "__main__":
    unittest.main()

"""Host prompt-cache policy is feature-gated before leasing, without changing GPU KV precision."""
import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

spec = importlib.util.spec_from_file_location("cache_provider", Path(__file__).parents[1] / "provider/provider.py")
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


class ProviderCacheTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.server = Path(self.folder.name) / "selected-runtime"
        self.server.write_bytes(b"synthetic executable placeholder")

    def probe(self, help_text, status=0, timeout=False):
        process = MagicMock()
        process.__enter__.return_value = process
        process.wait.side_effect = [provider.subprocess.TimeoutExpired("help", 5), 0] if timeout else None
        process.wait.return_value = status

        def start(*args, **kwargs):
            kwargs["stdout"].write(help_text)
            return process

        with patch.object(provider.subprocess, "Popen", side_effect=start) as popen:
            result = provider.runtime_cache_options(self.server)
        return result, popen, process

    def test_only_advertised_options_are_enabled_and_help_capture_is_bounded(self):
        supported = b"-cram, --cache-ram N\n--cache-idle-slots, --no-cache-idle-slots\n"
        with patch.dict(provider.os.environ, {"PATH":"safe", "CUDA_VISIBLE_DEVICES":"0", "RELAY_NODE_TOKEN":"secret", "LLAMA_ARG_CACHE_RAM":"8192"}, clear=True):
            flags, popen, _ = self.probe(supported)
        self.assertEqual(flags, ["--cache-ram", "0", "--no-cache-idle-slots"])
        self.assertEqual(popen.call_args.args[0], [str(self.server.resolve()), "--help"])
        self.assertEqual(popen.call_args.kwargs["env"], {"PATH":"safe", "CUDA_VISIBLE_DEVICES":"0"})
        self.assertFalse(popen.call_args.kwargs["shell"])
        self.assertTrue(popen.call_args.kwargs["stdout"].closed)
        for help_text in (b"older server help", b"--cache-ram N", b"--cache-ram-extra --no-cache-idle-slots", supported + b" "*262144):
            with self.subTest(help_text=help_text[:60]):
                self.assertEqual(self.probe(help_text)[0], [])
        self.assertEqual(self.probe(supported, status=1)[0], [])

    def test_timed_out_or_unavailable_help_falls_back_and_reaps_the_helper(self):
        flags, _, process = self.probe(b"--cache-ram --no-cache-idle-slots", timeout=True)
        self.assertEqual(flags, [])
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)
        with patch.object(provider.subprocess, "Popen", side_effect=OSError("unsupported help")):
            self.assertEqual(provider.runtime_cache_options(self.server), [])
        with patch.object(provider.subprocess, "Popen") as popen:
            self.assertEqual(provider.runtime_cache_options(self.server.with_name("missing")), [])
            popen.assert_not_called()

    def worker(self):
        worker = provider.Provider.__new__(provider.Provider)
        worker.args = SimpleNamespace(server=str(self.server), once=False)
        worker.token = "synthetic-token"
        worker.stop = False
        worker.process = None
        worker.contract = {}
        worker._initialize_guards()
        worker.stop_runtime = Mock()
        return worker

    def test_probe_occurs_once_after_unpaused_authentication_and_before_any_poll(self):
        worker = self.worker()
        calls = []

        def api(action, payload):
            calls.append(action)
            self.assertIsNone(worker.lease)
            return {"paused":len(calls)==1} if action == "status" else {}

        def probe(_server):
            calls.append("help")
            self.assertIsNone(worker.lease)
            return ["--cache-ram", "0", "--no-cache-idle-slots"]

        def sleep(_seconds, pending=None):
            if calls.count("poll") == 2:
                worker.stop = True

        worker.api = api
        worker._sleep = sleep
        with patch.object(provider, "runtime_cache_options", side_effect=probe) as help_probe, patch.object(provider.time, "sleep", side_effect=sleep):
            worker.run()
        self.assertEqual(calls, ["status", "status", "help", "poll", "status", "poll"])
        help_probe.assert_called_once_with(str(self.server))

    def test_contract_validation_does_not_execute_and_launch_reuses_selected_flags(self):
        args = SimpleNamespace(server=str(self.server), rental_only=True, port=8081)
        with patch.object(provider, "runtime_cache_options") as probe, patch.object(provider.subprocess, "Popen") as popen:
            provider.Provider(args)
        probe.assert_not_called()
        popen.assert_not_called()
        worker = self.worker()
        worker.args = SimpleNamespace(server=str(self.server),model="model",template="template",context=8192,port=8081,gpu_layers=99)
        worker.base = "http://127.0.0.1:8081"
        worker._runtime_cache_options = ["--cache-ram", "0", "--no-cache-idle-slots"]
        template = "approved template"
        worker.contract = {"template":hashlib.sha256(template.encode()).hexdigest()}
        process = Mock()
        process.poll.return_value = None
        with patch.object(provider.socket, "socket"), patch.object(provider.subprocess, "Popen", return_value=process) as popen, patch.object(provider, "request_json", side_effect=[{}, {"default_generation_settings":{"n_ctx":8192},"total_slots":1,"chat_template":template}]):
            worker.start_runtime()
        command = popen.call_args.args[0]
        self.assertEqual(command[-3:], worker._runtime_cache_options)
        self.assertNotIn("--cache-type-k", command)
        self.assertNotIn("--cache-type-v", command)


if __name__ == "__main__":
    unittest.main()

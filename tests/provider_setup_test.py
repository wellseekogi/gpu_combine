"""Headless validation of the participant GUI's trust and process boundaries."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("provider_setup", Path(__file__).parents[1] / "provider" / "setup_gui.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.files = {}
        for key, content in (("model", b"GGUF test fixture"), ("server", b"local executable fixture"), ("template", "채팅 템플릿".encode())):
            path = root / key
            path.write_bytes(content)
            self.files[key] = str(path)
        self.connection = {"coordinator": "http://127.0.0.1:8788", "pool": "pool-1", "node": "node-1",
                           "token": "secret-sentinel-never-log", "context": 8192}

    def test_connection_import_ignores_executable_paths(self):
        config = setup.connection_config({**self.connection, "server": "malicious.exe", "files": {"model": "other.gguf"}})
        self.assertEqual(config, self.connection)

    def test_connection_pc_name_is_optional_and_validated(self):
        self.assertNotIn("nodeName", setup.connection_config(self.connection))
        self.assertEqual(setup.connection_config({**self.connection, "nodeName": "  새 사용자 PC  "})["nodeName"], "새 사용자 PC")
        for name in (None, "", " ", "a" * 81, "bad\nname", "bad\x7fname", "bad\x85name"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                setup.connection_config({**self.connection, "nodeName": name})

    def test_connection_folder_is_restored_without_storing_credentials(self):
        path = Path(self.temp.name) / "prefs.json"
        folder = Path(self.temp.name) / "Downloads"
        folder.mkdir()
        setup.save_preferences({"connection_folder": str(folder), "token": self.connection["token"]}, path)
        restored, notices = setup.load_preferences(path)
        self.assertEqual(restored, {"connection_folder": str(folder)})
        self.assertEqual(notices, [])
        self.assertNotIn(self.connection["token"], path.read_text(encoding="utf-8"))

    def test_remote_http_and_embedded_credentials_are_rejected(self):
        for address in ("http://relay.example", "https://user:password@relay.example", "https://relay.example?token=a",
                        "https://relay.example#fragment", "file:///relay", "https://relay.example:0", "https://relay.example:bad"):
            with self.subTest(address=address), self.assertRaises(ValueError):
                setup.connection_config({**self.connection, "coordinator": address})
        self.assertEqual(setup.connection_config({**self.connection, "coordinator": "https://relay.example/"})["coordinator"], "https://relay.example")

    def test_web_setup_opens_without_connection_credentials(self):
        self.assertEqual(setup.web_console_url("http://127.0.0.1:8788"), "http://127.0.0.1:8788/#connect-pc")
        self.assertEqual(setup.web_console_url("http://[::1]:8788/"), "http://[::1]:8788/#connect-pc")
        self.assertEqual(setup.web_console_url("https://relay.example/api"), "https://relay.example/#connect-pc")

    def test_web_setup_rejects_unsafe_addresses_and_credentials(self):
        for address in ("http://relay.example", "file:///relay", "javascript:alert(1)",
                        "https://user:password@relay.example", "https://relay.example?token=secret",
                        "https://relay.example#secret", "http://127.0.0.1:0", "https://relay.example:bad",
                        "http://127.0.0.1\\@relay.example", "https://relay.example\n", "", None):
            with self.subTest(address=address), self.assertRaises(ValueError):
                setup.web_console_url(address)

    def test_bom_file_and_size_limit(self):
        path = Path(self.temp.name) / "connection.json"
        path.write_text(json.dumps(self.connection), encoding="utf-8-sig")
        self.assertEqual(setup.read_connection(path), self.connection)
        path.write_bytes(b" " * (setup.MAX_CONFIG_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "너무 큽니다"):
            setup.read_connection(path)

    def test_context_and_tokens_are_validated(self):
        for key, value in (("context", True), ("context", 0), ("context", "8192.0"), ("context", 131073), ("context", 4095),
                           ("token", ""), ("token", "a\nb"), ("node", "")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                setup.connection_config({**self.connection, key: value})

    def test_contract_uses_exact_local_bytes_and_contains_no_connection_secrets(self):
        contract = setup.compute_contract(self.files, 8192)
        self.assertEqual(contract["template"], hashlib.sha256("채팅 템플릿".encode()).hexdigest())
        self.assertEqual(contract["modelDigest"], setup.runtime.digest_file(self.files["model"]))
        self.assertEqual(set(contract), {"version", "context", "modelDigest", "runtime", "template"})

    def test_downloaded_digest_alias_and_full_contract_must_match(self):
        contract = setup.compute_contract(self.files, 8192)
        model = {**contract, "digest": contract["modelDigest"].upper()}
        del model["modelDigest"]
        config = setup.connection_config({**self.connection, "model": model})
        setup.match_contract(contract, config["model"])
        with self.assertRaisesRegex(ValueError, "GGUF"):
            setup.match_contract({**contract, "modelDigest": "0" * 64}, config["model"])
        with self.assertRaisesRegex(ValueError, "컨텍스트"):
            setup.connection_config({**self.connection, "model": {**model, "context": 4096}})
        with self.assertRaises(ValueError):
            setup.connection_config({**self.connection, "model": {"digest": "123"}})

    def test_selected_files_must_exist(self):
        with self.assertRaisesRegex(ValueError, "GGUF"):
            setup.compute_contract({**self.files, "model": str(Path(self.temp.name) / "missing")}, 8192)

    def test_worker_receives_credentials_through_stdin_only(self):
        process = Mock()
        process.poll.return_value = None
        process.stdin = io.StringIO()
        worker = setup.WorkerProcess(queue.Queue())
        with patch.object(setup.subprocess, "Popen", return_value=process) as popen, patch.object(setup, "WindowsJob"), patch.object(setup.threading, "Thread"):
            worker.start(self.connection, self.files, 8081, 99)
        arguments = popen.call_args.args[0]
        self.assertNotIn(self.connection["token"], " ".join(arguments))
        self.assertNotIn(self.connection["token"], repr(popen.call_args.kwargs))
        self.assertFalse(popen.call_args.kwargs["shell"])
        payload = json.loads(process.stdin.getvalue())
        self.assertEqual(payload["connection"]["token"], self.connection["token"])
        self.assertEqual(arguments[-1], "--worker")

    def test_stop_requests_graceful_exit_before_forcing_descendant_cleanup(self):
        process = Mock()
        process.poll.return_value = None
        process.stdin = io.StringIO()
        worker = setup.WorkerProcess(queue.Queue())
        worker.process = process
        job = worker.job = Mock()
        with patch.object(setup.threading, "Thread"):
            worker.stop()
        self.assertEqual(process.stdin.getvalue(), "stop\n")
        process.wait.side_effect = subprocess.TimeoutExpired("worker", 10)
        worker._finish_stop(process, job)
        job.close.assert_called_once()

    def test_failed_job_assignment_never_sends_configuration_or_launches_runtime(self):
        if os.name != "nt":
            self.skipTest("Windows process ownership test")
        process = Mock()
        process.poll.return_value = None
        worker = setup.WorkerProcess(queue.Queue())
        with patch.object(setup.subprocess, "Popen", return_value=process), patch.object(setup, "WindowsJob", side_effect=OSError("job failed")):
            with self.assertRaises(OSError):
                worker.start(self.connection, self.files, 8081, 99)
        process.stdin.write.assert_not_called()
        process.kill.assert_called_once()

    def test_log_stream_redacts_token(self):
        process = Mock()
        process.stdout = io.StringIO("unexpected " + self.connection["token"] + "\n")
        process.stdin = io.StringIO()
        process.wait.return_value = 1
        messages = queue.Queue()
        setup.WorkerProcess(messages)._read(process, self.connection["token"], None)
        kind, line = messages.get_nowait()
        self.assertEqual(kind, "log")
        self.assertNotIn(self.connection["token"], line)
        self.assertIn("숨김", line)
        self.assertEqual(messages.get_nowait(), ("exit", 1))

    def test_preferences_store_only_file_paths_never_connection_credentials(self):
        path = Path(self.temp.name) / "prefs" / "provider-setup.json"
        config_path = Path(self.temp.name) / "connection.json"
        config_path.write_text(json.dumps(self.connection), encoding="utf-8")
        setup.save_preferences({**self.connection, **self.files, "connection_file": str(config_path),
                                "connection": self.connection, "authorization": "secret-sentinel-header"}, path)
        raw = path.read_text(encoding="utf-8")
        saved = json.loads(raw)
        self.assertEqual(set(saved), {"version", "server", "model", "template", "connection_file"})
        self.assertNotIn(self.connection["token"], raw)
        self.assertNotIn(self.connection["coordinator"], raw)
        self.assertNotIn("secret-sentinel-header", raw)
        restored, notices = setup.load_preferences(path)
        self.assertEqual(restored, {**self.files, "connection_file": str(config_path)})
        self.assertEqual(notices, [])
        self.assertEqual(setup.read_connection(restored["connection_file"])["token"], self.connection["token"])

    def test_custom_search_folder_is_restored_as_directory(self):
        path = Path(self.temp.name) / "provider-setup.json"
        folder = Path(self.temp.name) / "models"
        folder.mkdir()
        setup.save_preferences({"search_folder": str(folder), "model": str(folder)}, path)
        restored, notices = setup.load_preferences(path)
        self.assertEqual(restored, {"search_folder": str(folder)})
        self.assertEqual(len(notices), 1)
        folder.rmdir()
        self.assertNotIn("search_folder", setup.load_preferences(path)[0])

    def test_embedded_template_preparation_preserves_exact_bytes(self):
        destination = Path(self.temp.name) / "templates"
        template = "  {{ 안녕하세요 }}\\n\\r\\n"
        with patch.object(setup.gguf_metadata, "read_chat_template", return_value=template):
            target = Path(setup.prepare_model_template("model.gguf", destination))
        self.assertEqual(target.read_bytes(), template.encode("utf-8"))
        self.assertEqual(target.stem, setup.hashlib.sha256(template.encode("utf-8")).hexdigest())
        self.assertEqual(list(destination.glob(".template-*")), [])

    def test_template_failure_or_missing_template_does_not_create_cache(self):
        destination = Path(self.temp.name) / "templates"
        with patch.object(setup.gguf_metadata, "read_chat_template", return_value=None):
            self.assertIsNone(setup.prepare_model_template("model.gguf", destination))
        with patch.object(setup.gguf_metadata, "read_chat_template", side_effect=OSError("model missing")):
            with self.assertRaises(OSError):
                setup.prepare_model_template("model.gguf", destination)
        self.assertFalse(destination.exists())

    def test_template_timeout_returns_and_late_read_does_not_write(self):
        destination = Path(self.temp.name) / "templates"
        released = setup.threading.Event()
        completed = setup.threading.Event()
        def stalled(_path):
            released.wait(2)
            completed.set()
            return "{{ message }}"
        with patch.object(setup.gguf_metadata, "read_chat_template", side_effect=stalled):
            try:
                with self.assertRaisesRegex(ValueError, "WSL"):
                    setup.prepare_model_template("wsl-model.gguf", destination, timeout=0.03)
            finally:
                released.set()
                self.assertTrue(completed.wait(1))
        self.assertFalse(destination.exists())

    def test_preferences_reject_urls_relative_paths_and_embedded_data(self):
        path = Path(self.temp.name) / "provider-setup.json"
        setup.save_preferences({"server": "https://user:password@host/runtime", "model": self.connection,
                                "template": "relative-path", "connection_file": "a\nb", "token": self.connection["token"]}, path)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"version": 1})

    def test_missing_saved_files_are_skipped_with_reselection_notice(self):
        path = Path(self.temp.name) / "provider-setup.json"
        setup.save_preferences(self.files, path)
        Path(self.files["model"]).unlink()
        restored, notices = setup.load_preferences(path)
        self.assertNotIn("model", restored)
        self.assertEqual(restored["server"], self.files["server"])
        self.assertEqual(len(notices), 1)
        self.assertIn("GGUF", notices[0])
        self.assertIn("다시 선택", notices[0])

    def test_missing_corrupt_and_oversized_preferences_do_not_block_setup(self):
        path = Path(self.temp.name) / "provider-setup.json"
        self.assertEqual(setup.load_preferences(path), ({}, []))
        for content in ("invalid json", "[]", '{"version":2}', " " * (setup.MAX_CONFIG_BYTES + 1)):
            with self.subTest(content=content[:20]):
                path.write_text(content, encoding="utf-8")
                restored, notices = setup.load_preferences(path)
                self.assertEqual(restored, {})
                self.assertTrue(notices)

    def test_preferences_write_failure_keeps_previous_selection_intact(self):
        path = Path(self.temp.name) / "provider-setup.json"
        setup.save_preferences(self.files, path)
        previous = path.read_bytes()
        with patch.object(Path, "replace", side_effect=OSError("read-only preferences")):
            with self.assertRaises(OSError):
                setup.save_preferences({}, path)
        self.assertEqual(path.read_bytes(), previous)
        self.assertEqual(list(path.parent.glob(".provider-setup-*.tmp")), [])

    def test_preferences_access_error_returns_reselection_guidance(self):
        with patch.object(Path, "open", side_effect=PermissionError("access denied")):
            restored, notices = setup.load_preferences(Path(self.temp.name) / "provider-setup.json")
        self.assertEqual(restored, {})
        self.assertTrue(notices)
        self.assertNotIn("access denied", notices[0])

    def test_real_gui_worker_has_process_ownership_and_fails_closed(self):
        contract = setup.compute_contract(self.files, 8192)
        contract["modelDigest"] = "0" * 64
        messages = queue.Queue()
        worker = setup.WorkerProcess(messages)
        worker.start({**self.connection, "model": contract}, self.files, 8081, 99)
        output = []
        try:
            while True:
                kind, value = messages.get(timeout=10)
                if kind == "exit":
                    self.assertEqual(value, 1)
                    break
                output.append(value)
        finally:
            if worker.running:
                worker.stop()
                worker.process.wait(timeout=15)
        self.assertTrue(any("서비스에 등록된 설정과 다릅니다" in line for line in output))
        self.assertFalse(worker.running)
        if os.name == "nt":
            self.assertIsNone(worker.job.handle)

    @unittest.skipUnless(os.name == "nt", "Windows JobObject lifecycle")
    def test_windows_job_cleanup_reclaims_worker_and_child(self):
        import ctypes
        from ctypes import wintypes
        script = "import sys,subprocess,time;sys.stdin.readline();p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);print(p.pid,flush=True);time.sleep(60)"
        process = subprocess.Popen([sys.executable, "-u", "-c", script], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        job = None
        child_handle = None
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        try:
            job = setup.WindowsJob(process)
            process.stdin.write("start\n")
            process.stdin.flush()
            child_pid = int(process.stdout.readline())
            child_handle = kernel.OpenProcess(0x00100000, False, child_pid)
            self.assertTrue(child_handle)
            job.close()
            process.wait(timeout=5)
            self.assertEqual(kernel.WaitForSingleObject(child_handle, 5000), 0)
        finally:
            if job:
                job.close()
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()
            if child_handle:
                kernel.CloseHandle(child_handle)

    def test_real_worker_rejects_wrong_files_before_connecting(self):
        contract = setup.compute_contract(self.files, 8192)
        contract["modelDigest"] = "0" * 64
        payload = {"connection": {**self.connection, "model": contract}, "files": self.files, "port": 8081, "gpu_layers": 99}
        result = subprocess.run([sys.executable, str(Path(setup.__file__)), "--worker"],
                                input=json.dumps(payload) + "\n", capture_output=True, text=True,
                                encoding="utf-8", timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn("서비스에 등록된 설정과 다릅니다", result.stdout)
        self.assertNotIn("서비스에 연결하는 중", result.stdout)
        self.assertNotIn(self.connection["token"], result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

"""Isolated Tk integration coverage for discovering local connection files.

Every connection and preference file lives in a temporary directory. The worker
is a mock: these tests never launch a provider, browser, or GPU runtime.
"""
from contextlib import ExitStack
import gc
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

try:
    import tkinter as tk
except ImportError:
    tk = None


spec = importlib.util.spec_from_file_location(
    "relay_connection_gui_under_test", Path(__file__).parents[1] / "provider" / "setup_gui.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


@unittest.skipIf(tk is None, "Tk is unavailable")
class ConnectionGUITests(unittest.TestCase):
    def setUp(self):
        # Tk variables in callback cycles must be collected on the main thread,
        # never by an allocation in the next mocked discovery worker.
        if gc.isenabled():
            gc.disable()
            self.addCleanup(gc.enable)
        self.addCleanup(gc.collect)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.downloads = self.directory / "Downloads"
        self.downloads.mkdir()
        self.preferences = self.directory / "preferences" / "provider-setup.json"
        self.worker = Mock(running=False)
        self.root = None
        self.completed_scans = 0
        self.last_scan_at = 0

    def write_connection(self, name="relay-provider-test.json", *, node="test-node", directory=None):
        path = (directory or self.downloads) / name
        payload = {"coordinator": "http://127.0.0.1:8788", "pool": "test-pool", "node": node,
                   "token": "test-secret-never-persist-" + node, "context": 4096}
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path, payload

    def widget(self, name):
        pending = [self.root]
        while pending:
            widget = pending.pop()
            if widget.winfo_name() == name:
                return widget
            pending.extend(widget.winfo_children())
        self.fail("GUI widget was not found: " + name)

    def value(self, name):
        return self.widget("setting_" + name).get()

    def replace(self, name, value):
        widget = self.widget("setting_" + name)
        widget.delete(0, "end")
        widget.insert(0, value)

    def scan_finished(self, minimum=1):
        # GUI receives worker messages every 120 ms. Let a complete receive
        # cycle pass after the bounded scanner returns before inspecting it.
        return self.completed_scans >= minimum and time.monotonic() - self.last_scan_at >= 0.2

    def run_gui(self, scenario, *, initial_config=None, result_filter=None):
        try:
            self.root = tk.Tk()
            self.root.withdraw()
            try:
                self.root.attributes("-alpha", 0)
            except tk.TclError:
                pass
        except tk.TclError as exc:
            self.skipTest("Tk display is unavailable: " + str(exc))
        errors = []
        finished = False
        generator = scenario()
        predicate = None
        original_discover = setup.connection_discovery.discover_connections

        def discover(*_args, **_kwargs):
            result = original_discover(setup.read_connection, roots=[self.downloads])
            if result_filter is not None:
                result = result_filter(result, self.completed_scans + 1)
            self.completed_scans += 1
            self.last_scan_at = time.monotonic()
            return result

        def shutdown():
            nonlocal finished
            if finished:
                return
            finished = True
            try:
                for callback in self.root.tk.call("after", "info"):
                    self.root.after_cancel(callback)
                self.root.destroy()
            except tk.TclError:
                pass

        def callback_error(kind, error, traceback):
            errors.append((kind, error, traceback))
            shutdown()

        def tick():
            nonlocal predicate
            try:
                if predicate is None or predicate():
                    predicate = next(generator)
                self.root.after(20, tick)
            except StopIteration:
                shutdown()
            except BaseException:
                errors.append(sys.exc_info())
                shutdown()

        def deadline():
            errors.append((AssertionError, AssertionError("Connection GUI scenario exceeded 6 seconds"), None))
            shutdown()

        self.root.report_callback_exception = callback_error
        with ExitStack() as stack:
            stack.enter_context(patch.object(tk, "Tk", return_value=self.root))
            stack.enter_context(patch.object(setup, "preferences_path", return_value=self.preferences))
            stack.enter_context(patch.object(setup, "WorkerProcess", return_value=self.worker))
            stack.enter_context(patch.object(setup.model_discovery, "discover_models",
                                             return_value={"models": [], "roots": [], "warnings": []}))
            stack.enter_context(patch.object(setup.runtime_discovery, "discover_runtimes",
                                             return_value={"runtimes": [], "roots": [], "warnings": []}))
            stack.enter_context(patch.object(setup.connection_discovery, "discover_connections", side_effect=discover))
            stack.enter_context(patch("tkinter.messagebox.showerror", side_effect=AssertionError("Unexpected GUI error dialog")))
            stack.enter_context(patch.object(setup.webbrowser, "open", side_effect=AssertionError("Unexpected browser launch")))
            self.root.after(10, tick)
            self.root.after(6000, deadline)
            try:
                setup.gui_main(initial_config=initial_config)
            finally:
                shutdown()
        self.worker.start.assert_not_called()
        self.worker.stop.assert_not_called()
        if errors:
            _, error, traceback = errors[0]
            raise error.with_traceback(traceback)

    def assert_preferences_contain_only_paths(self, expected_path, token):
        saved = self.preferences.read_text(encoding="utf-8")
        payload = json.loads(saved)
        # Windows runner temp paths can use either long or DOS 8.3 names.
        self.assertEqual(Path(payload["connection_file"]).resolve(), expected_path.resolve())
        self.assertLessEqual(set(payload), {"version", *setup.PREFERENCE_PATHS})
        self.assertNotIn(token, saved)
        self.assertNotIn('"token"', saved)
        self.assertNotIn('"coordinator"', saved)

    def test_single_connection_is_imported_automatically_without_starting_worker(self):
        path, config = self.write_connection()

        def scenario():
            yield lambda: self.scan_finished() and self.value("node") == config["node"]
            self.assertEqual(self.value("token"), config["token"])
            self.assertEqual(self.value("coordinator"), config["coordinator"])
            self.assert_preferences_contain_only_paths(path, config["token"])
            self.assertNotIn(config["token"], str(self.widget("connection_candidates").cget("values")))
        self.run_gui(scenario)

    def test_file_downloaded_after_open_is_detected_on_refresh(self):
        def scenario():
            yield self.scan_finished
            self.assertEqual(self.value("node"), "")
            path, config = self.write_connection()
            previous = self.completed_scans
            self.widget("refresh_connection").invoke()
            yield lambda: self.scan_finished(previous + 1) and self.value("node") == config["node"]
            self.assertEqual(self.value("token"), config["token"])
            self.assert_preferences_contain_only_paths(path, config["token"])
        self.run_gui(scenario)

    def test_file_downloaded_after_open_is_detected_by_periodic_watcher(self):
        def scenario():
            yield self.scan_finished
            self.assertEqual(self.value("node"), "")
            path, config = self.write_connection(node="arrived-after-open")
            previous = self.completed_scans
            # Do not touch refresh: the scheduled watcher must see this file.
            yield lambda: self.scan_finished(previous + 1) and self.value("node") == config["node"]
            self.assertEqual(self.value("token"), config["token"])
            self.assert_preferences_contain_only_paths(path, config["token"])
        self.run_gui(scenario)

    def test_multiple_connections_require_explicit_selection(self):
        candidates = [self.write_connection("relay-provider-first.json", node="first"),
                      self.write_connection("relay-provider-second.json", node="second")]

        def scenario():
            yield self.scan_finished
            self.assertEqual(self.value("node"), "")
            self.assertEqual(self.value("token"), "")
            combo = self.widget("connection_candidates")
            self.assertEqual(len(combo.cget("values")), 2)
            combo.current(1)
            combo.event_generate("<<ComboboxSelected>>")
            self.widget("use_connection").invoke()
            yield lambda: bool(self.value("node"))
            path, config = next(candidate for candidate in candidates if candidate[1]["node"] == self.value("node"))
            self.assertEqual(self.value("token"), config["token"])
            self.assert_preferences_contain_only_paths(path, config["token"])
        self.run_gui(scenario)

    def test_restored_connection_is_not_replaced_by_new_download(self):
        original, config = self.write_connection("existing.json", node="existing", directory=self.directory)
        self.write_connection(node="new-download")
        setup.save_preferences({"connection_file": str(original)}, self.preferences)

        def scenario():
            yield self.scan_finished
            self.assertEqual(self.value("node"), config["node"])
            self.assertEqual(self.value("token"), config["token"])
            self.assert_preferences_contain_only_paths(original, config["token"])
        self.run_gui(scenario)

    def test_manual_credentials_are_not_overwritten_by_discovery(self):
        self.write_connection()

        def scenario():
            self.replace("coordinator", "http://localhost:8788")
            self.replace("node", "manually-entered-node")
            self.replace("token", "manual-secret")
            yield self.scan_finished
            self.assertEqual(self.value("coordinator"), "http://localhost:8788")
            self.assertEqual(self.value("node"), "manually-entered-node")
            self.assertEqual(self.value("token"), "manual-secret")
            if self.preferences.exists():
                self.assertNotIn("manual-secret", self.preferences.read_text(encoding="utf-8"))
        self.run_gui(scenario)

    def test_context_edit_alone_does_not_block_automatic_connection_import(self):
        path, config = self.write_connection()

        def scenario():
            self.replace("context", "16384")
            yield lambda: self.scan_finished() and self.value("node") == config["node"]
            self.assertEqual(self.value("context"), str(config["context"]))
            self.assertEqual(self.value("token"), config["token"])
            self.assert_preferences_contain_only_paths(path, config["token"])
        self.run_gui(scenario)

    def assert_unavailable_saved_connection_requires_explicit_selection(self, *, corrupt):
        original = self.directory / "previous-connection.json"
        if corrupt:
            original.write_text("invalid JSON", encoding="utf-8")
        path, config = self.write_connection(node="unrelated-download")
        setup.save_preferences({"connection_file": str(original)}, self.preferences)

        def scenario():
            yield self.scan_finished
            self.assertEqual(self.value("node"), "")
            self.assertEqual(self.value("token"), "")
            self.assert_preferences_contain_only_paths(original, config["token"])
            picker = self.widget("connection_candidates")
            self.assertEqual(len(picker.cget("values")), 1)
            picker.current(0)
            picker.event_generate("<<ComboboxSelected>>")
            self.widget("use_connection").invoke()
            yield lambda: self.value("node") == config["node"]
            self.assertEqual(self.value("token"), config["token"])
            self.assert_preferences_contain_only_paths(path, config["token"])
        self.run_gui(scenario)

    def test_missing_saved_connection_does_not_auto_switch_to_unrelated_download(self):
        self.assert_unavailable_saved_connection_requires_explicit_selection(corrupt=False)

    def test_corrupt_saved_connection_does_not_auto_switch_to_unrelated_download(self):
        self.assert_unavailable_saved_connection_requires_explicit_selection(corrupt=True)

    def test_incomplete_scan_blocks_auto_import_and_periodic_retry_until_refresh(self):
        path, config = self.write_connection()

        def incomplete_first(result, number):
            return {**result, "complete": number != 1}

        def scenario():
            yield self.scan_finished
            self.assertEqual(self.value("node"), "")
            self.assertEqual(self.value("token"), "")
            finished_at = time.monotonic()
            yield lambda: time.monotonic() - finished_at >= 3.2
            self.assertEqual(self.completed_scans, 1, "Incomplete scan retried without user action")
            self.assertEqual(self.value("node"), "")
            self.widget("refresh_connection").invoke()
            yield lambda: self.scan_finished(2) and self.value("node") == config["node"]
            self.assertEqual(self.value("token"), config["token"])
            self.assert_preferences_contain_only_paths(path, config["token"])
        self.run_gui(scenario, result_filter=incomplete_first)

    def test_stalled_saved_connection_times_out_without_freezing_or_late_overwrite(self):
        original, _ = self.write_connection("previous.json", node="previous", directory=self.directory)
        selected, config = self.write_connection(node="explicit-recovery")
        setup.save_preferences({"connection_file": str(original)}, self.preferences)
        release = threading.Event()
        entered = threading.Event()
        returned = threading.Event()
        heartbeat = threading.Event()
        read_started = []
        real_read = setup.read_connection
        real_bounded = setup.bounded_read
        timeout = 0.15

        def stalled_read(path):
            if Path(path) != original:
                return real_read(path)
            read_started.append(time.monotonic())
            entered.set()
            try:
                release.wait(5)
                return real_read(path)
            finally:
                returned.set()

        def short_bounded_read(read, **_kwargs):
            return real_bounded(read, timeout=timeout)

        def scenario():
            yield entered.is_set
            self.root.after(0, heartbeat.set)
            yield heartbeat.is_set
            self.assertLess(time.monotonic() - read_started[0], timeout,
                            "Tk callbacks were blocked until the saved read timed out")
            self.assertFalse(returned.is_set())
            yield self.scan_finished
            self.assertEqual(self.value("node"), "")
            self.assertEqual(self.value("token"), "")
            self.assert_preferences_contain_only_paths(original, config["token"])
            picker = self.widget("connection_candidates")
            self.assertEqual(len(picker.cget("values")), 1)
            picker.current(0)
            picker.event_generate("<<ComboboxSelected>>")
            self.widget("use_connection").invoke()
            yield lambda: self.value("node") == config["node"]
            release.set()
            yield returned.is_set
            recovered_at = time.monotonic()
            yield lambda: time.monotonic() - recovered_at >= 0.2
            self.assertEqual(self.value("node"), config["node"])
            self.assertEqual(self.value("token"), config["token"])
            self.assert_preferences_contain_only_paths(selected, config["token"])

        try:
            with patch.object(setup, "read_connection", side_effect=stalled_read), \
                    patch.object(setup, "bounded_read", side_effect=short_bounded_read):
                self.run_gui(scenario)
        finally:
            release.set()
            if entered.is_set():
                self.assertTrue(returned.wait(1), "Stalled test reader did not exit during cleanup")

    def test_running_worker_prevents_connection_selection(self):
        self.write_connection("relay-provider-first.json", node="first")
        self.write_connection("relay-provider-second.json", node="second")

        def scenario():
            yield self.scan_finished
            self.worker.running = True
            combo = self.widget("connection_candidates")
            combo.current(1)
            combo.event_generate("<<ComboboxSelected>>")
            self.widget("use_connection").invoke()
            self.assertEqual(self.value("node"), "")
            self.assertEqual(self.value("token"), "")
            self.worker.running = False
        self.run_gui(scenario)


if __name__ == "__main__":
    unittest.main()

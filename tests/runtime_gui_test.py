"""Hidden Tk integration coverage for automatic llama-server selection.

Discovery and the provider worker are mocked. Every executable and preference
path belongs to a temporary directory, and no GPU process or browser is started.
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
    "relay_runtime_gui_under_test", Path(__file__).parents[1] / "provider" / "setup_gui.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


@unittest.skipIf(tk is None, "Tk is unavailable")
class RuntimeGUITests(unittest.TestCase):
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
        self.preferences = self.directory / "preferences" / "provider-setup.json"
        self.worker = Mock(running=False)
        self.worker_messages = None
        self.root = None
        self.completed_scans = 0
        self.last_scan_at = 0

    def runtime_candidate(self, folder="llama-cpp"):
        directory = self.directory / folder
        directory.mkdir(exist_ok=True)
        path = directory / "llama-server.exe"
        path.write_bytes(b"mock-runtime-never-executed")
        return {"name": path.name, "path": str(path.resolve()), "source": "test folder",
                "root": str(directory.resolve()), "size_bytes": path.stat().st_size}

    def widget(self, name):
        pending = [self.root]
        while pending:
            widget = pending.pop()
            if widget.winfo_name() == name:
                return widget
            pending.extend(widget.winfo_children())
        self.fail("GUI widget was not found: " + name)

    def server(self):
        return self.widget("setting_server").get()

    def summary(self):
        label = self.widget("runtime_summary")
        variable = label.cget("textvariable")
        return str(self.root.getvar(variable)) if variable else str(label.cget("text"))

    def scan_finished(self, minimum=1):
        # Discovery results reach Tk through its 120 ms message polling loop.
        return self.completed_scans >= minimum and time.monotonic() - self.last_scan_at >= 0.2

    def saved_server(self):
        return json.loads(self.preferences.read_text(encoding="utf-8")).get("server", "")

    def choose(self, index):
        picker = self.widget("runtime_candidates")
        picker.current(index)
        picker.event_generate("<<ComboboxSelected>>")

    def run_gui(self, scenario, *, candidates=(), discover_result=None, initial_config=None):
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

        def create_worker(messages):
            self.worker_messages = messages
            return self.worker

        def discover(*_args, **_kwargs):
            try:
                if discover_result:
                    return discover_result(self.completed_scans + 1)
                return {"runtimes": list(candidates), "roots": [], "warnings": []}
            finally:
                self.completed_scans += 1
                self.last_scan_at = time.monotonic()

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
            errors.append((AssertionError, AssertionError("Runtime GUI scenario exceeded 6 seconds"), None))
            shutdown()

        self.root.report_callback_exception = callback_error
        with ExitStack() as stack:
            stack.enter_context(patch.object(tk, "Tk", return_value=self.root))
            stack.enter_context(patch.object(setup, "preferences_path", return_value=self.preferences))
            stack.enter_context(patch.object(setup, "WorkerProcess", side_effect=create_worker))
            stack.enter_context(patch.object(setup.model_discovery, "discover_models",
                                             return_value={"models": [], "roots": [], "warnings": []}))
            stack.enter_context(patch.object(setup.connection_discovery, "discover_connections",
                                             return_value={"connections": [], "roots": [], "warnings": [], "complete": True}))
            stack.enter_context(patch.object(setup.runtime_discovery, "discover_runtimes", side_effect=discover))
            stack.enter_context(patch("tkinter.filedialog.askopenfilename",
                                     side_effect=AssertionError("Runtime choice must not open a file dialog")))
            stack.enter_context(patch("tkinter.filedialog.askdirectory",
                                     side_effect=AssertionError("Runtime choice must not open a folder dialog")))
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

    def test_single_runtime_is_selected_and_saved_without_starting_worker(self):
        candidate = self.runtime_candidate()

        def scenario():
            yield lambda: self.scan_finished() and self.server() == candidate["path"]
            self.assertEqual(self.saved_server(), candidate["path"])
            self.assertTrue(self.widget("setting_server").instate(["readonly"]))
            self.assertTrue(self.widget("runtime_candidates").instate(["readonly"]))
        self.run_gui(scenario, candidates=[candidate])

    def test_multiple_runtimes_can_be_chosen_from_list_without_file_dialog(self):
        candidates = [self.runtime_candidate("cpu"), self.runtime_candidate("cuda")]

        def scenario():
            yield self.scan_finished
            self.assertEqual(self.server(), "")
            picker = self.widget("runtime_candidates")
            self.assertEqual(len(picker.cget("values")), 2)
            self.choose(1)
            yield lambda: bool(self.server())
            self.assertEqual(self.server(), candidates[1]["path"])
            self.assertEqual(self.saved_server(), self.server())
        self.run_gui(scenario, candidates=candidates)

    def test_saved_runtime_is_preserved_when_another_runtime_is_found(self):
        saved = self.runtime_candidate("saved")
        other = self.runtime_candidate("new-download")
        setup.save_preferences({"server": saved["path"]}, self.preferences)

        def scenario():
            yield self.scan_finished
            self.assertEqual(self.server(), saved["path"])
            self.assertEqual(self.saved_server(), saved["path"])
        self.run_gui(scenario, candidates=[other])

    def assert_failed_preferences_require_explicit_runtime_selection(self, candidate, original):
        def scenario():
            yield self.scan_finished
            self.assertEqual(self.server(), "")
            self.assertEqual(self.preferences.read_bytes(), original)
            self.assertTrue(self.widget("runtime_candidates").instate(["readonly"]))
            self.assertEqual(len(self.widget("runtime_candidates").cget("values")), 1)
            # A new scan must not turn a failed restore into permission to
            # replace the previous settings with the only discovered runtime.
            self.widget("refresh_runtime").invoke()
            yield lambda: self.scan_finished(2)
            self.assertEqual(self.server(), "")
            self.assertEqual(self.preferences.read_bytes(), original)
            self.choose(0)
            yield lambda: self.server() == candidate["path"]
            self.assertEqual(self.saved_server(), candidate["path"])
        self.run_gui(scenario, candidates=[candidate])

    def test_malformed_preferences_are_not_replaced_by_automatic_runtime_selection(self):
        candidate = self.runtime_candidate("new-download")
        original = b'{"version": 1, "server": "previous-choice", invalid-json'
        self.preferences.parent.mkdir(parents=True)
        self.preferences.write_bytes(original)
        self.assert_failed_preferences_require_explicit_runtime_selection(candidate, original)

    def test_preferences_read_timeout_does_not_replace_saved_runtime_automatically(self):
        saved = self.runtime_candidate("saved")
        candidate = self.runtime_candidate("new-download")
        setup.save_preferences({"server": saved["path"]}, self.preferences)
        original = self.preferences.read_bytes()
        with patch.object(setup, "load_preferences", side_effect=TimeoutError("Mock settings read timed out")):
            self.assert_failed_preferences_require_explicit_runtime_selection(candidate, original)

    def test_refresh_preserves_explicit_choice_when_candidate_order_changes(self):
        candidates = [self.runtime_candidate("cpu"), self.runtime_candidate("cuda")]
        chosen = []

        def results(number):
            return {"runtimes": candidates if number == 1 else list(reversed(candidates)),
                    "roots": [], "warnings": []}

        def scenario():
            yield self.scan_finished
            self.choose(1)
            yield lambda: bool(self.server())
            chosen.append(self.server())
            self.widget("refresh_runtime").invoke()
            yield lambda: self.scan_finished(2)
            self.assertEqual(self.server(), chosen[0])
            self.assertEqual(self.saved_server(), chosen[0])
            # A refresh must preserve the selected path, not its old row index.
            picker = self.widget("runtime_candidates")
            self.assertGreaterEqual(picker.current(), 0)
            self.choose(picker.current())
            self.assertEqual(self.server(), chosen[0])
        self.run_gui(scenario, discover_result=results)

    def test_no_runtime_leaves_path_empty_and_explains_next_step(self):
        def scenario():
            yield self.scan_finished
            self.assertEqual(self.server(), "")
            self.assertEqual(len(self.widget("runtime_candidates").cget("values")), 0)
            summary = self.summary()
            self.assertTrue(summary.strip())
            self.assertTrue(any(term in summary for term in ("찾지", "없", "설치", "폴더")), summary)
            self.assertFalse(self.widget("refresh_runtime").instate(["disabled"]))
        self.run_gui(scenario)

    def test_scanner_error_recovers_after_refresh(self):
        candidate = self.runtime_candidate()

        def results(number):
            if number == 1:
                raise OSError("Mock runtime folder is unavailable")
            return {"runtimes": [candidate], "roots": [], "warnings": []}

        def scenario():
            yield self.scan_finished
            self.assertEqual(self.server(), "")
            self.assertTrue(self.summary().strip())
            self.assertFalse(self.widget("refresh_runtime").instate(["disabled"]))
            self.widget("refresh_runtime").invoke()
            yield lambda: self.scan_finished(2) and self.server() == candidate["path"]
            self.assertEqual(self.saved_server(), candidate["path"])
        self.run_gui(scenario, discover_result=results)

    def test_running_worker_prevents_list_selection(self):
        candidates = [self.runtime_candidate("cpu"), self.runtime_candidate("cuda")]

        def scenario():
            yield self.scan_finished
            self.worker.running = True
            try:
                self.choose(1)
                self.assertEqual(self.server(), "")
                if self.preferences.exists():
                    self.assertEqual(self.saved_server(), "")
            finally:
                self.worker.running = False
        self.run_gui(scenario, candidates=candidates)

    def test_single_runtime_waits_until_busy_connection_restore_finishes(self):
        candidate = self.runtime_candidate()
        connection = self.directory / "connection.json"
        connection.write_text("{}", encoding="utf-8")
        entered = threading.Event()
        release = threading.Event()
        returned = threading.Event()

        def read_connection(_path):
            entered.set()
            try:
                if not release.wait(4):
                    raise TimeoutError("Test did not release connection restore")
                return {"coordinator": "http://127.0.0.1:8788", "pool": "test-pool",
                        "node": "test-node", "token": "test-token", "context": 4096}
            finally:
                returned.set()

        def scenario():
            yield lambda: entered.is_set() and self.scan_finished()
            self.assertFalse(returned.is_set())
            self.assertEqual(self.server(), "", "Busy setup must defer automatic runtime selection")
            self.assertTrue(self.widget("runtime_candidates").instate(["disabled"]))
            release.set()
            yield lambda: self.server() == candidate["path"]
            self.assertEqual(self.saved_server(), candidate["path"])
            self.assertTrue(self.widget("runtime_candidates").instate(["readonly"]))

        try:
            with patch.object(setup, "read_connection", side_effect=read_connection):
                self.run_gui(scenario, candidates=[candidate], initial_config=str(connection))
        finally:
            release.set()
            if entered.is_set():
                self.assertTrue(returned.wait(1), "Mock connection restore did not exit during cleanup")

    def test_slow_scan_keeps_ui_responsive_and_does_not_select_while_worker_runs(self):
        candidate = self.runtime_candidate()
        entered = threading.Event()
        release = threading.Event()
        returned = threading.Event()
        heartbeat = threading.Event()

        def results(_number):
            entered.set()
            try:
                if not release.wait(4):
                    raise TimeoutError("Test did not release the runtime scan")
                return {"runtimes": [candidate], "roots": [], "warnings": []}
            finally:
                returned.set()

        def scenario():
            yield entered.is_set
            self.root.after(0, heartbeat.set)
            yield heartbeat.is_set
            self.assertFalse(returned.is_set(), "Tk must remain responsive while the scanner is pending")
            self.worker.running = True
            release.set()
            yield self.scan_finished
            self.assertEqual(self.server(), "")
            self.worker.running = False
            self.worker_messages.put(("exit", 0))
            yield lambda: not self.widget("refresh_runtime").instate(["disabled"])
            self.widget("refresh_runtime").invoke()
            yield lambda: self.scan_finished(2) and self.server() == candidate["path"]
            self.assertEqual(self.saved_server(), candidate["path"])

        try:
            self.run_gui(scenario, discover_result=results)
        finally:
            self.worker.running = False
            release.set()
            if entered.is_set():
                self.assertTrue(returned.wait(1), "Mock runtime scanner did not exit during cleanup")


if __name__ == "__main__":
    unittest.main()

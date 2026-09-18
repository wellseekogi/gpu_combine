import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("runtime_discovery", Path(__file__).parents[1] / "provider/runtime_discovery.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def executable(self, relative=None, data=b"synthetic executable; never run"):
        path = self.root / (relative or module.NATIVE_NAME)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o755)
        return path

    def scan(self, **kwargs):
        return module.discover_runtimes(roots=[self.root], **kwargs)

    def test_nested_native_executable_and_metadata(self):
        path = self.executable("llama.cpp/build/bin/Release/" + module.NATIVE_NAME)
        result = self.scan()
        self.assertEqual(len(result["runtimes"]), 1)
        found = result["runtimes"][0]
        self.assertEqual(found["path"], str(path.resolve()))
        self.assertEqual(found["size_bytes"], path.stat().st_size)
        self.assertEqual(found["source"], "지정 폴더")
        self.assertEqual(found["root"], str(self.root))
        self.assertFalse(result["warnings"])

    def test_ignores_wrong_native_name_empty_file_and_archives(self):
        self.executable("empty/" + module.NATIVE_NAME, b"")
        for filename in ("server.exe", "llama-server.cmd", "llama-server.exe.zip", "llama-server-old.exe",
                         "llama-server" if os.name == "nt" else "llama-server.exe"):
            self.executable(filename)
        self.assertEqual(self.scan()["runtimes"], [])

    @unittest.skipIf(os.name == "nt", "Unix permission behavior")
    def test_unix_requires_executable_permission(self):
        path = self.executable()
        path.chmod(0o644)
        self.assertEqual(self.scan()["runtimes"], [])

    def test_overlapping_roots_are_deduplicated(self):
        path = self.executable("build/bin/" + module.NATIVE_NAME)
        result = module.discover_runtimes(roots=[self.root, path.parent, self.root / "build/../build"])
        self.assertEqual([item["path"] for item in result["runtimes"]], [str(path.resolve())])

    def test_symlinked_directories_are_not_walked_and_file_aliases_are_deduplicated(self):
        path = self.executable("actual/" + module.NATIVE_NAME)
        try:
            (self.root / "alias-dir").symlink_to(path.parent, target_is_directory=True)
            (self.root / module.NATIVE_NAME).symlink_to(path)
        except (OSError, NotImplementedError):
            self.skipTest("Symlink creation unavailable")
        found = self.scan()["runtimes"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["path"], str(path.resolve()))

    def test_depth_and_entry_bounds_report_partial_search(self):
        self.executable("deep/nested/" + module.NATIVE_NAME)
        self.assertEqual(self.scan(max_depth=0)["runtimes"], [])
        self.assertTrue(any("깊이" in value for value in self.scan(max_depth=0)["warnings"]))
        result = self.scan(max_entries=1)
        self.assertEqual(result["runtimes"], [])
        self.assertTrue(any("항목" in value for value in result["warnings"]))

    def test_cancelled_scan_returns_without_work(self):
        self.executable()
        cancellation = threading.Event()
        cancellation.set()
        result = self.scan(cancel_event=cancellation)
        self.assertEqual(result["runtimes"], [])
        self.assertTrue(any("중단" in value for value in result["warnings"]))

    def test_stalled_filesystem_returns_within_deadline_and_snapshot_is_detached(self):
        self.executable()
        release = threading.Event()
        entered = threading.Event()
        original = module.os.scandir

        def stalled(path):
            entered.set()
            release.wait(2)
            return original(path)

        try:
            with patch.object(module.os, "scandir", stalled):
                start = time.monotonic()
                result = self.scan(max_seconds=0.06)
                elapsed = time.monotonic() - start
            self.assertTrue(entered.is_set())
            self.assertLess(elapsed, 0.5)
            self.assertEqual(result["runtimes"], [])
            self.assertTrue(any("시간 제한" in value for value in result["warnings"]))
        finally:
            release.set()

    def test_path_exact_lookup_is_prioritized_without_execution(self):
        path = self.executable("on-path/" + module.NATIVE_NAME)
        self.executable("on-path/nested/" + module.NATIVE_NAME)
        with patch.dict(os.environ, {"PATH": str(path.parent), "LLAMA_SERVER": "", "LLAMA_CPP_DIR": ""}), \
                patch.object(module._Scan, "defaults"):
            result = module.discover_runtimes()
        self.assertEqual([item["path"] for item in result["runtimes"]], [str(path.resolve())])
        self.assertEqual(result["runtimes"][0]["source"], "PATH")

    def test_environment_and_explicit_roots(self):
        path = self.executable("configured/" + module.NATIVE_NAME)
        other = self.executable("cpp/build/bin/" + module.NATIVE_NAME)
        with patch.dict(os.environ, {"PATH": "", "LLAMA_SERVER": '"' + str(path) + '"', "LLAMA_CPP_DIR": str(self.root / "cpp")}), \
                patch.object(module._Scan, "defaults"):
            result = module.discover_runtimes()
            isolated = module.discover_runtimes(roots=[])
        self.assertEqual([item["path"] for item in result["runtimes"]], [str(path.resolve()), str(other.resolve())])
        self.assertEqual(isolated["runtimes"], [])

    def test_known_package_detection_ignores_unrelated_folders(self):
        found = self.executable("Downloads/llama-b999-bin-win-cuda/" + module.NATIVE_NAME)
        self.executable("Downloads/unrelated/" + module.NATIVE_NAME)
        scan = module._Scan(1000, 6, None)
        scan.package_base(self.root / "Downloads", "다운로드", include_tools=False)
        self.assertEqual([item["path"] for item in scan.snapshot()["runtimes"]], [str(found.resolve())])

    def test_project_managed_relay_runtime_cache_is_discovered(self):
        path = self.executable(".relay/runtimes/llama-b999-cuda12.4/" + module.NATIVE_NAME)
        scan = module._Scan(1000, 6, None)
        scan.package_base(self.root, "프로젝트")
        found = scan.snapshot()["runtimes"]
        self.assertEqual([item["path"] for item in found], [str(path.resolve())])
        self.assertEqual(found[0]["source"], "Relay 런타임")

    def test_shallow_managed_projects_find_arbitrary_project_names_only(self):
        path = self.executable("arbitrary-project/.relay/runtimes/llama-b999-cuda12.4/" + module.NATIVE_NAME)
        legacy = self.executable("another-project/.relay/runtime/bin/" + module.NATIVE_NAME)
        self.executable("unrelated/" + module.NATIVE_NAME)
        self.executable("container/nested-project/.relay/runtimes/" + module.NATIVE_NAME)
        scan = module._Scan(1000, 6, None)
        with patch.object(module.os, "scandir", wraps=os.scandir) as listing:
            scan.managed_projects(self.root)
        found = scan.snapshot()["runtimes"]
        self.assertEqual({item["path"] for item in found}, {str(path.resolve()), str(legacy.resolve())})
        self.assertTrue(all(item["source"] == "Relay 런타임" for item in found))
        visited = {Path(call.args[0]) for call in listing.call_args_list}
        self.assertNotIn(self.root / "unrelated", visited)
        self.assertNotIn(self.root / "container", visited)
        self.assertNotIn(self.root / "container/nested-project", visited)

    def test_managed_projects_reject_reparse_marker_directory(self):
        self.executable("linked-project/.relay/runtimes/" + module.NATIVE_NAME)
        safe = self.executable("safe-project/.relay/runtimes/" + module.NATIVE_NAME)
        marker = self.root / "linked-project/.relay"
        original_lstat = module.Path.lstat

        def metadata(path, *args, **kwargs):
            if path == marker:
                return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
            return original_lstat(path, *args, **kwargs)

        scan = module._Scan(1000, 6, None)
        with patch.object(module.Path, "lstat", metadata), \
                patch.object(module.os, "scandir", wraps=os.scandir) as listing:
            scan.managed_projects(self.root)
        self.assertEqual([item["path"] for item in scan.snapshot()["runtimes"]], [str(safe.resolve())])
        visited = {Path(call.args[0]) for call in listing.call_args_list}
        self.assertFalse(any(path == marker or marker in path.parents for path in visited))

    def test_windows_defaults_find_drive_project_from_separate_downloaded_helper(self):
        drive = self.root / "drive"
        home = drive / "Users/operator"
        helper = home / "Downloads/relay-pc-setup"
        helper.mkdir(parents=True)
        path = self.executable("drive/custom-server/.relay/runtimes/llama-b999/" + module.NATIVE_NAME)
        self.executable("drive/unrelated/" + module.NATIVE_NAME)
        self.executable("drive/container/nested-server/.relay/runtimes/" + module.NATIVE_NAME)
        scan = module._Scan(1000, 6, None)
        original_managed_projects = scan.managed_projects
        original_package_base = scan.package_base
        original_children = scan.children

        # Keep defaults() real, while mapping physical drive probes to the fixture
        # and preventing unrelated default locations from reading the host system.
        def fixture_packages(base, *args, **kwargs):
            if Path(base).is_relative_to(self.root):
                return original_package_base(base, *args, **kwargs)

        def fixture_children(base):
            return original_children(base) if Path(base).is_relative_to(self.root) else []

        windows_os = SimpleNamespace(name="nt", environ={}, path=os.path, scandir=os.scandir)
        with patch.object(module, "os", windows_os), \
                patch.object(module, "__file__", str(helper / "provider/runtime_discovery.py")), \
                patch.object(module.Path, "home", return_value=home), \
                patch.object(module.Path, "cwd", return_value=helper), \
                patch.object(scan, "package_base", side_effect=fixture_packages), \
                patch.object(scan, "children", side_effect=fixture_children), \
                patch.object(scan, "managed_projects", side_effect=lambda base: original_managed_projects(drive)) as probe:
            scan.defaults()
        self.assertTrue(probe.called)
        self.assertEqual([item["path"] for item in scan.snapshot()["runtimes"]], [str(path.resolve())])
        self.assertEqual(scan.snapshot()["runtimes"][0]["source"], "Relay 런타임")

    def test_drive_root_llama_extract_is_discovered_without_walking_other_folders(self):
        path = self.executable("llama-b999-bin-win-cuda/" + module.NATIVE_NAME)
        self.executable("unrelated/nested/" + module.NATIVE_NAME)
        scan = module._Scan(1000, 6, None)
        scan.managed_projects(self.root)
        self.assertEqual([item["path"] for item in scan.snapshot()["runtimes"]], [str(path.resolve())])

    @unittest.skipUnless(os.name == "nt", "Windows local-drive discovery")
    def test_defaults_visit_fixed_drives_beyond_the_project_drive(self):
        scan = module._Scan(1000, 6, None)
        project = Path("C:/Downloads/relay-pc-setup/provider/runtime_discovery.py")
        drives = [Path("C:/"), Path("D:/")]
        with patch.object(module, "__file__", str(project)), \
                patch.object(module.Path, "home", return_value=Path("C:/Users/test")), \
                patch.object(module.Path, "cwd", return_value=project.parent), \
                patch.object(module, "_windows_fixed_drives", return_value=drives), \
                patch.object(scan, "package_base"), patch.object(scan, "children", return_value=[]), \
                patch.object(scan, "managed_projects") as managed:
            scan.defaults()
        self.assertIn(((Path("D:/"),), {}), managed.call_args_list)

    @unittest.skipUnless(os.name == "nt", "Windows local-drive discovery")
    def test_drive_enumeration_excludes_network_and_removable_drives(self):
        kernel = Mock()
        kernel.GetLogicalDrives.return_value = sum(1 << position for position in (2, 3, 4, 5))
        kernel.GetDriveTypeW.side_effect = lambda path: {"C:\\": 3, "D:\\": 3, "E:\\": 2, "F:\\": 4}[path]
        with patch("ctypes.WinDLL", return_value=kernel):
            self.assertEqual(module._windows_fixed_drives(), [Path("C:/"), Path("D:/")])

    def test_windows_reparse_directories_are_not_traversed(self):
        class ReparseMetadata:
            st_mode = 0o040755
            st_file_attributes = 0x400

        with patch.object(module.Path, "lstat", return_value=ReparseMetadata()), patch.object(module.os, "scandir") as listing:
            result = self.scan()
        listing.assert_not_called()
        self.assertEqual(result["runtimes"], [])

    def test_extra_configured_file_precedes_recursive_scan(self):
        first = self.executable("first/" + module.NATIVE_NAME)
        self.executable("other/" + module.NATIVE_NAME)
        result = module.discover_runtimes(roots=[self.root], extra_roots=[first])
        self.assertEqual(result["runtimes"][0]["path"], str(first.resolve()))
        self.assertEqual(len(result["runtimes"]), 2)

    def test_refuses_whole_drive(self):
        with patch.object(module.os, "scandir") as listing:
            result = module.discover_runtimes(roots=[Path(self.root.anchor)])
        listing.assert_not_called()
        self.assertTrue(any("드라이브 전체" in value for value in result["warnings"]))

    def test_invalid_limits(self):
        for kwargs in ({"max_entries": 0}, {"max_depth": -1}, {"max_seconds": 0},
                       {"max_seconds": float("nan")}, {"max_entries": True}, {"max_depth": True}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.scan(**kwargs)


if __name__ == "__main__":
    unittest.main()

import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("connection_discovery", Path(__file__).parents[1] / "provider/connection_discovery.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def read_connection(path):
    with open(path, "rb") as source:
        raw = source.read(module.MAX_CONFIG_BYTES + 1)
    if len(raw) > module.MAX_CONFIG_BYTES:
        raise ValueError("too large")
    value = json.loads(raw)
    if not isinstance(value, dict) or not all(value.get(key) for key in ("coordinator", "pool", "node", "token")):
        raise ValueError("invalid connection")
    # Mirrors the real validator: download content cannot select executables.
    return {key: value[key] for key in ("coordinator", "pool", "node", "token", "context")}


class ConnectionDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = {"coordinator": "https://relay.example.test", "pool": "local-owner",
                       "node": "node-one", "token": "test-secret-alpha", "context": 8192}

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, name="relay-provider-private.json", config=None, folder=None):
        path = (folder or self.root) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.config if config is None else config), encoding="utf-8")
        return path

    def scan(self, reader=read_connection, **kwargs):
        return module.discover_connections(reader, roots=[self.root], **kwargs)

    def test_legacy_duplicate_and_new_names_deduplicate_exact_config(self):
        for name in ("relay-provider-private.json", "relay-provider-private (1).json",
                     "relay-provider-private-1.json", "relay-provider-node_abc-123.json",
                     "RELAY-PROVIDER-NODE (2).JSON"):
            self.file(name)
        result = self.scan()
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["connections"]), 1)
        self.assertEqual(result["connections"][0]["config"], self.config)
        self.assertRegex(result["connections"][0]["fingerprint"], r"^[a-f0-9]{64}$")

    def test_changed_token_and_other_config_remain_distinct(self):
        self.file("relay-provider-a.json")
        self.file("relay-provider-b.json", {**self.config, "token": "test-secret-beta"})
        self.file("relay-provider-c.json", {**self.config, "context": 16384})
        result = self.scan()
        self.assertEqual(len(result["connections"]), 3)
        self.assertEqual(len({entry["fingerprint"] for entry in result["connections"]}), 3)
        self.assertTrue(result["complete"])

    def test_canonical_fingerprint_ignores_key_order_and_json_whitespace(self):
        original = self.file("relay-provider-a.json")
        second = self.root / "relay-provider-b.json"
        second.write_text(json.dumps(dict(reversed(list(self.config.items()))), indent=4))
        result = self.scan()
        self.assertEqual(len(result["connections"]), 1)
        self.assertEqual(result["connections"][0]["path"], str(original))

    def test_scope_is_shallow_and_only_recognized_final_files_are_read(self):
        self.file()
        for name in ("private.json", "relay-provider-private.json.crdownload",
                     "relay-provider-private.json.part", "relay-provider-private.tmp",
                     "relay-provider-.json", "relay-provider-unsafe!.json"):
            self.file(name)
        self.file(folder=self.root / "nested")
        calls = []
        def reader(path):
            calls.append(path)
            return read_connection(path)
        result = self.scan(reader)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(result["connections"]), 1)

    def test_known_file_can_have_any_name_without_scanning_its_parent(self):
        selected = self.file("my-connection.json", folder=self.root / "selected")
        self.file("relay-provider-other.json", {**self.config, "node": "other-node"}, folder=selected.parent)
        calls = []
        def reader(path):
            calls.append(path)
            return read_connection(path)
        result = self.scan(reader, known_paths=selected)
        self.assertTrue(result["complete"])
        self.assertEqual(calls, [selected])
        self.assertEqual(result["connections"][0]["path"], str(selected))
        self.assertEqual(result["roots"], [str(self.root)])

    def test_known_file_is_read_once_when_repeated_or_in_a_search_root(self):
        selected = self.file()
        calls = []
        def reader(path):
            calls.append(path)
            return read_connection(path)
        result = self.scan(reader, known_paths=[str(selected), selected], max_candidates=1)
        self.assertTrue(result["complete"])
        self.assertEqual(calls, [selected])
        self.assertEqual(len(result["connections"]), 1)

    def test_known_files_precede_roots_and_share_the_candidate_limit(self):
        selected = self.file("saved-connection.json", folder=self.root / "selected")
        self.file(config={**self.config, "node": "other-node"})
        result = self.scan(known_paths=[selected], max_candidates=1)
        self.assertFalse(result["complete"])
        self.assertEqual(len(result["connections"]), 1)
        self.assertEqual(result["connections"][0]["path"], str(selected))

    def test_known_file_config_is_deduplicated_with_downloaded_copy(self):
        selected = self.file("saved-connection.json", folder=self.root / "selected")
        self.file()
        result = self.scan(known_paths=[selected])
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["connections"]), 1)
        self.assertEqual(result["connections"][0]["config"], self.config)

    def test_missing_known_file_warns_without_blocking_current_downloads(self):
        self.file()
        result = self.scan(known_paths=[self.root / "old-connection.json"])
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["connections"]), 1)
        self.assertTrue(result["warnings"])

    def test_known_files_keep_size_and_validation_limits(self):
        selected = self.root / "big-saved-connection.json"
        selected.write_bytes(b"x" * (module.MAX_CONFIG_BYTES + 1))
        malformed = self.root / "broken-saved-connection.json"
        malformed.write_text("invalid json")
        calls = []
        def reader(path):
            calls.append(path)
            return read_connection(path)
        result = self.scan(reader, known_paths=[selected, malformed])
        self.assertTrue(result["complete"])
        self.assertEqual(result["connections"], [])
        self.assertEqual(calls, [malformed])
        self.assertTrue(result["warnings"])

    def test_disappearing_known_file_during_validation_is_incomplete(self):
        selected = self.file("saved-connection.json")
        def removed(path):
            config = read_connection(path)
            path.unlink()
            return config
        result = self.scan(removed, known_paths=[selected])
        self.assertFalse(result["complete"])
        self.assertEqual(result["connections"], [])

    def test_known_file_count_is_bounded_even_for_iterators(self):
        def unending_paths():
            while True:
                yield self.root / "saved-connection.json"
        with self.assertRaises(ValueError):
            self.scan(known_paths=unending_paths())

    def test_oversized_and_malformed_files_are_skipped_without_callback_for_oversize(self):
        self.file()
        (self.root / "relay-provider-big.json").write_bytes(b"x" * (module.MAX_CONFIG_BYTES + 1))
        (self.root / "relay-provider-bad.json").write_text("invalid json")
        calls = []
        def reader(path):
            calls.append(path.name)
            return read_connection(path)
        result = self.scan(reader)
        self.assertNotIn("relay-provider-big.json", calls)
        self.assertEqual(len(result["connections"]), 1)
        self.assertTrue(result["complete"])
        self.assertTrue(result["warnings"])

    def test_symlink_files_are_not_followed(self):
        original = self.file("not-a-candidate.json")
        link = self.root / "relay-provider-link.json"
        try:
            link.symlink_to(original)
        except OSError:
            self.skipTest("OS does not permit symbolic links")
        for options in ({}, {"known_paths": [link]}):
            with self.subTest(options=options):
                calls = []
                result = self.scan(lambda path: calls.append(path), **options)
                self.assertEqual(calls, [])
                self.assertEqual(result["connections"], [])
                self.assertTrue(result["complete"])

    def test_config_fields_are_validated_not_used_as_local_paths(self):
        self.file(config={**self.config, "server": "do-not-run.exe", "model": "arbitrary-path"})
        result = self.scan()
        self.assertNotIn("server", result["connections"][0]["config"])
        self.assertNotIn("model", result["connections"][0]["config"])

    def test_changed_file_during_validation_is_not_imported(self):
        path = self.file()
        def changing(candidate):
            result = read_connection(candidate)
            candidate.write_text(json.dumps({**result, "node": "changed-during-read"}))
            return result
        result = self.scan(changing)
        self.assertEqual(result["connections"], [])
        self.assertFalse(result["complete"])
        self.assertTrue(result["warnings"])
        self.assertTrue(path.exists())

    def test_changed_invalid_file_also_marks_search_incomplete(self):
        self.file()
        def changing(candidate):
            candidate.write_text(json.dumps({**self.config, "node": "changed-invalid-read"}))
            raise ValueError("private validation detail")
        result = self.scan(changing)
        self.assertEqual(result["connections"], [])
        self.assertFalse(result["complete"])

    def test_inaccessible_file_is_partial_without_secret_diagnostic(self):
        self.file()
        def denied(_path):
            raise PermissionError("test-secret-alpha private detail")
        result = self.scan(denied)
        self.assertFalse(result["complete"])
        self.assertNotIn("test-secret-alpha", " ".join(result["warnings"]))

    def test_validation_and_unexpected_errors_never_leak_secrets(self):
        self.file()
        for error in (ValueError, RuntimeError):
            def invalid(_path):
                raise error("test-secret-alpha test-secret-beta")
            result = self.scan(invalid)
            self.assertNotIn("test-secret", " ".join(result["warnings"]))
            self.assertEqual(result["connections"], [])

    def test_inaccessible_root_is_partial_and_other_roots_still_work(self):
        good = self.root / "good"
        self.file(folder=good)
        bad = self.root / "bad"
        actual = module.os.scandir
        def scan(path):
            if Path(path) == bad:
                raise PermissionError("private error detail")
            return actual(path)
        with patch.object(module.os, "scandir", side_effect=scan):
            result = module.discover_connections(read_connection, roots=[bad, good])
        self.assertEqual(len(result["connections"]), 1)
        self.assertFalse(result["complete"])
        self.assertNotIn("private error detail", " ".join(result["warnings"]))

    def test_missing_explicit_root_is_partial(self):
        result = module.discover_connections(read_connection, roots=[self.root / "missing"])
        self.assertFalse(result["complete"])

    def test_candidate_and_entry_limits_return_partial(self):
        self.file("relay-provider-a.json")
        self.file("relay-provider-b.json", {**self.config, "node": "node-two"})
        for limits in ({"max_candidates": 1}, {"max_entries": 1}):
            result = self.scan(**limits)
            self.assertFalse(result["complete"])
            self.assertEqual(len(result["connections"]), 1)
            self.assertTrue(result["warnings"])

    def test_explicit_extra_root_precedes_default_and_duplicate_roots(self):
        selected = self.root / "selected"
        self.file(folder=selected)
        defaults = self.root / "defaults"
        for number in range(4):
            self.file(f"noise-{number}.txt", folder=defaults)
        with patch.object(module, "default_download_roots", return_value={"roots": [defaults], "warnings": [], "complete": True}):
            result = module.discover_connections(read_connection, extra_roots=[selected, selected], max_entries=2)
        self.assertEqual(len(result["connections"]), 1)
        self.assertEqual(result["roots"][0], str(selected))
        self.assertEqual(result["roots"].count(str(selected)), 1)
        self.assertFalse(result["complete"])

    def test_timeout_returns_partial_without_waiting_for_blocked_reader(self):
        self.file()
        release = threading.Event()
        entered = threading.Event()
        def blocked(_path):
            entered.set()
            release.wait(2)
            return self.config
        try:
            started = time.monotonic()
            result = self.scan(blocked, max_seconds=0.05)
            self.assertTrue(entered.is_set())
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertFalse(result["complete"])
            self.assertEqual(result["connections"], [])
        finally:
            release.set()

    def test_known_file_timeout_and_cancellation_return_partial(self):
        selected = self.file("saved-connection.json")
        release = threading.Event()
        entered = threading.Event()
        def blocked(_path):
            entered.set()
            release.wait(2)
            return self.config
        try:
            started = time.monotonic()
            result = self.scan(blocked, known_paths=[selected], max_seconds=0.05)
            self.assertTrue(entered.is_set())
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertFalse(result["complete"])
            self.assertEqual(result["connections"], [])
        finally:
            release.set()
        cancelled = threading.Event()
        cancelled.set()
        calls = []
        result = self.scan(lambda path: calls.append(path), known_paths=[selected], cancel_event=cancelled)
        self.assertEqual(calls, [])
        self.assertFalse(result["complete"])
        self.assertEqual(result["connections"], [])

    def test_pre_cancelled_search_is_incomplete(self):
        event = threading.Event()
        event.set()
        result = self.scan(cancel_event=event)
        self.assertFalse(result["complete"])
        self.assertEqual(result["connections"], [])

    def test_defaults_follow_each_user_home(self):
        for name in ("alice", "bob"):
            home = self.root / name
            self.file(folder=home / "Downloads")
            with patch.object(module.Path, "home", return_value=home):
                with patch.object(module.sys, "platform", "darwin"):
                    result = module.discover_connections(read_connection)
            self.assertEqual(result["roots"], [str(home / "Downloads")])
            self.assertEqual(len(result["connections"]), 1)
            self.assertTrue(result["complete"])

    def test_windows_known_folder_redirect_is_searched_before_home_fallback(self):
        home = self.root / "user"
        redirected = self.root / "redirected-downloads"
        self.file(folder=redirected)
        with patch.object(module.Path, "home", return_value=home):
            with patch.object(module.sys, "platform", "win32"):
                with patch.object(module, "_windows_downloads", return_value=redirected) as lookup:
                    result = module.discover_connections(read_connection)
        lookup.assert_called_once_with()
        self.assertEqual(result["roots"], [str(redirected), str(home / "Downloads")])
        self.assertEqual(len(result["connections"]), 1)
        self.assertTrue(result["complete"])

    def test_failed_known_folder_lookup_keeps_fallback_but_marks_partial(self):
        home = self.root / "user"
        self.file(folder=home / "Downloads")
        with patch.object(module.Path, "home", return_value=home):
            with patch.object(module.sys, "platform", "win32"):
                with patch.object(module, "_windows_downloads", side_effect=OSError("private lookup detail")):
                    result = module.discover_connections(read_connection)
        self.assertEqual(len(result["connections"]), 1)
        self.assertFalse(result["complete"])
        self.assertNotIn("private lookup detail", " ".join(result["warnings"]))

    def test_xdg_download_directory_home_substitution_and_config_override(self):
        home = self.root / "linux-user"
        settings = self.root / "xdg-config"
        settings.mkdir()
        (settings / "user-dirs.dirs").write_text('XDG_DOWNLOAD_DIR="$HOME/받은 파일"\n', encoding="utf-8")
        self.file(folder=home / "받은 파일")
        with patch.object(module.Path, "home", return_value=home):
            with patch.object(module.sys, "platform", "linux"):
                with patch.dict(module.os.environ, {"XDG_CONFIG_HOME": str(settings)}, clear=True):
                    result = module.discover_connections(read_connection)
        self.assertEqual(result["roots"][0], str(home / "받은 파일"))
        self.assertEqual(len(result["connections"]), 1)
        self.assertTrue(result["complete"])

    def test_xdg_unsupported_expansion_and_oversize_are_not_evaluated(self):
        home = self.root / "user"
        settings = home / ".config"
        settings.mkdir(parents=True)
        path = settings / "user-dirs.dirs"
        for text in ('XDG_DOWNLOAD_DIR="$(arbitrary-command)"',
                     'XDG_DOWNLOAD_DIR="$OTHER/Downloads"',
                     'XDG_DOWNLOAD_DIR="`arbitrary-command`"',
                     'x' * (module.MAX_XDG_BYTES + 1)):
            path.write_text(text)
            with patch.object(module.Path, "home", return_value=home):
                with patch.object(module.sys, "platform", "linux"):
                    with patch.dict(module.os.environ, {}, clear=True):
                        result = module.discover_connections(read_connection)
            self.assertFalse(result["complete"])
            self.assertEqual(result["roots"], [str(home / "Downloads")])

    def test_invalid_public_limits_are_rejected(self):
        for limits in ({"max_entries": 0}, {"max_candidates": 0}, {"max_seconds": float("nan")}, {"max_entries": True}):
            with self.assertRaises(ValueError):
                self.scan(**limits)


if __name__ == "__main__":
    unittest.main()

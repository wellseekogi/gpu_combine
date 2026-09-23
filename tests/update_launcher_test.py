import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request
import zipfile


spec = importlib.util.spec_from_file_location("update_launcher", Path(__file__).parents[1] / "provider/update_launcher.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CONFIG = {"schema": 1, "repository": "wellseekogi/gpu_combine", "release_tag_prefix": "provider-v",
          "manifest_asset": "relay-provider-manifest.json", "archive_asset": "relay-provider.zip"}
API = "https://api.github.com/repos/" + CONFIG["repository"]


def encoded(value):
    return json.dumps(value, sort_keys=True).encode("utf-8")


def fixture(version):
    files = {"provider/setup_gui.py": b"# fixture GUI is never launched\n",
             "provider/update_launcher.py": b"# fixture updater is never launched\n",
             "provider/update-config.json": encoded(CONFIG), "provider/version.json": encoded({"version": version}),
             "START-PROVIDER.cmd": b"@echo off\n"}
    manifest = {"schema": 1, "version": version, "repository": CONFIG["repository"],
                "tag": "provider-v" + version, "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    return files, manifest


def zipped(files, manifest, extras=()):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
        archive.writestr("provider-manifest.json", encoded(manifest))
        for name, data in extras:
            archive.writestr(name, data)
    return output.getvalue()


def external_manifest(manifest, archive):
    result = copy.deepcopy(manifest)
    result["archive"] = {"name": CONFIG["archive_asset"], "size": len(archive), "sha256": hashlib.sha256(archive).hexdigest()}
    return result


def release(version="0.4.0"):
    return {"tag_name": "provider-v" + version, "draft": False, "prerelease": False,
            "assets": [{"name": CONFIG["manifest_asset"], "url": API + "/releases/assets/1"},
                       {"name": CONFIG["archive_asset"], "url": API + "/releases/assets/2"}]}


class UpdateLauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bundle = self.root / "bundle"
        self.cache = self.root / "cache"
        self.write_bundle(self.bundle, "0.3.0")

    def tearDown(self):
        self.tmp.cleanup()

    def write_bundle(self, target, version):
        files, manifest = fixture(version)
        for name, data in files.items():
            path = target.joinpath(*name.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (target / "provider-manifest.json").write_bytes(encoded(manifest))
        return manifest

    def network(self, version="0.4.0", archive=None, manifest=None, releases=None):
        files, standard = fixture(version)
        manifest = manifest or standard
        archive = archive if archive is not None else zipped(files, manifest)
        external = external_manifest(manifest, archive)
        calls = []

        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            if "/releases?" in url:
                return encoded(releases if releases is not None else [release(version)])
            if url.endswith("/1"):
                return encoded(external)
            if url.endswith("/2"):
                return archive
            self.fail("Unexpected URL: " + url)

        return fetch, calls, external

    def update(self, **kwargs):
        return module.update_and_select(self.bundle, self.cache, **kwargs)

    def test_success_installs_verified_new_version_and_atomic_pointer(self):
        fetch, calls, _ = self.network()
        result = self.update(fetch=fetch)
        self.assertTrue(result["updated"])
        self.assertEqual(result["version"], "0.4.0")
        self.assertEqual(result["source"], "cache")
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(call[1]["token"] is None for call in calls))
        pointer = json.loads((self.cache / "current.json").read_text())
        self.assertEqual(pointer["current"]["version"], "0.4.0")
        self.assertEqual(Path(result["root"]), self.cache / pointer["current"]["directory"])
        self.assertEqual(module._verify_local(Path(result["root"]), CONFIG)["version"], "0.4.0")
        self.assertFalse(list(self.cache.glob(".install-*")))
        self.assertEqual(json.loads((self.bundle / "provider/version.json").read_text())["version"], "0.3.0")

    def test_offline_falls_back_to_bundle_or_cached_version(self):
        def offline(*args, **kwargs):
            raise URLError("offline secret transport detail")

        result = self.update(fetch=offline)
        self.assertEqual(result["source"], "bundled")
        self.assertTrue(result["warnings"])
        self.assertNotIn("secret", str(result))
        fetch, _, _ = self.network()
        installed = self.update(fetch=fetch)
        result = self.update(fetch=offline)
        self.assertEqual(result["root"], installed["root"])
        self.assertFalse(result["updated"])

    def test_numeric_versions_and_release_channel_filter(self):
        self.write_bundle(self.bundle, "0.9.0")
        releases = [release("0.9.1"), release("0.10.0"), release("99.0.0")]
        releases[-1]["prerelease"] = True
        releases.extend([dict(release("100.0.0"), draft=True), dict(release("200.0.0"), tag_name="other-v200.0.0")])
        fetch, _, _ = self.network("0.10.0", releases=releases)
        self.assertEqual(self.update(fetch=fetch)["version"], "0.10.0")

    def test_same_or_lower_release_does_not_download_archive(self):
        for version in ("0.3.0", "0.2.0"):
            fetch, calls, _ = self.network(version)
            result = self.update(fetch=fetch)
            self.assertFalse(result["updated"])
            self.assertEqual(result["version"], "0.3.0")
            self.assertEqual(len(calls), 1)

    def test_newer_bundle_wins_over_old_cache(self):
        fetch, _, _ = self.network("0.4.0")
        self.update(fetch=fetch)
        self.write_bundle(self.bundle, "0.5.0")
        result = self.update(check_updates=False)
        self.assertEqual(result["version"], "0.5.0")
        self.assertEqual(result["source"], "bundled")

    def test_corrupt_current_recovers_previous_and_never_prunes_versions(self):
        first = self.update(fetch=self.network("0.4.0")[0])
        second = self.update(fetch=self.network("0.5.0")[0])
        (Path(second["root"]) / "provider/setup_gui.py").write_bytes(b"corrupted")
        result = self.update(check_updates=False)
        self.assertEqual(result["root"], first["root"])
        self.assertTrue(Path(second["root"]).exists())
        self.assertEqual(len(list((self.cache / "versions").iterdir())), 2)
        fetch, calls, _ = self.network("0.4.5")
        result = self.update(fetch=fetch)
        self.assertEqual(result["version"], "0.4.0")
        self.assertEqual(len(calls), 1)
        self.assertTrue(any("낮아" in warning for warning in result["warnings"]))

    def test_corrupt_same_release_can_be_repaired_into_new_directory(self):
        fetch, _, _ = self.network()
        first = self.update(fetch=fetch)
        (Path(first["root"]) / "provider/setup_gui.py").write_bytes(b"corrupted")
        second = self.update(fetch=fetch)
        self.assertEqual(second["version"], "0.4.0")
        self.assertTrue(second["updated"])
        self.assertNotEqual(first["root"], second["root"])

    def test_missing_package_manifest_fails_but_checkout_can_run_dev_mode(self):
        (self.bundle / "provider-manifest.json").unlink()
        with self.assertRaises(module.UpdateError):
            self.update(check_updates=False)
        (self.bundle / ".git").mkdir()
        result = self.update(fetch=lambda *a, **k: self.fail("Developer checkout requested network"))
        self.assertEqual(result["source"], "development")

    def test_tampered_bundle_without_good_cache_is_not_launched(self):
        (self.bundle / "provider/setup_gui.py").write_bytes(b"modified")
        with self.assertRaises(module.UpdateError):
            self.update(check_updates=False)

    def test_corrupt_pointer_is_not_followed(self):
        self.cache.mkdir()
        (self.cache / "current.json").write_bytes(encoded({"schema": 1, "current": {
            "version": "0.4.0", "directory": "../../outside", "manifest_sha256": "a" * 64}}))
        result = self.update(check_updates=False)
        self.assertEqual(result["source"], "bundled")
        self.assertTrue(result["warnings"])

    def test_transaction_keeps_old_pointer_on_failure(self):
        first = self.update(fetch=self.network("0.4.0")[0])
        pointer_before = (self.cache / "current.json").read_bytes()
        with patch.object(module, "_atomic_pointer", side_effect=OSError("simulated write failure")):
            result = self.update(fetch=self.network("0.5.0")[0])
        self.assertEqual(result["root"], first["root"])
        self.assertFalse(result["updated"])
        self.assertEqual((self.cache / "current.json").read_bytes(), pointer_before)

    def test_unrelated_models_preferences_and_connection_file_are_untouched(self):
        sentinels = [self.root / "model.gguf", self.root / "relay-provider-pool.json", self.root / "preferences.json"]
        for path in sentinels:
            path.write_bytes(b"user state secret")
        self.update(fetch=self.network()[0])
        self.assertTrue(all(path.read_bytes() == b"user state secret" for path in sentinels))

    def test_bad_zip_hash_falls_back_and_does_not_commit(self):
        fetch, _, external = self.network()
        external["archive"]["sha256"] = "0" * 64
        result = self.update(fetch=fetch)
        self.assertFalse(result["updated"])
        self.assertEqual(result["source"], "bundled")
        self.assertFalse((self.cache / "current.json").exists())

    def test_manifest_repository_tag_and_archive_fields_are_checked(self):
        files, manifest = fixture("0.4.0")
        original = external_manifest(manifest, zipped(files, manifest))
        for key, bad in (("repository", "attacker/project"), ("tag", "provider-v9.0.0"), ("schema", True)):
            candidate = copy.deepcopy(original)
            candidate[key] = bad
            with self.subTest(key=key), self.assertRaises(module.UpdateError):
                module._manifest(candidate, CONFIG, external=True)
        for key, bad in (("name", "other.zip"), ("size", True), ("size", module.MAX_ARCHIVE_BYTES + 1), ("sha256", "invalid")):
            candidate = copy.deepcopy(original)
            candidate["archive"][key] = bad
            with self.subTest(key=key), self.assertRaises(module.UpdateError):
                module._manifest(candidate, CONFIG, external=True)

    def test_manifest_rejects_case_colliding_parent_directories(self):
        files, manifest = fixture("0.4.0")
        manifest["files"]["Provider/extra.py"] = "a" * 64
        with self.assertRaises(module.UpdateError):
            module._manifest(manifest, CONFIG)

    def test_zip_rejects_path_traversal_case_collisions_unlisted_and_links(self):
        files, manifest = fixture("0.4.0")
        bad_names = ["../escape", "/absolute", "C:/drive", "provider\\escape.py", "provider/../escape", "provider/file:ads", "provider/NUL.txt", "provider/space. ", "provider/SETUP_GUI.py", "extra.py"]
        link = zipfile.ZipInfo("provider/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for name in [*bad_names, link]:
            raw = zipped(files, manifest, [(name, b"bad")])
            external = external_manifest(manifest, raw)
            with self.subTest(name=str(name)), self.assertRaises(module.UpdateError):
                module._archive_entries(raw, external, CONFIG)
        self.assertFalse((self.root / "escape").exists())

    def test_zip_rejects_missing_files_internal_manifest_mismatch_and_wrong_file_hash(self):
        files, manifest = fixture("0.4.0")
        missing = dict(files)
        del missing["provider/setup_gui.py"]
        raw = zipped(missing, manifest)
        with self.assertRaises(module.UpdateError):
            module._archive_entries(raw, external_manifest(manifest, raw), CONFIG)
        changed = copy.deepcopy(manifest)
        changed["version"] = "0.5.0"
        changed["tag"] = "provider-v0.5.0"
        raw = zipped(files, changed)
        with self.assertRaises(module.UpdateError):
            module._archive_entries(raw, external_manifest(manifest, raw), CONFIG)
        files["provider/setup_gui.py"] = b"modified after manifest"
        raw = zipped(files, manifest)
        fetch, _, _ = self.network(archive=raw, manifest=manifest)
        self.assertFalse(self.update(fetch=fetch)["updated"])

    def test_zip_rejects_oversized_expansion(self):
        files, manifest = fixture("0.4.0")
        raw = zipped(files, manifest)
        with patch.object(module, "MAX_EXPANDED_BYTES", 10), self.assertRaises(module.UpdateError):
            module._archive_entries(raw, external_manifest(manifest, raw), CONFIG)

    def test_local_links_and_changed_manifest_are_rejected(self):
        first = self.update(fetch=self.network()[0])
        root = Path(first["root"])
        pointer = json.loads((self.cache / "current.json").read_bytes())["current"]
        with self.assertRaises(module.UpdateError):
            module._verify_local(root, CONFIG, "a" * 64)
        path = root / "provider/setup_gui.py"
        actual = self.root / "external.py"
        actual.write_bytes(path.read_bytes())
        path.unlink()
        try:
            path.symlink_to(actual)
        except OSError:
            self.skipTest("Symlink creation unavailable")
        with self.assertRaises(module.UpdateError):
            module._verify_local(root, CONFIG, pointer["manifest_sha256"])

    def test_release_asset_must_belong_to_configured_repository(self):
        for url in ("https://api.github.com/repos/attacker/project/releases/assets/2", "https://github.com/owner/file.zip",
                    "http://api.github.com/repos/wellseekogi/gpu_combine/releases/assets/2",
                    API + "/releases/assets/2?token=bad"):
            with self.subTest(url=url), self.assertRaises(module.UpdateError):
                module._asset_url({"url": url}, CONFIG)

    def test_redirects_are_https_github_only_and_drop_authorization(self):
        handler = module._GitHubRedirect()
        request = Request(API + "/releases/assets/1", headers={"Authorization": "Bearer secret"})
        result = handler.redirect_request(request, None, 302, "Found", {}, "https://release-assets.githubusercontent.com/asset?signature=example")
        self.assertIsNone(result.get_header("Authorization"))
        for url in ("https://example.com/asset", "http://github.com/asset", "https://api.github.com.evil.com/asset", "https://user:pass@github.com/asset"):
            with self.subTest(url=url), self.assertRaises(module.UpdateError):
                handler.redirect_request(request, None, 302, "Found", {}, url)

    def test_public_http_errors_never_discover_credentials_and_use_verified_fallback(self):
        class PublicEnvironment(dict):
            def __getitem__(self, name):
                if name in {"GH_TOKEN", "GITHUB_TOKEN"}:
                    raise AssertionError("Public updates must not read GitHub credentials")
                return super().__getitem__(name)

            def get(self, name, default=None):
                if name in {"GH_TOKEN", "GITHUB_TOKEN"}:
                    raise AssertionError("Public updates must not read GitHub credentials")
                return super().get(name, default)

        environment = PublicEnvironment({**os.environ, "GH_TOKEN": "private-gh-token",
                                         "GITHUB_TOKEN": "private-github-token"})
        for fallback in ("bundled", "cache"):
            if fallback == "cache":
                fetch, _, _ = self.network()
                self.update(fetch=fetch)
            for code in (401, 403, 404):
                for failed_request in range(3):
                    with self.subTest(fallback=fallback, code=code, failed_request=failed_request):
                        actual, _, _ = self.network(version="0.5.0")
                        attempts = []

                        def denied(url, **kwargs):
                            attempts.append(kwargs["token"])
                            if len(attempts) == failed_request + 1:
                                raise HTTPError(url, code, "private response detail", {}, None)
                            return actual(url, **kwargs)

                        with patch.object(module.os, "environ", environment), \
                                patch.object(module.subprocess, "run") as run:
                            result = self.update(fetch=denied)
                        run.assert_not_called()
                        self.assertEqual(attempts, [None] * (failed_request + 1))
                        self.assertFalse(result["updated"])
                        self.assertEqual(result["source"], fallback)
                        self.assertEqual(result["version"], "0.4.0" if fallback == "cache" else "0.3.0")
                        self.assertIn("HTTP " + str(code), " ".join(result["warnings"]))
                        self.assertNotIn("private", json.dumps(result))

    def test_explicit_internal_token_is_in_memory_and_never_logged(self):
        actual, calls, _ = self.network()
        attempts = []

        def private(url, **kwargs):
            attempts.append(kwargs["token"])
            if kwargs["token"] is None:
                raise HTTPError(url, 404, "missing", {}, None)
            return actual(url, **kwargs)

        result = self.update(fetch=private, token="sensitive-token")
        self.assertTrue(result["updated"])
        self.assertEqual(attempts, ["sensitive-token", "sensitive-token", "sensitive-token"])
        self.assertNotIn("sensitive-token", json.dumps(result))
        self.assertNotIn(b"sensitive-token", (self.cache / "current.json").read_bytes())

    def test_fetch_only_sends_token_to_api_and_bounds_response(self):
        requests = []

        class Response(io.BytesIO):
            headers = {"Content-Length": "3"}
            def geturl(self):
                return self.url

        class Opener:
            def open(self, request, **kwargs):
                requests.append(request)
                response = Response(b"abc")
                response.url = request.full_url
                return response

        with patch.object(module, "build_opener", return_value=Opener()):
            self.assertEqual(module.fetch_bytes(API + "/releases/assets/1", token="secret", max_bytes=3, timeout=1), b"abc")
            module.fetch_bytes("https://release-assets.githubusercontent.com/file", token="secret", max_bytes=3, timeout=1)
            with self.assertRaises(module.UpdateError):
                module.fetch_bytes(API + "/releases/assets/1", max_bytes=2, timeout=1)
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer secret")
        self.assertIsNone(requests[1].get_header("Authorization"))

    def test_concurrent_launches_install_once_and_os_lock_is_released(self):
        fetch, calls, _ = self.network()
        first_entered = threading.Event()
        release_first = threading.Event()
        results = []
        errors = []

        def blocking(url, **kwargs):
            if not first_entered.is_set():
                first_entered.set()
                release_first.wait(2)
            return fetch(url, **kwargs)

        def run():
            try:
                results.append(self.update(fetch=blocking))
            except Exception as error:
                errors.append(error)

        first = threading.Thread(target=run)
        second = threading.Thread(target=run)
        first.start()
        self.assertTrue(first_entered.wait(1))
        second.start()
        release_first.set()
        first.join(5)
        second.join(5)
        self.assertFalse(first.is_alive() or second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(sum(result["updated"] for result in results), 1)
        self.assertEqual(sum(url.endswith("/2") for url, _ in calls), 1)
        with module._update_lock(self.cache, timeout=0.1):
            pass

    def write_service_origin(self, origin):
        path = self.bundle / "provider/service-config.json"
        path.write_bytes(encoded({"coordinator": origin}))
        manifest_path = self.bundle / "provider-manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["files"]["provider/service-config.json"] = hashlib.sha256(path.read_bytes()).hexdigest()
        manifest_path.write_bytes(encoded(manifest))

    def test_download_origin_survives_cached_bootstrap_and_gui_handoff(self):
        origin = "https://relay.example.org"
        self.write_service_origin(origin)
        cached = self.root / "cached"
        result = {"root": str(cached), "version": "0.4.0", "source": "cache", "updated": False, "warnings": []}
        calls = []

        def launch(arguments, *, env):
            calls.append((arguments, env.get("RELAY_SERVICE_ORIGIN")))
            if arguments[1].endswith("update_launcher.py"):
                with patch.object(module, "__file__", str(cached / "provider/update_launcher.py")), patch.dict(module.os.environ, env, clear=True):
                    return module.main(arguments[2:])
            return 0

        with patch.dict(module.os.environ, {}, clear=True), \
                patch.object(module, "__file__", str(self.bundle / "provider/update_launcher.py")), \
                patch.object(module, "update_and_select", return_value=result), \
                patch.object(module.subprocess, "call", side_effect=launch):
            self.assertEqual(module.main([]), 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual([origin_value for _, origin_value in calls], [origin, origin])
        self.assertTrue(calls[-1][0][1].endswith("setup_gui.py"))
        self.assertFalse((cached / "provider/service-config.json").exists(), "shared immutable cache must not be changed")

    def test_service_origin_is_bounded_validated_and_verified(self):
        with patch.dict(module.os.environ, {}, clear=True):
            for origin in ["https://relay.example.org", "http://127.0.0.1:8788", "http://[::1]:8788"]:
                self.write_service_origin(origin)
                self.assertEqual(module._service_environment(self.bundle)["RELAY_SERVICE_ORIGIN"], origin)
            for origin in [None, 7, "", "http://remote.example", "https://user:secret@relay.example", "https://relay.example/path", "https://relay.example?token=secret", "https://relay.example#fragment", "https://relay.example:bad", "https://relay.example\n"]:
                self.write_service_origin(origin)
                self.assertNotIn("RELAY_SERVICE_ORIGIN", module._service_environment(self.bundle))
            self.write_service_origin("https://relay.example.org")
            (self.bundle / "provider/service-config.json").write_bytes(encoded({"coordinator": "https://changed.example"}))
            self.assertNotIn("RELAY_SERVICE_ORIGIN", module._service_environment(self.bundle))
            (self.bundle / "provider/service-config.json").write_bytes(b" " * 65537)
            self.assertNotIn("RELAY_SERVICE_ORIGIN", module._service_environment(self.bundle))
        with patch.dict(module.os.environ, {"RELAY_SERVICE_ORIGIN": "https://inherited.example"}):
            self.assertEqual(module._service_environment(self.bundle)["RELAY_SERVICE_ORIGIN"], "https://inherited.example")
        with patch.dict(module.os.environ, {"RELAY_SERVICE_ORIGIN": "https://user:secret@invalid.example"}):
            self.assertNotIn("RELAY_SERVICE_ORIGIN", module._service_environment(self.bundle))

    def test_check_only_never_launches_gui_and_preserves_gui_arguments(self):
        result = {"root": str(self.bundle), "version": "0.3.0", "source": "bundled", "updated": False, "warnings": []}
        with patch.object(module, "update_and_select", return_value=result), patch.object(module.subprocess, "call") as call, patch("sys.stdout", new=io.StringIO()):
            self.assertEqual(module.main(["--check-only"]), 0)
            call.assert_not_called()
            call.return_value = 0
            self.assertEqual(module.main(["C:/connection with spaces.json", "--extra"]), 0)
            self.assertEqual(call.call_args.args[0][-2:], ["C:/connection with spaces.json", "--extra"])

    def test_cli_can_repair_damaged_offline_payload_before_launch(self):
        recovered = {"root": str(self.bundle), "version": "0.4.0", "source": "bundled", "updated": True, "warnings": []}
        with patch.object(module, "update_and_select", side_effect=[module.UpdateError("No usable offline payload"), recovered]) as select, patch.object(module.subprocess, "call") as launch, patch("sys.stdout", new=io.StringIO()):
            self.assertEqual(module.main(["--check-only"]), 0)
        self.assertEqual(select.call_count, 2)
        self.assertEqual(select.call_args.kwargs, {})
        launch.assert_not_called()

    def test_verified_cached_updater_handoff_happens_exactly_once(self):
        cached = self.root / "cached"
        result = {"root": str(cached), "version": "0.4.0", "source": "cache", "updated": False, "warnings": []}
        calls = []

        def launch(arguments, *, env):
            calls.append(arguments)
            if arguments[1].endswith("update_launcher.py"):
                with patch.object(module, "__file__", str(cached / "provider/update_launcher.py")), patch.dict(module.os.environ, env, clear=True):
                    return module.main(arguments[2:])
            return 0

        with patch.object(module, "__file__", str(self.bundle / "provider/update_launcher.py")), \
                patch.object(module, "update_and_select", return_value=result) as select, \
                patch.object(module.subprocess, "call", side_effect=launch):
            self.assertEqual(module.main(["connection.json"]), 0)
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0][1].endswith("update_launcher.py"))
        self.assertTrue(calls[1][1].endswith("setup_gui.py"))
        self.assertEqual(calls[1][-1], "connection.json")
        self.assertEqual(sum("check_updates" not in invocation.kwargs for invocation in select.call_args_list), 1)


if __name__ == "__main__":
    unittest.main()

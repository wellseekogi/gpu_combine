import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("model_discovery", Path(__file__).parents[1] / "provider/model_discovery.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def gguf(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 1, 0) + b"synthetic-test-data")
    return path


class ModelDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, **kwargs):
        return module.discover_models(roots=[self.root], **kwargs)

    def hf(self, name="Qwen", tokenizer=True):
        root = self.root / name
        root.mkdir(parents=True)
        (root / "config.json").write_text(json.dumps({"model_type": "qwen3"}), encoding="utf-8")
        if tokenizer:
            (root / "tokenizer.json").write_text('{"model": {}}', encoding="utf-8")
        return root

    def test_complete_gguf_returns_actual_file_and_source(self):
        model = gguf(self.root / "nested/Qwen.gguf")
        result = self.scan()
        self.assertEqual(len(result["models"]), 1)
        found = result["models"][0]
        self.assertEqual(found["path"], str(model))
        self.assertEqual(found["size_bytes"], model.stat().st_size)
        self.assertTrue(found["complete"])
        self.assertTrue(found["compatible"])
        self.assertEqual(found["root"], str(self.root))
        self.assertEqual(found["source"], "지정 폴더")

    def test_incomplete_gguf_is_never_compatible(self):
        (self.root / "broken.gguf").write_bytes(b"GGUF")
        found = self.scan()["models"][0]
        self.assertFalse(found["complete"])
        self.assertFalse(found["compatible"])
        self.assertTrue(found["issues"])

    def test_complete_transformers_is_not_llama_cpp_compatible(self):
        root = self.hf()
        (root / "model.safetensors").write_bytes(b"weights")
        found = self.scan()["models"][0]
        self.assertEqual(found["path"], str(root))
        self.assertEqual(found["format"], "huggingface")
        self.assertTrue(found["complete"])
        self.assertFalse(found["compatible"])
        self.assertTrue(any("vLLM" in issue for issue in found["issues"]))

    def test_complete_shard_index_and_hf_name(self):
        root = self.hf("models--Qwen--Qwen3-4B/snapshots/abc")
        for number in (1, 2):
            (root / f"model-{number:05d}-of-00002.safetensors").write_bytes(b"data")
        (root / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {
            "a": "model-00001-of-00002.safetensors", "b": "model-00002-of-00002.safetensors"}}))
        found = self.scan()["models"][0]
        self.assertTrue(found["complete"])
        self.assertEqual(found["name"], "Qwen/Qwen3-4B")
        self.assertEqual(found["size_bytes"], 8)

    def test_missing_shard_is_incomplete_even_with_one_present(self):
        root = self.hf()
        (root / "model-00001-of-00002.safetensors").write_bytes(b"data")
        (root / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {
            "a": "model-00001-of-00002.safetensors", "b": "model-00002-of-00002.safetensors"}}))
        found = self.scan()["models"][0]
        self.assertFalse(found["complete"])
        self.assertTrue(any("누락" in issue for issue in found["issues"]))

    def test_tokenizer_config_alone_is_not_tokenizer(self):
        root = self.hf(tokenizer=False)
        (root / "pytorch_model.bin").write_bytes(b"data")
        (root / "tokenizer_config.json").write_text("{}")
        found = self.scan()["models"][0]
        self.assertFalse(found["complete"])
        self.assertTrue(any("토크나이저" in issue for issue in found["issues"]))

    def test_malformed_or_escaping_index_is_rejected(self):
        root = self.hf()
        index = root / "model.safetensors.index.json"
        for contents in ('not json', json.dumps({"weight_map": {"a": "../outside.safetensors"}}),
                         json.dumps({"weight_map": {"a": ["wrong"]}})):
            index.write_text(contents)
            found = self.scan()["models"][0]
            self.assertFalse(found["complete"])
            self.assertTrue(found["issues"])

    def test_oversized_config_does_not_load_as_model(self):
        root = self.hf()
        (root / "config.json").write_bytes(b" " * (module.JSON_LIMIT + 1))
        (root / "model.safetensors").write_bytes(b"data")
        found = self.scan()["models"][0]
        self.assertFalse(found["complete"])
        self.assertTrue(any("4MB" in issue for issue in found["issues"]))

    def test_skip_noise_incomplete_files_and_bound_depth(self):
        for directory in (".git", "node_modules", ".no_exist", "locks", ".locks"):
            gguf(self.root / directory / "hidden.gguf")
        gguf(self.root / "download.gguf.incomplete")
        gguf(self.root / "a/b/too-deep.gguf")
        result = self.scan(max_depth=1)
        self.assertEqual(result["models"], [])
        self.assertTrue(any("깊이" in warning for warning in result["warnings"]))

    def test_entry_limit_is_reported(self):
        for number in range(5):
            (self.root / str(number)).write_text("x")
        result = self.scan(max_entries=2)
        self.assertTrue(any("항목 한도" in warning for warning in result["warnings"]))

    def test_duplicate_roots_do_not_duplicate_model(self):
        gguf(self.root / "Qwen.gguf")
        result = module.discover_models(roots=[self.root], extra_roots=[self.root])
        self.assertEqual(len(result["models"]), 1)
        self.assertEqual(len(result["roots"]), 1)

    def test_explicit_folder_is_scanned_before_oversized_default_cache(self):
        cache = self.root / "default-cache"
        cache.mkdir()
        for number in range(5):
            (cache / str(number)).write_text("x")
        selected = self.root / "selected"
        gguf(selected / "wanted.gguf")
        with patch.object(module.Path, "home", return_value=self.root / "home"):
            with patch.dict(module.os.environ, {"HF_HOME": str(cache)}, clear=True):
                with patch.object(module._Scan, "wsl_roots", return_value=[]):
                    result = module.discover_models(extra_roots=[selected], max_entries=2)
        self.assertEqual(result["models"][0]["name"], "wanted")
        self.assertEqual(result["roots"][0], str(selected))
        self.assertEqual(result["models"][0]["source"], "선택 폴더")
        self.assertTrue(any("항목 한도" in warning for warning in result["warnings"]))

    def test_file_symlinks_work_directory_links_are_not_traversed(self):
        blob = self.root / "blobs/abc"
        gguf(blob)
        link = self.root / "Qwen.gguf"
        try:
            link.symlink_to(blob)
            (self.root / "loop").symlink_to(self.root, target_is_directory=True)
        except OSError:
            self.skipTest("Symbolic links require OS permission")
        found = self.scan()["models"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["path"], str(link))
        self.assertTrue(found[0]["complete"])

    def test_missing_split_gguf_and_complete_split_deduplicate(self):
        gguf(self.root / "qwen-00002-of-00002.gguf")
        result = self.scan()["models"]
        self.assertEqual(len(result), 1)
        self.assertFalse(result[0]["complete"])
        first = gguf(self.root / "qwen-00001-of-00002.gguf")
        result = self.scan()["models"]
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]["complete"])
        self.assertEqual(result[0]["path"], str(first))
        self.assertFalse(result[0]["compatible"])
        self.assertTrue(any("해시" in issue for issue in result[0]["issues"]))

    def test_ollama_manifest_resolves_blob_and_missing_blob(self):
        root = self.root / "models"
        digest = "a" * 64
        blob = gguf(root / "blobs" / ("sha256-" + digest))
        manifest = root / "manifests/registry.ollama.ai/library/qwen3/latest"
        manifest.parent.mkdir(parents=True)
        manifest.write_text(json.dumps({"layers": [{"mediaType": "application/vnd.ollama.image.model",
                                                     "digest": "sha256:" + digest, "size": blob.stat().st_size}]}))
        found = self.scan()["models"][0]
        self.assertEqual(found["format"], "ollama")
        self.assertEqual(found["path"], str(blob))
        self.assertTrue(found["compatible"])
        blob.unlink()
        found = self.scan()["models"][0]
        self.assertFalse(found["complete"])
        self.assertFalse(found["compatible"])

    def test_cancelled_scan_returns_promptly(self):
        event = threading.Event()
        event.set()
        result = self.scan(cancel_event=event)
        self.assertEqual(result["models"], [])

    def test_stalled_filesystem_returns_at_deadline(self):
        released = threading.Event()
        entered = threading.Event()
        def blocked(scan, root, source):
            entered.set()
            released.wait(1)
        try:
            with patch.object(module._Scan, "walk", blocked):
                start = time.monotonic()
                result = self.scan(max_seconds=0.05)
                self.assertLess(time.monotonic() - start, 0.5)
                self.assertTrue(entered.is_set())
                self.assertTrue(any("시간 제한" in warning for warning in result["warnings"]))
        finally:
            released.set()

    def test_tokenizer_only_companion_is_not_a_model(self):
        self.hf("tokenizer")
        gguf(self.root / "qwen.gguf")
        self.assertEqual([model["format"] for model in self.scan()["models"]], ["gguf"])

    def test_environment_cache_and_project_defaults_are_used(self):
        cache = self.root / "custom-hf"
        gguf(cache / "cached.gguf")
        home = self.root / "user"
        gguf(home / "projects/demo/models/qwen.gguf")
        with patch.object(module.Path, "home", return_value=home):
            with patch.dict(module.os.environ, {"HF_HOME": str(cache)}, clear=True):
                with patch.object(module._Scan, "wsl_roots", return_value=[]):
                    result = module.discover_models()
        models = {model["name"]: model for model in result["models"]}
        self.assertEqual(models["cached"]["source"], "HF_HOME")
        self.assertEqual(models["qwen"]["source"], "프로젝트 폴더")
        self.assertFalse(any("lmstudio" in warning for warning in result["warnings"]))

    def test_inaccessible_directory_does_not_abort_other_candidates(self):
        scan = module._Scan(100, 3, None)
        denied = self.root / "denied"
        original = module.Path.is_dir
        def controlled(path):
            if path == denied:
                raise PermissionError("denied")
            return original(path)
        gguf(self.root / "available/model.gguf")
        with patch.object(module.Path, "is_dir", controlled):
            scan.run([denied, self.root / "available"], [])
        result = scan.snapshot()
        self.assertEqual(len(result["models"]), 1)
        self.assertTrue(result["warnings"])

    @unittest.skipUnless(os.name == "nt", "WSL enumeration is Windows-only")
    def test_wsl_enumeration_is_bounded_and_excludes_docker(self):
        from types import SimpleNamespace
        scan = module._Scan(100, 3, None)
        visits = []
        def directory(path, missing=False):
            visits.append(str(path))
            return str(path).endswith("Ubuntu\\models")
        def inaccessible(path):
            raise PermissionError("test directory unavailable")
        result = SimpleNamespace(returncode=0, stdout="Ubuntu\r\ndocker-desktop\r\n".encode("utf-16-le"))
        with patch.object(module.subprocess, "run", return_value=result) as command:
            with patch.object(scan, "directory", side_effect=directory):
                with patch.object(module.os, "scandir", side_effect=inaccessible):
                    roots = scan.wsl_roots()
        self.assertEqual(command.call_args.args[0], ["wsl.exe", "--list", "--quiet"])
        self.assertEqual(command.call_args.kwargs["timeout"], 6)
        self.assertEqual(str(roots[0][0]), "\\\\wsl.localhost\\Ubuntu\\models")
        self.assertFalse(any("docker" in visited for visited in visits))
        self.assertTrue(scan.warnings)

    def test_missing_root_and_invalid_limits_are_explicit(self):
        result = module.discover_models(roots=[self.root / "missing"])
        self.assertTrue(result["warnings"])
        for kwargs in ({"max_entries": 0}, {"max_depth": 50}, {"max_seconds": float("nan")}):
            with self.assertRaises(ValueError):
                self.scan(**kwargs)


if __name__ == "__main__":
    unittest.main()

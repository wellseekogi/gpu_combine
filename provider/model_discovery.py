"""Bounded, offline model discovery. No downloads, imports of model code, or execution.

`complete` describes locally present artifacts, not inference readiness. `compatible`
means a complete GGUF candidate can be selected by the existing llama.cpp adapter;
its architecture, runtime, chat template, memory needs and GPU are not verified here.
"""
import json
import os
from pathlib import Path, PurePosixPath
import re
import struct
import subprocess
import threading
import time

SKIP_NAMES = {".git", "node_modules", ".no_exist", ".locks", "locks", "__pycache__"}
JSON_LIMIT = 4 * 1024 * 1024
ENV_ROOTS = ("HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE", "OLLAMA_MODELS")


class _Stopped(Exception):
    pass


def _key(path):
    return os.path.normcase(os.path.abspath(str(path)))


def _skipped(name):
    return name in SKIP_NAMES or name.endswith((".incomplete", ".lock"))


def _json(path):
    with open(path, "rb") as source:
        raw = source.read(JSON_LIMIT + 1)
    if len(raw) > JSON_LIMIT:
        raise ValueError("JSON 파일이 검색 제한(4MB)을 초과합니다")
    value = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("JSON 객체가 필요합니다")
    return value


def _nonempty(path):
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _size(path):
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def _gguf_valid(path):
    try:
        with open(path, "rb") as source:
            header = source.read(24)
        return len(header) == 24 and header[:4] == b"GGUF" and struct.unpack("<I", header[4:8])[0] in (2, 3)
    except OSError:
        return False


def _safe_relative(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or "\x00" in value:
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or path.suffix not in {".safetensors", ".bin"}:
        return None
    return path


def _model_name(directory, config=None):
    for parent in (directory, *directory.parents):
        if parent.name.startswith("models--"):
            return parent.name[len("models--"):].replace("--", "/")
    if config:
        name = config.get("_name_or_path")
        if isinstance(name, str) and name and len(name) < 256 and not os.path.isabs(name):
            return name
    return directory.name


class _Scan:
    def __init__(self, max_entries, max_depth, cancel_event):
        self.max_entries = max_entries
        self.max_depth = max_depth
        self.cancel_event = cancel_event
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.models = []
        self.roots = []
        self.warnings = []
        self.count = 0
        self.seen_roots = set()
        self.seen_dirs = set()
        self.seen_models = set()

    def check(self):
        if self.stop.is_set() or (self.cancel_event is not None and self.cancel_event.is_set()):
            raise _Stopped()

    def warning(self, message):
        with self.lock:
            if message not in self.warnings and len(self.warnings) < 50:
                self.warnings.append(message)

    def directory(self, path, missing=False):
        try:
            exists = path.is_dir()
        except OSError:
            self.warning("검색 폴더에 접근할 수 없습니다: " + str(path))
            return False
        if not exists and missing:
            self.warning("검색 폴더가 없거나 접근할 수 없습니다: " + str(path))
        return exists

    def snapshot(self):
        with self.lock:
            return {"models": sorted((dict(model) for model in self.models), key=lambda model: (model["name"].lower(), model["path"])),
                    "roots": list(self.roots), "warnings": list(self.warnings)}

    def add(self, name, path, format_name, size, complete, issues, source, root, *, compatible=None):
        identity = (format_name, _key(path))
        if identity in self.seen_models:
            return
        self.seen_models.add(identity)
        model = {"name": name, "path": str(path), "format": format_name, "size_bytes": size,
                 "complete": bool(complete), "compatible": bool(complete and (format_name in {"gguf", "ollama"} if compatible is None else compatible)),
                 "issues": list(issues), "source": source, "root": str(root)}
        with self.lock:
            self.models.append(model)

    def gguf(self, path, source, root, name=None, format_name="gguf", expected_size=None):
        issues = []
        split = re.fullmatch(r"(.+)-(\d{5})-of-(\d{5})\.gguf", path.name, flags=re.IGNORECASE)
        if split and 1 <= int(split[2]) <= int(split[3]) <= 256:
            path = path.with_name(f"{split[1]}-00001-of-{int(split[3]):05d}.gguf")
            if (format_name, _key(path)) in self.seen_models:
                return
        size = _size(path)
        complete = _gguf_valid(path)
        if not complete:
            issues.append("GGUF 파일이 없거나 헤더가 손상되었습니다.")
        if expected_size is not None and size != expected_size:
            issues.append("Ollama 매니페스트에 기록된 파일 크기와 다릅니다.")
            complete = False
        split = re.fullmatch(r"(.+)-(\d{5})-of-(\d{5})\.gguf", path.name, flags=re.IGNORECASE)
        if split:
            part, total = int(split[2]), int(split[3])
            if not 1 <= part <= total <= 256:
                issues.append("분할 GGUF 번호가 올바르지 않거나 검색 한도(256개)를 넘습니다.")
                complete = False
            else:
                missing = []
                size = 0
                for number in range(1, total + 1):
                    self.check()
                    shard = path.with_name(f"{split[1]}-{number:05d}-of-{total:05d}.gguf")
                    if not _gguf_valid(shard):
                        missing.append(shard.name)
                    size += _size(shard)
                if missing:
                    issues.append("분할 GGUF 파일 누락 또는 손상: " + ", ".join(missing[:5]))
                    complete = False
        multiple_files = split is not None and int(split[3]) > 1
        if multiple_files:
            issues.append("분할 GGUF는 현재 지원하지 않습니다. 현재 승인 계약은 모델 파일 하나의 해시만 검사하므로 단일 GGUF 파일로 준비해 주세요.")
        self.add(name or path.stem, path, format_name, size, complete, issues, source, root,
                 compatible=not multiple_files)

    def huggingface(self, directory, files, source, root):
        issues = []
        config = None
        try:
            config = _json(files["config.json"])
        except (OSError, ValueError, UnicodeError, RecursionError) as error:
            issues.append("config.json 읽기 실패: " + str(error)[:180])
        variants = []
        indexes = sorted(name for name in files if name.endswith((".safetensors.index.json", ".bin.index.json")))
        for name in indexes:
            self.check()
            invalid = []
            shards = []
            try:
                index = _json(files[name])
                mapping = index.get("weight_map")
                if not isinstance(mapping, dict) or not mapping or len(mapping) > 100000:
                    raise ValueError("올바른 weight_map이 없습니다")
                for value in set(mapping.values()):
                    relative = _safe_relative(value)
                    if relative is None:
                        raise ValueError("허용되지 않은 가중치 파일 경로입니다")
                    shard = directory.joinpath(*relative.parts)
                    shards.append(shard)
                    if not _nonempty(shard):
                        invalid.append(relative.as_posix())
                if invalid:
                    raise ValueError("가중치 조각 누락 또는 빈 파일: " + ", ".join(sorted(invalid)[:5]))
                variants.append(shards)
            except (OSError, ValueError, UnicodeError, TypeError, RecursionError) as error:
                issues.append(name + ": " + str(error)[:220])
        standalone = [files[name] for name in files
                      if name.endswith(".safetensors") or name in {"pytorch_model.bin", "model.bin"}]
        # Shards need an index. A single complete alternative can be valid, but any
        # present invalid index remains visible and makes this cache incomplete.
        unsharded = [path for path in standalone if not re.search(r"-\d+-of-\d+\.", path.name)]
        if unsharded and all(_nonempty(path) for path in unsharded):
            variants.append(unsharded)
        if not variants:
            issues.append("완전한 safetensors 또는 PyTorch 가중치를 찾지 못했습니다.")
        tokenizers = ("tokenizer.json", "tokenizer.model", "spiece.model", "vocab.txt")
        has_tokenizer = any(name in files and _nonempty(files[name]) for name in tokenizers)
        has_tokenizer = has_tokenizer or all(name in files and _nonempty(files[name]) for name in ("vocab.json", "merges.txt"))
        if not has_tokenizer:
            issues.append("토크나이저 파일이 없거나 비어 있습니다.")
        complete = config is not None and bool(variants) and has_tokenizer and not issues
        weights = max(variants, key=lambda group: sum(_size(path) for path in group), default=[])
        size = sum(_size(path) for path in weights)
        if not size:
            size = sum(_size(path) for path in standalone)
        issues.append("Transformers 형식입니다. 현재 llama.cpp 연결에는 GGUF 변환 또는 별도 vLLM 연동이 필요합니다.")
        self.add(_model_name(directory, config), directory, "huggingface", size, complete, issues, source, root)

    def ollama(self, path, source, root):
        parts = path.parts
        if "manifests" not in parts:
            return
        manifest_position = len(parts) - 1 - tuple(reversed(parts)).index("manifests")
        model_root = Path(*parts[:manifest_position])
        if not model_root.name.lower() == "models" and not (model_root / "blobs").is_dir():
            return
        try:
            manifest = _json(path)
            layers = manifest.get("layers", [])
            if not isinstance(layers, list) or len(layers) > 256:
                raise ValueError("올바른 Ollama layers가 없습니다")
            model_layers = [layer for layer in layers if isinstance(layer, dict) and layer.get("mediaType") == "application/vnd.ollama.image.model"]
            relative = parts[manifest_position + 1:]
            name = "/".join(relative[:-1]) + ":" + relative[-1]
            for layer in model_layers:
                digest = layer.get("digest")
                if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-fA-F0-9]{64}", digest):
                    raise ValueError("Ollama 모델 digest 형식이 올바르지 않습니다")
                size = layer.get("size")
                if size is not None and (isinstance(size, bool) or not isinstance(size, int) or size < 0):
                    raise ValueError("Ollama 모델 크기가 올바르지 않습니다")
                self.gguf(model_root / "blobs" / digest.replace(":", "-"), source, root, name, "ollama", size)
        except (OSError, ValueError, UnicodeError, RecursionError) as error:
            self.warning(f"Ollama 매니페스트를 읽지 못했습니다: {path}: {str(error)[:180]}")

    def walk(self, root, source):
        root = Path(root).expanduser().absolute()
        if _key(root) in self.seen_roots:
            return
        self.seen_roots.add(_key(root))
        with self.lock:
            self.roots.append(str(root))
        if not self.directory(root, missing=source in {"지정 폴더", "선택 폴더", *ENV_ROOTS}):
            return
        stack = [(root, 0)]
        while stack:
            self.check()
            directory, depth = stack.pop()
            if _key(directory) in self.seen_dirs:
                continue
            self.seen_dirs.add(_key(directory))
            files = {}
            children = []
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        self.check()
                        self.count += 1
                        if self.count > self.max_entries:
                            self.warning(f"검색 항목 한도({self.max_entries:,}개)에 도달했습니다. 모델 폴더를 직접 선택해 주세요.")
                            raise _Stopped()
                        if _skipped(entry.name):
                            continue
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                if entry.is_symlink() or (getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0) & 0x400):
                                    continue
                                if depth < self.max_depth:
                                    children.append(Path(entry.path))
                                else:
                                    self.warning(f"검색 깊이 한도({self.max_depth})에 도달했습니다: {directory}")
                            elif entry.is_file() or entry.is_symlink():
                                files[entry.name] = Path(entry.path)
                        except OSError:
                            self.warning("파일에 접근할 수 없습니다: " + entry.path)
            except OSError:
                self.warning("검색 폴더를 읽을 수 없습니다: " + str(directory))
                continue
            tokenizer_only = directory.name.lower() in {"tokenizer", "tokenizers"} and not any(
                name.endswith((".safetensors", ".bin", ".safetensors.index.json", ".bin.index.json")) for name in files)
            if "config.json" in files and not tokenizer_only:
                self.huggingface(directory, files, source, root)
            for name, path in sorted(files.items()):
                self.check()
                if name.lower().endswith(".gguf"):
                    self.gguf(path, source, root)
                elif "manifests" in path.parts:
                    self.ollama(path, source, root)
            stack.extend((child, depth + 1) for child in reversed(sorted(children)))

    def wsl_roots(self):
        if os.name != "nt":
            return []
        try:
            listing = subprocess.run(["wsl.exe", "--list", "--quiet"], capture_output=True, timeout=6,
                                     check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (OSError, subprocess.TimeoutExpired):
            self.warning("WSL 목록을 읽지 못했습니다. 필요한 모델 폴더를 직접 선택할 수 있습니다.")
            return []
        if listing.returncode != 0:
            return []
        raw = listing.stdout[:32768]
        names = raw.decode("utf-16-le" if b"\x00" in raw else "utf-8", errors="replace").splitlines()
        roots = []
        for name in names[:16]:
            self.check()
            name = name.strip().lstrip("\ufeff")
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,80}", name) or name.lower().startswith("docker-desktop"):
                continue
            distro = Path("\\\\wsl.localhost") / name
            homes = []
            try:
                with os.scandir(distro / "root"):
                    homes.append(distro / "root")
            except OSError:
                self.warning("WSL root 폴더에 접근할 수 없습니다: " + name)
            for relative in ("models", "data/models", "opt/models", "srv/models"):
                self.check()
                candidate = distro / relative
                if self.directory(candidate):
                    roots.append((candidate, "WSL " + name))
            try:
                with os.scandir(distro / "home") as entries:
                    for index, entry in enumerate(entries):
                        self.check()
                        if index >= 32:
                            break
                        if entry.is_dir(follow_symlinks=False) and not entry.is_symlink():
                            homes.append(Path(entry.path))
            except OSError:
                self.warning("WSL 홈 폴더를 읽을 수 없습니다: " + name)
            for home in homes:
                for relative in (".cache/huggingface/hub", ".cache/huggingface", ".lmstudio/models", ".ollama/models", "models"):
                    self.check()
                    candidate = home / relative
                    if self.directory(candidate):
                        roots.append((candidate, "WSL " + name))
        return roots

    def project_roots(self):
        """Inspect only named model/cache folders one project level below common roots."""
        home = Path.home()
        bases = [home / "projects", home / "my_project", home / "source/repos"]
        if os.name == "nt":
            drive = Path(Path(__file__).anchor)
            bases.extend([drive / "my_project", drive / "projects"])
        found = []
        seen = set()
        for base in bases:
            self.check()
            if _key(base) in seen or not self.directory(base):
                continue
            seen.add(_key(base))
            projects = [base]
            try:
                with os.scandir(base) as entries:
                    for number, entry in enumerate(entries):
                        self.check()
                        if number >= 64:
                            self.warning("프로젝트 폴더 검색 한도에 도달했습니다: " + str(base))
                            break
                        if (not _skipped(entry.name) and entry.is_dir(follow_symlinks=False)
                                and not entry.is_symlink()
                                and not (getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0) & 0x400)):
                            projects.append(Path(entry.path))
            except OSError:
                self.warning("프로젝트 폴더를 읽을 수 없습니다: " + str(base))
            for project in projects:
                for relative in ("models", ".cache/huggingface/hub"):
                    self.check()
                    candidate = project / relative
                    if self.directory(candidate):
                        found.append((candidate, "프로젝트 폴더"))
        return found

    def run(self, roots, extra_roots):
        try:
            defaults = []
            if roots is None:
                for name in ENV_ROOTS:
                    value = os.environ.get(name)
                    if value:
                        defaults.append((Path(value), name))
                home = Path.home()
                defaults.extend([(home / ".cache/huggingface/hub", "Hugging Face"),
                                 (home / ".lmstudio/models", "LM Studio"),
                                 (home / ".ollama/models", "Ollama"),
                                 (home / "models", "내 모델 폴더"),
                                 (Path(__file__).resolve().parents[1] / "models", "프로젝트")])
            else:
                defaults = [(Path(root), "지정 폴더") for root in roots]
            # Explicit recovery choices must be reached even if a default cache
            # exhausts the global entry/time budget.
            for root, source in [(Path(root), "선택 폴더") for root in extra_roots] + defaults:
                self.check()
                self.walk(root, source)
            if roots is None:
                for root, source in self.project_roots():
                    self.check()
                    self.walk(root, source)
                for root, source in self.wsl_roots():
                    self.check()
                    self.walk(root, source)
        except _Stopped:
            pass
        except (OSError, ValueError) as error:
            self.warning("모델 검색 일부를 완료하지 못했습니다: " + str(error)[:200])


def discover_models(extra_roots=(), *, roots=None, max_entries=20000, max_depth=8,
                    max_seconds=30, cancel_event=None):
    """Return {models, roots, warnings}; `roots=` replaces platform defaults for tests.

    Read-only filesystem work is bounded by entries, depth, JSON size and wall time.
    A daemon worker permits returning partial results when a network/WSL filesystem
    metadata call stalls; it stops after that OS call returns. File symlinks used by
    Hugging Face are followed, but directory links/junctions are not traversed.
    """
    if isinstance(extra_roots, (str, os.PathLike)):
        extra_roots = [extra_roots]
    if isinstance(roots, (str, os.PathLike)):
        roots = [roots]
    extra_roots = list(extra_roots)
    roots = None if roots is None else list(roots)
    if len(extra_roots) + (len(roots) if roots is not None else 0) > 64:
        raise ValueError("검색 폴더는 최대 64개입니다.")
    if not isinstance(max_entries, int) or not 1 <= max_entries <= 1000000:
        raise ValueError("max_entries must be between 1 and 1000000")
    if not isinstance(max_depth, int) or not 0 <= max_depth <= 32:
        raise ValueError("max_depth must be between 0 and 32")
    if not isinstance(max_seconds, (int, float)) or not 0.01 <= max_seconds <= 120:
        raise ValueError("max_seconds must be between 0.01 and 120")
    scan = _Scan(max_entries, max_depth, cancel_event)
    worker = threading.Thread(target=scan.run, args=(roots, extra_roots), daemon=True, name="relay-model-scan")
    worker.start()
    deadline = time.monotonic() + max_seconds
    while worker.is_alive():
        remaining = deadline - time.monotonic()
        if remaining <= 0 or (cancel_event is not None and cancel_event.is_set()):
            scan.stop.set()
            scan.warning("모델 검색이 중단되었습니다." if remaining > 0 else "모델 검색 시간 제한에 도달했습니다. 폴더를 직접 선택해 다시 검색해 주세요.")
            break
        worker.join(min(remaining, 0.05))
    return scan.snapshot()

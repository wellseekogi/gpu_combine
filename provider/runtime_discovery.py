"""Bounded, read-only discovery of locally installed native llama.cpp servers.

Finding a nonempty native executable does not verify its version, dependencies,
GPU support, or trustworthiness. Discovery never starts a candidate executable.
"""
import ctypes
import math
import os
from pathlib import Path
import stat
import threading
import time


NATIVE_NAME = "llama-server.exe" if os.name == "nt" else "llama-server"
SKIP_NAMES = {".git", ".cache", ".venv", ".venv-wsl", "venv", "node_modules",
              "__pycache__", "models", "logs", "data", "blobs", ".pytest_cache"}
PACKAGE_NAMES = {"bin", "build", "runtime", "runtimes", "tools", ".tools"}
PROBE_LOCATIONS = ("", "bin", "bin/Release", "build/bin", "build/bin/Release", "build/Release")


def _windows_fixed_drives():
    """List local fixed drives without probing network or removable volumes."""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetLogicalDrives.argtypes = []
    kernel.GetLogicalDrives.restype = ctypes.c_uint32
    kernel.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
    kernel.GetDriveTypeW.restype = ctypes.c_uint32
    mask = kernel.GetLogicalDrives()
    if not mask:
        raise OSError("Local drive enumeration unavailable")
    roots = [Path(chr(ord("A") + index) + ":\\") for index in range(26) if mask & (1 << index)]
    return [root for root in roots if kernel.GetDriveTypeW(str(root)) == 3]


class _Stopped(Exception):
    pass


def _key(path):
    return os.path.normcase(os.path.realpath(str(path)))


def _linked(metadata):
    return stat.S_ISLNK(metadata.st_mode) or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)


class _Scan:
    def __init__(self, max_entries, max_depth, cancel_event):
        self.max_entries = max_entries
        self.max_depth = max_depth
        self.cancel_event = cancel_event
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.runtimes = []
        self.roots = []
        self.warnings = []
        self.count = 0
        self.seen_roots = set()
        self.seen_dirs = set()
        self.seen_files = set()
        self.seen_bases = set()

    def check(self):
        if self.stop.is_set() or (self.cancel_event is not None and self.cancel_event.is_set()):
            raise _Stopped()

    def item(self):
        self.check()
        self.count += 1
        if self.count > self.max_entries:
            self.warning(f"llama-server 검색 항목 한도({self.max_entries:,}개)에 도달했습니다.")
            raise _Stopped()

    def warning(self, message):
        with self.lock:
            if message not in self.warnings and len(self.warnings) < 50:
                self.warnings.append(message)

    def snapshot(self):
        with self.lock:
            return {"runtimes": [dict(item) for item in self.runtimes],
                    "roots": list(self.roots), "warnings": list(self.warnings)}

    def record_root(self, root):
        # Lexical identity is enough for the reporting list; candidate and traversal
        # identities separately use real paths to remove filesystem aliases.
        identity = os.path.normcase(os.path.abspath(str(root)))
        if identity not in self.seen_roots:
            self.seen_roots.add(identity)
            with self.lock:
                self.roots.append(str(root))

    def candidate(self, path, source, root):
        self.item()
        expected = path.name.lower() if os.name == "nt" else path.name
        if expected != NATIVE_NAME:
            return
        try:
            metadata = path.stat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0:
                return
            if os.name != "nt" and not os.access(path, os.X_OK):
                return
            actual = Path(os.path.realpath(path))
            identity = _key(actual)
            self.check()
            if identity in self.seen_files:
                return
            self.seen_files.add(identity)
            item = {"name": "llama-server — " + actual.parent.name, "path": str(actual),
                    "source": source, "root": str(root), "size_bytes": metadata.st_size}
            with self.lock:
                self.runtimes.append(item)
        except OSError:
            return

    def walk(self, root, source):
        self.check()
        root = Path(root).expanduser().absolute()
        self.record_root(root)
        # Never turn a default or configured drive/root into a whole-disk scan.
        if root == Path(root.anchor):
            self.warning("드라이브 전체는 검색하지 않습니다: " + str(root))
            return
        try:
            metadata = root.lstat()
            if _linked(metadata):
                return
            if stat.S_ISREG(metadata.st_mode):
                self.candidate(root, source, root.parent)
                return
            if not stat.S_ISDIR(metadata.st_mode):
                return
        except OSError:
            return
        stack = [(root, 0)]
        while stack:
            self.check()
            directory, depth = stack.pop()
            identity = _key(directory)
            if identity in self.seen_dirs:
                continue
            self.seen_dirs.add(identity)
            children = []
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        self.item()
                        name = entry.name.lower()
                        if name in SKIP_NAMES:
                            continue
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                if _linked(entry.stat(follow_symlinks=False)):
                                    continue
                                if depth < self.max_depth:
                                    children.append(Path(entry.path))
                                else:
                                    self.warning(f"llama-server 검색 깊이 한도({self.max_depth})에 도달했습니다: {directory}")
                            elif (name if os.name == "nt" else entry.name) == NATIVE_NAME:
                                self.candidate(Path(entry.path), source, root)
                        except OSError:
                            self.warning("파일에 접근할 수 없습니다: " + entry.path)
            except OSError:
                self.warning("검색 폴더를 읽을 수 없습니다: " + str(directory))
            stack.extend((child, depth + 1) for child in reversed(sorted(children)))

    def children(self, base):
        """Only enumerate one level, without following links or junctions."""
        self.check()
        try:
            if _linked(base.lstat()):
                return []
            found = []
            with os.scandir(base) as entries:
                for entry in entries:
                    self.item()
                    if entry.name.lower() in SKIP_NAMES:
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False) and not _linked(entry.stat(follow_symlinks=False)):
                            found.append(Path(entry.path))
                    except OSError:
                        continue
            return sorted(found)
        except OSError:
            return []

    def package_base(self, base, source, include_tools=True):
        """Probe known layouts and recurse only through named runtime folders."""
        self.check()
        base = Path(base).expanduser().absolute()
        identity = _key(base)
        if identity in self.seen_bases:
            return
        self.seen_bases.add(identity)
        self.record_root(base)
        for relative in PROBE_LOCATIONS:
            self.candidate(base / relative / NATIVE_NAME, source, base)
        if include_tools:
            for relative in (".relay/runtimes", ".relay/runtime"):
                self.walk(base / relative, "Relay 런타임")
        for child in self.children(base):
            name = child.name.lower()
            if "llama" in name or (include_tools and name in PACKAGE_NAMES):
                self.walk(child, source)

    def managed_projects(self, base):
        """Probe the drive top level; only walk named runtimes and Relay caches."""
        base = Path(base)
        self.record_root(base)
        self.candidate(base / NATIVE_NAME, "드라이브 설치 폴더", base)
        for project in self.children(base):
            self.check()
            if "llama" in project.name.lower():
                self.walk(project, "드라이브 설치 폴더")
            marker = project / ".relay"
            try:
                metadata = marker.lstat()
                if not stat.S_ISDIR(metadata.st_mode) or _linked(metadata):
                    continue
            except OSError:
                continue
            for name in ("runtimes", "runtime"):
                self.walk(marker / name, "Relay 런타임")

    def defaults(self):
        home = Path.home()
        project = Path(__file__).resolve().parents[1]
        drives = set()
        if os.name == "nt":
            try:
                drives = set(_windows_fixed_drives())
            except (OSError, AttributeError):
                drives = {Path(project.anchor), Path(home.anchor), Path(os.environ.get("SystemDrive", "C:") + "\\")}
            for drive in sorted(drives):
                self.managed_projects(drive)
        adjacent = [project.parent] if project.parent != Path(project.anchor) else []
        for base in (project, *adjacent, Path.cwd(), home / "llama.cpp", home / "llama"):
            self.package_base(base, "프로젝트 / 설치 폴더")
        for base in (home / "Downloads", home / "Desktop"):
            self.package_base(base, "다운로드 / 바탕 화면", include_tools=False)
            for child in self.children(base):
                if child.name.lower().startswith(("relay-", "pc-setup")):
                    self.package_base(child, "PC 설정 패키지")
        bases = [home / "projects", home / "my_project", home / "source/repos", home / "tools"]
        if os.name == "nt":
            for drive in sorted(drives):
                bases.extend(Path(drive) / name for name in ("my_project", "projects", "tools", "llama.cpp", "llama"))
        for base in bases:
            self.package_base(base, "프로젝트 / 도구 폴더")
            for child in self.children(base):
                self.package_base(child, "프로젝트 / 도구 폴더")
        if os.name == "nt":
            local = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData/Local")))
            packages = [(local / "Microsoft/WinGet/Packages", "WinGet"),
                        (local / "Programs", "설치 프로그램"),
                        (home / "scoop/apps", "Scoop"),
                        (Path(os.environ.get("ProgramData", "C:/ProgramData")) / "scoop/apps", "Scoop"),
                        (Path(os.environ.get("ChocolateyInstall", "C:/ProgramData/chocolatey")) / "lib", "Chocolatey")]
            for variable in ("ProgramFiles", "ProgramFiles(x86)"):
                if os.environ.get(variable):
                    packages.append((Path(os.environ[variable]), "설치 프로그램"))
            for base, source in packages:
                self.package_base(base, source, include_tools=False)
            self.package_base(local / "Microsoft/WinGet/Links", "WinGet PATH")
        else:
            for base in (Path("/usr/local/bin"), Path("/usr/bin"), home / ".local/bin", Path("/opt/llama.cpp"), Path("/opt/homebrew/bin")):
                self.package_base(base, "설치 프로그램", include_tools=False)

    def run(self, roots, extra_roots):
        try:
            for root in extra_roots:
                self.walk(root, "설정된 경로")
            if roots is not None:
                for root in roots:
                    self.walk(root, "지정 폴더")
                return
            value = os.environ.get("LLAMA_SERVER", "").strip().strip('"')
            if value:
                path = Path(os.path.expandvars(value)).expanduser().absolute()
                self.record_root(path.parent)
                self.candidate(path, "LLAMA_SERVER", path.parent)
            # PATH is checked for an exact filename, never recursively scanned.
            for value in os.environ.get("PATH", "").split(os.pathsep)[:256]:
                self.check()
                if value.strip().strip('"'):
                    path = Path(os.path.expandvars(value.strip().strip('"'))).expanduser().absolute()
                    self.record_root(path)
                    self.candidate(path / NATIVE_NAME, "PATH", path)
            value = os.environ.get("LLAMA_CPP_DIR", "").strip().strip('"')
            if value:
                self.walk(Path(os.path.expandvars(value)), "LLAMA_CPP_DIR")
            self.defaults()
        except _Stopped:
            pass
        except (OSError, ValueError) as error:
            self.warning("llama-server 검색 일부를 완료하지 못했습니다: " + str(error)[:200])


def discover_runtimes(*, roots=None, extra_roots=None, cancel_event=None,
                      max_entries=25000, max_depth=6, max_seconds=8):
    """Return {runtimes, roots, warnings}; explicit roots replace platform defaults.

    A daemon worker returns partial results within the wall-time budget even if a
    filesystem metadata call stalls. Cancellation stops future filesystem work
    once any pending OS call returns. Candidates are never executed or downloaded.
    """
    if isinstance(roots, (str, os.PathLike)):
        roots = [roots]
    if isinstance(extra_roots, (str, os.PathLike)):
        extra_roots = [extra_roots]
    roots = None if roots is None else list(roots)
    extra_roots = [] if extra_roots is None else list(extra_roots)
    if len(extra_roots) + (len(roots) if roots is not None else 0) > 64:
        raise ValueError("검색 폴더는 최대 64개입니다.")
    if isinstance(max_entries, bool) or not isinstance(max_entries, int) or not 1 <= max_entries <= 1000000:
        raise ValueError("max_entries must be between 1 and 1000000")
    if isinstance(max_depth, bool) or not isinstance(max_depth, int) or not 0 <= max_depth <= 32:
        raise ValueError("max_depth must be between 0 and 32")
    if isinstance(max_seconds, bool) or not isinstance(max_seconds, (int, float)) or not math.isfinite(max_seconds) or not 0.01 <= max_seconds <= 120:
        raise ValueError("max_seconds must be between 0.01 and 120")
    scan = _Scan(max_entries, max_depth, cancel_event)
    worker = threading.Thread(target=scan.run, args=(roots, extra_roots), daemon=True, name="relay-runtime-scan")
    deadline = time.monotonic() + max_seconds
    worker.start()
    while worker.is_alive():
        remaining = deadline - time.monotonic()
        if remaining <= 0 or (cancel_event is not None and cancel_event.is_set()):
            scan.stop.set()
            scan.warning("llama-server 검색이 중단되었습니다." if remaining > 0 else "llama-server 검색 시간 제한에 도달했습니다. 찾은 항목에서 선택하거나 다시 검색해 주세요.")
            break
        worker.join(min(remaining, 0.05))
    if cancel_event is not None and cancel_event.is_set():
        scan.warning("llama-server 검색이 중단되었습니다.")
    return scan.snapshot()

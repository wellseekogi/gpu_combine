"""Find downloaded Relay connection files without executing or logging their contents.

Configuration values (including credentials) are returned only to the caller in
memory. Validation is delegated to the existing bounded ``read_connection(path)``
callback. File discovery is shallow, bounded, and never follows file symlinks.
"""
import ctypes
import json
import os
from pathlib import Path
import re
import stat
import sys
import threading
import time
import uuid
import hashlib
from itertools import islice

MAX_CONFIG_BYTES = 65536
MAX_XDG_BYTES = 16384
_NAME = re.compile(r"relay-provider-[a-z0-9][a-z0-9_-]{0,79}(?: \([0-9]{1,4}\))?\.json", re.IGNORECASE)
_XDG_LINE = re.compile(r'^\s*XDG_DOWNLOAD_DIR\s*=\s*"([^"\r\n]*)"\s*(?:#.*)?$')


def _path_key(path):
    return os.path.normcase(os.path.abspath(str(path)))


def _windows_downloads():
    """Use the per-user Known Folder location, including redirected Downloads."""
    class GUID(ctypes.Structure):
        _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                    ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]

    folder_id = GUID.from_buffer_copy(uuid.UUID("374DE290-123F-4565-9164-39C4925E467B").bytes_le)
    shell = ctypes.WinDLL("shell32", use_last_error=True)
    allocator = ctypes.WinDLL("ole32", use_last_error=True)
    shell.SHGetKnownFolderPath.argtypes = [ctypes.POINTER(GUID), ctypes.c_uint32,
                                          ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
    shell.SHGetKnownFolderPath.restype = ctypes.c_long
    allocator.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    allocator.CoTaskMemFree.restype = None
    result = ctypes.c_wchar_p()
    try:
        # DONT_VERIFY avoids requiring the folder to exist just to get its path.
        if shell.SHGetKnownFolderPath(ctypes.byref(folder_id), 0x4000, None, ctypes.byref(result)) != 0 or not result.value:
            raise OSError("Known Folder lookup unavailable")
        return Path(result.value)
    finally:
        if result:
            allocator.CoTaskMemFree(ctypes.cast(result, ctypes.c_void_p))


def _xdg_downloads(home):
    config_home = os.environ.get("XDG_CONFIG_HOME")
    config_home = Path(config_home) if config_home and Path(config_home).is_absolute() else home / ".config"
    try:
        with (config_home / "user-dirs.dirs").open("rb") as source:
            raw = source.read(MAX_XDG_BYTES + 1)
    except FileNotFoundError:
        return None
    if len(raw) > MAX_XDG_BYTES:
        raise ValueError("XDG file exceeds limit")
    selected = None
    for line in raw.decode("utf-8").splitlines():
        if not line.lstrip().startswith("XDG_DOWNLOAD_DIR"):
            continue
        match = _XDG_LINE.fullmatch(line)
        if not match:
            raise ValueError("Invalid XDG download entry")
        value = match[1]
        # Deliberately no shell expansion, other variables, command substitution,
        # escape interpretation, or evaluation of user-dirs.dirs as a shell file.
        if not value or any(character in value for character in ("`", "\\", "\x00")):
            raise ValueError("Unsupported XDG download path")
        if value == "$HOME" or value == "${HOME}":
            selected = home
        elif value.startswith(("$HOME/", "${HOME}/")):
            suffix = value.split("/", 1)[1]
            if "$" in suffix:
                raise ValueError("Unsupported XDG download path")
            selected = home / suffix
        else:
            if "$" in value or not Path(value).is_absolute():
                raise ValueError("Unsupported XDG download path")
            selected = Path(value)
    return selected


def default_download_roots():
    """Return per-user download roots plus generic lookup diagnostics for tests."""
    home = Path.home()
    roots = []
    warnings = []
    complete = True
    try:
        if sys.platform == "win32":
            roots.append(_windows_downloads())
        elif sys.platform != "darwin":
            configured = _xdg_downloads(home)
            if configured is not None:
                roots.append(configured)
    except (OSError, ValueError, UnicodeError, AttributeError):
        warnings.append("운영체제의 다운로드 폴더 위치를 확인하지 못했습니다. 폴더를 직접 선택해 주세요.")
        complete = False
    roots.append(home / "Downloads")
    unique = []
    for root in roots:
        if _path_key(root) not in {_path_key(existing) for existing in unique}:
            unique.append(root)
    return {"roots": unique, "warnings": warnings, "complete": complete}


def _regular_file(details):
    # Windows links and cloud placeholders are reparse points. Do not cause a
    # placeholder download, or follow a file link outside this shallow scan.
    return stat.S_ISREG(details.st_mode) and not (getattr(details, "st_file_attributes", 0) & 0x400)


def _signature(details):
    return (details.st_dev, details.st_ino, details.st_size,
            details.st_mtime_ns, details.st_ctime_ns, details.st_mode,
            getattr(details, "st_file_attributes", 0))


class _Stopped(Exception):
    pass


class _Changed(Exception):
    pass


class _Discovery:
    def __init__(self, reader, max_entries, max_candidates, cancel_event):
        self.reader = reader
        self.max_entries = max_entries
        self.max_candidates = max_candidates
        self.cancel_event = cancel_event
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.connections = {}
        self.roots = []
        self.warnings = []
        self.complete = True
        self.entries = 0
        self.candidates = 0
        self.visited_paths = set()

    def warn(self, message, *, incomplete=False):
        with self.lock:
            if message not in self.warnings and len(self.warnings) < 20:
                self.warnings.append(message)
            if incomplete:
                self.complete = False

    def check(self):
        if self.stop.is_set() or (self.cancel_event is not None and self.cancel_event.is_set()):
            self.warn("연결 파일 검색이 중단되었습니다.", incomplete=True)
            raise _Stopped()

    def snapshot(self):
        with self.lock:
            connections = sorted((dict(value) for value in self.connections.values()), key=lambda value: _path_key(value["path"]))
            return {"connections": connections, "roots": list(self.roots),
                    "warnings": list(self.warnings), "complete": self.complete}

    def candidate(self, path, *, known=False):
        self.check()
        path = Path(path).expanduser().absolute()
        key = _path_key(path)
        if key in self.visited_paths:
            return
        self.visited_paths.add(key)
        self.candidates += 1
        if self.candidates > self.max_candidates:
            self.warn("연결 파일 수 제한에 도달했습니다. 필요한 연결 파일을 직접 선택해 주세요.", incomplete=True)
            raise _Stopped()
        try:
            try:
                before = path.lstat()
            except FileNotFoundError:
                if not known:
                    raise
                # A previously imported file may have been moved or deleted.
                # It must not prevent a complete search of the current downloads.
                self.warn("이전에 선택한 연결 파일을 찾지 못했습니다. 다운로드 폴더에서 계속 검색합니다.")
                return
            if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
                return
            if not _regular_file(before):
                self.warn("일부 연결 파일이 로컬에 준비되지 않았습니다. 파일을 직접 선택해 주세요.", incomplete=True)
                return
            if before.st_size > MAX_CONFIG_BYTES:
                self.warn("크기 제한을 초과한 연결 파일은 건너뛰었습니다.")
                return
            self.check()
            try:
                config = self.reader(path)
            finally:
                self.check()
                after = path.lstat()
                if not _regular_file(after) or _signature(before) != _signature(after):
                    raise _Changed()
            if not isinstance(config, dict):
                raise ValueError("Connection reader must return an object")
            canonical = json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
            if len(canonical) > MAX_CONFIG_BYTES:
                raise ValueError("Validated connection exceeds limit")
            fingerprint = hashlib.sha256(canonical).hexdigest()
            record = {"path": str(path), "config": json.loads(canonical), "fingerprint": fingerprint}
            with self.lock:
                previous = self.connections.get(fingerprint)
                if previous is None or _path_key(path) < _path_key(previous["path"]):
                    self.connections[fingerprint] = record
        except _Stopped:
            raise
        except _Changed:
            self.warn("검색 중 변경된 연결 파일이 있습니다. 다시 검색해 주세요.", incomplete=True)
        except OSError:
            self.warn("일부 연결 파일을 읽을 수 없습니다. 파일 접근 권한을 확인해 주세요.", incomplete=True)
        except (ValueError, TypeError, UnicodeError, RecursionError):
            self.warn("올바르지 않은 연결 파일은 건너뛰었습니다.")
        except Exception:
            # Validation callbacks can include credentials in their exceptions.
            # Never include exception text or parsed configuration in diagnostics.
            self.warn("일부 연결 파일을 확인하지 못했습니다. 파일을 직접 선택해 주세요.", incomplete=True)

    def walk(self, root, explicit):
        self.check()
        root = Path(root).expanduser().absolute()
        with self.lock:
            if any(_path_key(root) == _path_key(existing) for existing in self.roots):
                return
            self.roots.append(str(root))
        try:
            with os.scandir(root) as entries:
                for entry in entries:
                    self.check()
                    self.entries += 1
                    if self.entries > self.max_entries:
                        self.warn("검색 항목 수 제한에 도달했습니다. 연결 파일이 있는 폴더를 직접 선택해 주세요.", incomplete=True)
                        raise _Stopped()
                    if not _NAME.fullmatch(entry.name):
                        continue
                    self.candidate(Path(entry.path))
        except FileNotFoundError:
            if explicit:
                self.warn("선택한 다운로드 폴더를 찾지 못했습니다.", incomplete=True)
        except OSError:
            self.warn("일부 다운로드 폴더를 읽을 수 없습니다. 폴더를 직접 선택해 주세요.", incomplete=True)

    def run(self, roots, extra_roots, known_paths):
        try:
            self.check()
            # Only callers' previously selected files bypass the download name
            # filter. Their parent directories are never implicitly scanned.
            for path in known_paths:
                self.candidate(path, known=True)
            # A selected folder remains useful even when another location stalls.
            for root in extra_roots:
                self.walk(root, True)
            if roots is None:
                defaults = default_download_roots()
                for warning in defaults["warnings"]:
                    self.warn(warning, incomplete=not defaults["complete"])
                roots = defaults["roots"]
                explicit = False
            else:
                explicit = True
            for root in roots:
                self.walk(root, explicit)
        except _Stopped:
            pass
        except Exception:
            self.warn("연결 파일 검색 일부를 완료하지 못했습니다. 파일을 직접 선택해 주세요.", incomplete=True)


def discover_connections(read_connection, *, roots=None, extra_roots=(), known_paths=(), max_entries=2000,
                         max_candidates=50, max_seconds=4, cancel_event=None):
    """Return {connections:[{path,config,fingerprint}], roots, warnings, complete}.

    `read_connection(path)` must validate JSON with a maximum input of 64 KiB.
    `roots=` replaces per-user OS defaults for testing/manual targeted searches.
    Only the recognized Relay download names directly inside each root are read.
    `known_paths=` validates up to 64 previously selected files first, regardless
    of filename, sharing the candidate limit without scanning their parents.
    A timed-out OS read can finish later in a daemon thread; no partial result is
    considered complete, and no files or user settings are changed by this module.
    """
    if not callable(read_connection):
        raise ValueError("read_connection must be callable")
    if isinstance(roots, (str, os.PathLike)):
        roots = [roots]
    if isinstance(extra_roots, (str, os.PathLike)):
        extra_roots = [extra_roots]
    if isinstance(known_paths, (str, os.PathLike)):
        known_paths = [known_paths]
    roots = None if roots is None else list(roots)
    extra_roots = list(extra_roots)
    known_paths = list(islice(known_paths, 65))
    if len(known_paths) > 64:
        raise ValueError("이전에 선택한 연결 파일은 최대 64개입니다.")
    if len(extra_roots) + (len(roots) if roots is not None else 0) > 64:
        raise ValueError("검색 폴더는 최대 64개입니다.")
    if isinstance(max_entries, bool) or not isinstance(max_entries, int) or not 1 <= max_entries <= 100000:
        raise ValueError("max_entries must be between 1 and 100000")
    if isinstance(max_candidates, bool) or not isinstance(max_candidates, int) or not 1 <= max_candidates <= 1000:
        raise ValueError("max_candidates must be between 1 and 1000")
    if isinstance(max_seconds, bool) or not isinstance(max_seconds, (int, float)) or not 0.01 <= max_seconds <= 120:
        raise ValueError("max_seconds must be between 0.01 and 120")
    search = _Discovery(read_connection, max_entries, max_candidates, cancel_event)
    worker = threading.Thread(target=search.run, args=(roots, extra_roots, known_paths), daemon=True, name="relay-connection-scan")
    worker.start()
    deadline = time.monotonic() + max_seconds
    while worker.is_alive():
        remaining = deadline - time.monotonic()
        if remaining <= 0 or (cancel_event is not None and cancel_event.is_set()):
            search.stop.set()
            search.warn("연결 파일 검색이 중단되었습니다." if remaining > 0 else "연결 파일 검색 시간이 초과되었습니다. 파일을 직접 선택해 주세요.", incomplete=True)
            break
        worker.join(min(remaining, 0.05))
    return search.snapshot()

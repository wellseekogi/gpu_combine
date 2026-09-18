#!/usr/bin/env python3
"""Verified GitHub release bootstrap for Relay PC setup (Python 3.10+, stdlib).

The downloaded application is installed into immutable per-version directories.
Only the small current.json pointer is replaced; model and user settings paths are
never part of the update. GitHub release publication is the trust boundary.
"""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid
import zipfile


MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_FILES = 2048
NETWORK_TIMEOUT = 8
ARCHIVE_TIMEOUT = 25
GITHUB_HOSTS = {"api.github.com", "github.com", "objects.githubusercontent.com",
                "release-assets.githubusercontent.com", "github-releases.githubusercontent.com"}
REQUIRED_FILES = {"provider/setup_gui.py", "provider/update_launcher.py",
                  "provider/update-config.json", "provider/version.json"}
VERSION_RE = re.compile(r"(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})")
HASH_RE = re.compile(r"[0-9a-f]{64}")


class UpdateError(Exception):
    """A safe, user-facing update error; never includes credentials or response bodies."""


def _version(value):
    if not isinstance(value, str) or VERSION_RE.fullmatch(value) is None:
        raise UpdateError("프로그램 버전 형식이 올바르지 않습니다.")
    return tuple(map(int, value.split(".")))


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise UpdateError("업데이트 정보에 중복 항목이 있습니다.")
        result[key] = value
    return result


def _json(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_JSON_BYTES:
        raise UpdateError("업데이트 정보 크기가 제한을 초과합니다.")
    try:
        return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_object)
    except (UnicodeError, ValueError, RecursionError):
        raise UpdateError("업데이트 정보를 읽을 수 없습니다.") from None


def _read(path, limit=MAX_JSON_BYTES):
    with Path(path).open("rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise UpdateError("로컬 업데이트 정보 크기가 제한을 초과합니다.")
    return raw


def _safe_path(value):
    if (not isinstance(value, str) or not value or len(value) > 240
            or "\\" in value or value.startswith("/") or value.endswith("/")):
        raise UpdateError("업데이트 파일 경로가 올바르지 않습니다.")
    pieces = value.split("/")
    for piece in pieces:
        if (piece in {"", ".", ".."} or piece.endswith((".", " "))
                or any(ord(c) < 32 or c in '<>:"|?*' for c in piece)
                or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])", piece.split(".")[0])):
            raise UpdateError("업데이트 파일 경로가 올바르지 않습니다.")
    return value


def _config(value):
    if not isinstance(value, dict) or value.get("schema") != 1 or isinstance(value.get("schema"), bool):
        raise UpdateError("지원하지 않는 업데이트 설정 형식입니다.")
    repository = value.get("repository")
    prefix = value.get("release_tag_prefix")
    if (not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
            or any(piece in {".", ".."} for piece in repository.split("/"))
            or not isinstance(prefix, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,39}", prefix)):
        raise UpdateError("업데이트 저장소 설정이 올바르지 않습니다.")
    result = {"schema": 1, "repository": repository, "release_tag_prefix": prefix}
    for key in ("manifest_asset", "archive_asset"):
        name = _safe_path(value.get(key))
        if "/" in name:
            raise UpdateError("업데이트 자산 이름이 올바르지 않습니다.")
        result[key] = name
    if result["manifest_asset"] == result["archive_asset"]:
        raise UpdateError("업데이트 자산 이름이 중복됩니다.")
    return result


def _manifest(value, config, external=False):
    fields = {"schema", "version", "repository", "tag", "files"}
    if external:
        fields.add("archive")
    if (not isinstance(value, dict) or set(value) != fields or value.get("schema") != 1
            or isinstance(value.get("schema"), bool)):
        raise UpdateError("지원하지 않는 업데이트 매니페스트입니다.")
    _version(value.get("version"))
    if value.get("repository") != config["repository"] or value.get("tag") != config["release_tag_prefix"] + value["version"]:
        raise UpdateError("업데이트 저장소 또는 릴리스 태그가 일치하지 않습니다.")
    files = value.get("files")
    if not isinstance(files, dict) or not REQUIRED_FILES.issubset(files) or len(files) > MAX_FILES:
        raise UpdateError("업데이트 필수 파일 목록이 올바르지 않습니다.")
    identities = set()
    path_spellings = {}
    for path, digest in files.items():
        _safe_path(path)
        identity = path.casefold()
        if (identity in identities or identity == "provider-manifest.json"
                or not isinstance(digest, str) or HASH_RE.fullmatch(digest) is None):
            raise UpdateError("업데이트 파일 목록이 중복되거나 손상되었습니다.")
        identities.add(identity)
        pieces = path.split("/")
        for index in range(1, len(pieces) + 1):
            spelling = "/".join(pieces[:index])
            existing = path_spellings.setdefault(spelling.casefold(), spelling)
            if existing != spelling:
                raise UpdateError("업데이트 경로의 대소문자가 충돌합니다.")
    for identity in identities:
        pieces = identity.split("/")
        if any("/".join(pieces[:index]) in identities for index in range(1, len(pieces))):
            raise UpdateError("업데이트 파일과 폴더 이름이 충돌합니다.")
    if external:
        archive = value.get("archive")
        if (not isinstance(archive, dict) or set(archive) != {"name", "sha256", "size"}
                or archive.get("name") != config["archive_asset"]
                or not isinstance(archive.get("sha256"), str) or HASH_RE.fullmatch(archive["sha256"]) is None
                or isinstance(archive.get("size"), bool) or not isinstance(archive.get("size"), int)
                or not 0 < archive["size"] <= MAX_ARCHIVE_BYTES):
            raise UpdateError("업데이트 ZIP 검증 정보가 올바르지 않습니다.")
    return value


def _linked(metadata):
    return stat.S_ISLNK(metadata.st_mode) or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)


def _regular_file(root, relative):
    path = root
    pieces = relative.split("/")
    for index, piece in enumerate(pieces):
        path = path / piece
        metadata = path.lstat()
        if _linked(metadata) or (not stat.S_ISDIR(metadata.st_mode) if index < len(pieces) - 1 else not stat.S_ISREG(metadata.st_mode)):
            raise UpdateError("업데이트 파일에 허용되지 않는 링크가 있습니다.")
    return path, metadata.st_size


def _verify_local(root, config, expected_digest=None):
    root = Path(root)
    manifest_path, _ = _regular_file(root, "provider-manifest.json")
    raw = _read(manifest_path)
    manifest_digest = hashlib.sha256(raw).hexdigest()
    if expected_digest is not None and manifest_digest != expected_digest:
        raise UpdateError("설치된 업데이트 매니페스트가 변경되었습니다.")
    manifest = _manifest(_json(raw), config)
    total = 0
    for relative, expected in manifest["files"].items():
        path, size = _regular_file(root, relative)
        total += size
        if size > MAX_FILE_BYTES or total > MAX_EXPANDED_BYTES:
            raise UpdateError("설치 파일 크기가 제한을 초과합니다.")
        if hashlib.sha256(_read(path, MAX_FILE_BYTES)).hexdigest() != expected:
            raise UpdateError("설치 파일 검증에 실패했습니다: " + relative)
    version_info = _json(_read(root / "provider/version.json"))
    if not isinstance(version_info, dict) or version_info.get("version") != manifest["version"]:
        raise UpdateError("설치된 프로그램 버전 정보가 일치하지 않습니다.")
    if _config(_json(_read(root / "provider/update-config.json"))) != config:
        raise UpdateError("설치된 업데이트 설정이 일치하지 않습니다.")
    return {"root": str(root), "version": manifest["version"], "manifest_sha256": manifest_digest}


def _https_url(url):
    if not isinstance(url, str) or len(url) > 16384 or any(ord(c) < 32 for c in url):
        raise UpdateError("업데이트 다운로드 주소가 올바르지 않습니다.")
    try:
        address = urlsplit(url)
        valid = (address.scheme == "https" and address.hostname in GITHUB_HOSTS and address.port in (None, 443)
                 and not address.username and not address.password and not address.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise UpdateError("GitHub HTTPS 주소에서만 업데이트를 받을 수 있습니다.")
    return address


class _GitHubRedirect(HTTPRedirectHandler):
    max_redirections = 5
    max_repeats = 2

    def redirect_request(self, request, fp, code, message, headers, newurl):
        _https_url(newurl)
        redirected = super().redirect_request(request, fp, code, message, headers, newurl)
        if redirected is not None:
            redirected.remove_header("Authorization")
            redirected.remove_header("Proxy-authorization")
        return redirected


def fetch_bytes(url, *, token=None, max_bytes, timeout):
    """Fetch bounded bytes; credentials are attached only to the GitHub API host."""
    address = _https_url(url)
    headers = {"User-Agent": "Relay-Provider-Updater/1", "Accept-Encoding": "identity",
               "Accept": "application/octet-stream" if "/releases/assets/" in address.path else "application/vnd.github+json"}
    request = Request(url, headers=headers)
    if token and address.hostname == "api.github.com":
        request.add_unredirected_header("Authorization", "Bearer " + token)
    deadline = time.monotonic() + timeout
    with build_opener(_GitHubRedirect()).open(request, timeout=timeout) as response:
        _https_url(response.geturl())
        length = response.headers.get("Content-Length")
        if length is not None:
            try:
                if int(length) < 0 or int(length) > max_bytes:
                    raise UpdateError("업데이트 다운로드 크기가 제한을 초과합니다.")
            except ValueError:
                raise UpdateError("업데이트 다운로드 크기 정보가 올바르지 않습니다.") from None
        output = bytearray()
        while True:
            if time.monotonic() >= deadline:
                raise UpdateError("업데이트 다운로드 시간이 초과되었습니다.")
            # HTTPResponse.read1 returns after one underlying read, allowing the
            # wall deadline to be checked even when a peer slowly trickles data.
            reader = getattr(response, "read1", response.read)
            block = reader(min(65536, max_bytes + 1 - len(output)))
            if not block:
                break
            output.extend(block)
            if len(output) > max_bytes:
                raise UpdateError("업데이트 다운로드 크기가 제한을 초과합니다.")
        if length is not None and len(output) != int(length):
            raise UpdateError("업데이트 다운로드가 완전하지 않습니다.")
    return bytes(output)


def _optional_token():
    for name in ("GH_TOKEN", "GITHUB_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value and len(value) <= 4096 and not any(ord(c) < 32 for c in value):
            return value
    try:
        result = subprocess.run(["gh", "auth", "token", "--hostname", "github.com"], capture_output=True,
                                timeout=3, check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        value = result.stdout.decode("utf-8", errors="strict").strip()
        if result.returncode == 0 and value and len(value) <= 4096 and not any(ord(c) < 32 for c in value):
            return value
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        pass
    return None


def _asset_url(asset, config):
    if not isinstance(asset, dict):
        raise UpdateError("업데이트 릴리스 자산 정보가 올바르지 않습니다.")
    url = asset.get("url")
    address = _https_url(url)
    prefix = "/repos/" + config["repository"] + "/releases/assets/"
    if (address.hostname != "api.github.com" or not address.path.startswith(prefix)
            or re.fullmatch(r"[0-9]+", address.path[len(prefix):]) is None or address.query):
        raise UpdateError("업데이트 자산이 지정된 GitHub 저장소에 속하지 않습니다.")
    return url


def _latest_release(raw, config):
    releases = _json(raw)
    if not isinstance(releases, list) or len(releases) > 100:
        raise UpdateError("GitHub 릴리스 목록이 올바르지 않습니다.")
    candidates = []
    for release in releases:
        if not isinstance(release, dict) or release.get("draft") or release.get("prerelease"):
            continue
        tag = release.get("tag_name")
        if not isinstance(tag, str) or not tag.startswith(config["release_tag_prefix"]):
            continue
        version = tag[len(config["release_tag_prefix"]):]
        if VERSION_RE.fullmatch(version):
            candidates.append((_version(version), version, release))
    if not candidates:
        return None
    _, version, release = max(candidates, key=lambda item: item[0])
    assets = release.get("assets")
    if not isinstance(assets, list) or len(assets) > 100:
        raise UpdateError("GitHub 업데이트 자산 목록이 올바르지 않습니다.")
    selected = {}
    for name in (config["manifest_asset"], config["archive_asset"]):
        matches = [asset for asset in assets if isinstance(asset, dict) and asset.get("name") == name]
        if len(matches) != 1:
            raise UpdateError("최신 릴리스의 업데이트 파일이 없거나 중복됩니다.")
        selected[name] = _asset_url(matches[0], config)
    return version, selected


def _archive_entries(raw, external, config):
    archive_info = external["archive"]
    if len(raw) != archive_info["size"] or hashlib.sha256(raw).hexdigest() != archive_info["sha256"]:
        raise UpdateError("업데이트 ZIP 크기 또는 SHA-256 검증에 실패했습니다.")
    expected = {key: value for key, value in external.items() if key != "archive"}
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
        entries = archive.infolist()
        if len(entries) > MAX_FILES * 2 + 1:
            raise UpdateError("업데이트 ZIP 파일 개수가 제한을 초과합니다.")
        seen = set()
        files = {}
        total = 0
        for entry in entries:
            if entry.orig_filename != entry.filename:
                raise UpdateError("업데이트 ZIP에 숨겨진 파일 이름이 있습니다.")
            path = _safe_path(entry.filename[:-1] if entry.is_dir() else entry.filename)
            identity = path.casefold()
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if (identity in seen or entry.flag_bits & 1 or entry.external_attr & 0x400
                    or kind not in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG)):
                raise UpdateError("업데이트 ZIP에 중복 경로, 링크 또는 지원하지 않는 파일이 있습니다.")
            seen.add(identity)
            if entry.is_dir():
                if not any(name.startswith(path + "/") for name in expected["files"]):
                    raise UpdateError("업데이트 ZIP에 목록에 없는 폴더가 있습니다.")
                continue
            if path != "provider-manifest.json" and path not in expected["files"]:
                raise UpdateError("업데이트 ZIP에 목록에 없는 파일이 있습니다.")
            total += entry.file_size
            if entry.file_size > MAX_FILE_BYTES or total > MAX_EXPANDED_BYTES:
                raise UpdateError("업데이트 ZIP 압축 해제 크기가 제한을 초과합니다.")
            files[path] = entry
        if set(files) != set(expected["files"]) | {"provider-manifest.json"}:
            raise UpdateError("업데이트 ZIP 필수 파일이 누락되었습니다.")
        if files["provider-manifest.json"].file_size > MAX_JSON_BYTES:
            raise UpdateError("업데이트 ZIP 매니페스트 크기가 제한을 초과합니다.")
        internal = _manifest(_json(archive.read(files["provider-manifest.json"])), config)
        if internal != expected:
            raise UpdateError("다운로드한 매니페스트와 ZIP 내부 정보가 다릅니다.")
        return archive, files
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError):
        raise UpdateError("업데이트 ZIP을 읽을 수 없습니다.") from None


def _cache_default():
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local"))) / "Relay/provider-app"
    return Path.home() / ".local/share/relay/provider-app"


def _pointer_entry(value):
    if not isinstance(value, dict) or set(value) != {"version", "directory", "manifest_sha256"}:
        raise UpdateError("업데이트 캐시 포인터가 올바르지 않습니다.")
    _version(value["version"])
    directory = value["directory"]
    digest = value["manifest_sha256"]
    if (not isinstance(directory, str) or not re.fullmatch(r"versions/" + re.escape(value["version"]) + r"-[0-9a-f]{16}-[0-9a-f]{8}", directory)
            or not isinstance(digest, str) or HASH_RE.fullmatch(digest) is None):
        raise UpdateError("업데이트 캐시 경로가 올바르지 않습니다.")
    return value


def _cached(cache, config, warnings):
    candidates = []
    versions = []
    try:
        pointer = _json(_read(cache / "current.json"))
        if not isinstance(pointer, dict) or pointer.get("schema") != 1:
            raise UpdateError("업데이트 캐시 포인터 형식이 올바르지 않습니다.")
        for key in ("current", "previous"):
            value = pointer.get(key)
            if value is None:
                continue
            try:
                value = _pointer_entry(value)
                versions.append(_version(value["version"]))
                root = cache.joinpath(*value["directory"].split("/"))
                if _linked(root.lstat()) or _linked(root.parent.lstat()):
                    raise UpdateError("업데이트 캐시 폴더가 링크로 변경되었습니다.")
                selected = _verify_local(root, config, value["manifest_sha256"])
                if selected["version"] != value["version"]:
                    raise UpdateError("업데이트 캐시 버전이 일치하지 않습니다.")
                selected.update(source="cache", pointer=value)
                candidates.append(selected)
            except (OSError, UpdateError):
                warnings.append("저장된 업데이트 파일 검증에 실패해 다른 정상 버전을 확인합니다.")
    except FileNotFoundError:
        pass
    except (OSError, UpdateError):
        warnings.append("업데이트 캐시 정보를 읽지 못했습니다. 기본 프로그램을 확인합니다.")
    return candidates, versions


@contextlib.contextmanager
def _update_lock(cache, timeout=5):
    cache.mkdir(parents=True, exist_ok=True)
    stream = (cache / "update.lock").open("a+b")
    locked = False
    try:
        stream.seek(0, os.SEEK_END)
        if not stream.tell():
            stream.write(b"0")
            stream.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise UpdateError("다른 설정 창에서 업데이트 중입니다. 현재 정상 버전을 실행합니다.") from None
                time.sleep(0.05)
        yield
    finally:
        if locked:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def _atomic_pointer(cache, current, previous):
    value = {"schema": 1, "current": current, "previous": previous}
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".current-", suffix=".json", dir=cache, delete=False) as output:
            temporary = Path(output.name)
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, cache / "current.json")
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def _install(raw, external, config, cache, previous):
    archive, entries = _archive_entries(raw, external, config)
    staging = Path(tempfile.mkdtemp(prefix=".install-", dir=cache))
    try:
        with archive:
            for relative, entry in entries.items():
                destination = staging.joinpath(*relative.split("/"))
                destination.parent.mkdir(parents=True, exist_ok=True)
                data = archive.read(entry)
                if len(data) != entry.file_size:
                    raise UpdateError("업데이트 ZIP 파일 크기가 일치하지 않습니다.")
                if relative != "provider-manifest.json" and hashlib.sha256(data).hexdigest() != external["files"][relative]:
                    raise UpdateError("업데이트 ZIP 내부 파일 검증에 실패했습니다: " + relative)
                destination.write_bytes(data)
        selected = _verify_local(staging, config)
        versions = cache / "versions"
        versions.mkdir(exist_ok=True)
        if _linked(versions.lstat()):
            raise UpdateError("업데이트 캐시 폴더가 링크입니다.")
        name = selected["version"] + "-" + selected["manifest_sha256"][:16] + "-" + uuid.uuid4().hex[:8]
        destination = versions / name
        os.rename(staging, destination)
        current = {"version": selected["version"], "directory": "versions/" + name,
                   "manifest_sha256": selected["manifest_sha256"]}
        _atomic_pointer(cache, current, previous)
        selected.update(root=str(destination), source="cache", pointer=current)
        return selected
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError):
        raise UpdateError("업데이트 ZIP 압축 해제에 실패했습니다.") from None
    finally:
        # Only remove the uniquely named staging folder created by this attempt.
        if staging.parent.resolve() == cache.resolve() and staging.name.startswith(".install-") and staging.exists():
            shutil.rmtree(staging)


def _failure_message(error):
    if isinstance(error, UpdateError):
        return str(error)
    if isinstance(error, HTTPError):
        return f"업데이트 서버 요청에 실패했습니다(HTTP {error.code}). 현재 정상 버전을 사용합니다."
    return "업데이트를 확인하지 못했습니다. 인터넷 연결 후 다시 실행하면 재시도합니다."


def update_and_select(bundle_root=None, cache_root=None, *, fetch=None, token=None, check_updates=True):
    """Verify, optionally update, and return {root, version, source, updated, warnings}.

    ``fetch(url, *, token, max_bytes, timeout) -> bytes`` can be injected for tests.
    No GUI, model process, credentials file, or user preference is launched/written.
    """
    bundle = Path(bundle_root or Path(__file__).resolve().parents[1]).absolute()
    if not (bundle / "provider-manifest.json").exists():
        if (bundle / ".git").exists() and (bundle / "provider/setup_gui.py").is_file():
            return {"root": str(bundle), "version": "development", "source": "development", "updated": False, "warnings": []}
        raise UpdateError("설치 매니페스트가 없습니다. 최초 설치 ZIP의 모든 파일을 압축 해제해 주세요.")
    config = _config(_json(_read(bundle / "provider/update-config.json")))
    cache = Path(cache_root or _cache_default()).absolute()
    fetch = fetch or fetch_bytes
    warnings = []
    candidates = []
    floor = []
    try:
        bundled_manifest = _manifest(_json(_read(bundle / "provider-manifest.json")), config)
        floor.append(_version(bundled_manifest["version"]))
        bundled = _verify_local(bundle, config)
        bundled.update(source="bundled", pointer=None)
        candidates.append(bundled)
    except (OSError, UpdateError):
        warnings.append("기본 프로그램의 파일 검증에 실패해 저장된 정상 버전을 확인합니다.")
    cached, known_versions = _cached(cache, config, warnings)
    candidates.extend(cached)
    floor.extend(known_versions)
    selected = max(candidates, key=lambda item: _version(item["version"])) if candidates else None
    updated = False
    if check_updates:
        try:
            with _update_lock(cache):
                # Another launch may have updated the atomic pointer while we waited.
                cached, known_versions = _cached(cache, config, warnings)
                floor.extend(known_versions)
                choices = cached + ([selected] if selected else [])
                selected = max(choices, key=lambda item: _version(item["version"])) if choices else None
                auth = token

                def download(url, limit, timeout=NETWORK_TIMEOUT):
                    nonlocal auth
                    try:
                        raw = fetch(url, token=auth, max_bytes=limit, timeout=timeout)
                    except HTTPError as error:
                        if auth or error.code not in (401, 403, 404):
                            raise
                        auth = _optional_token()
                        if not auth:
                            raise
                        raw = fetch(url, token=auth, max_bytes=limit, timeout=timeout)
                    if not isinstance(raw, bytes) or len(raw) > limit:
                        raise UpdateError("업데이트 다운로드 크기가 제한을 초과합니다.")
                    return raw

                release = _latest_release(download("https://api.github.com/repos/" + config["repository"] + "/releases?per_page=100", MAX_JSON_BYTES), config)
                if release is not None:
                    version, assets = release
                    minimum = max(floor, default=(0, 0, 0))
                    if _version(version) < minimum:
                        warnings.append("서버 버전이 현재 설치보다 낮아 업데이트하지 않았습니다.")
                    elif selected is None or _version(version) > _version(selected["version"]):
                        external = _manifest(_json(download(assets[config["manifest_asset"]], MAX_JSON_BYTES)), config, external=True)
                        if external["version"] != version:
                            raise UpdateError("릴리스 버전과 매니페스트 버전이 일치하지 않습니다.")
                        raw = download(assets[config["archive_asset"]], external["archive"]["size"], ARCHIVE_TIMEOUT)
                        selected = _install(raw, external, config, cache, selected.get("pointer") if selected else None)
                        updated = True
        except (OSError, UpdateError, URLError, TimeoutError, ValueError) as error:
            warnings.append(_failure_message(error))
    if selected is None:
        raise UpdateError("실행할 수 있는 정상 프로그램 파일을 찾지 못했습니다. 최초 설치 ZIP을 다시 압축 해제해 주세요.")
    return {"root": selected["root"], "version": selected["version"], "source": selected["source"],
            "updated": updated, "warnings": list(dict.fromkeys(warnings))}


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    check_only = "--check-only" in arguments
    arguments = [argument for argument in arguments if argument != "--check-only"]
    try:
        try:
            local = update_and_select(check_updates=False)
        except (OSError, UpdateError):
            # A damaged offline payload can still be repaired by a verified
            # release. The normal path below revalidates all bootstrap settings.
            local = None
        own_root = Path(__file__).resolve().parents[1]
        selected_root = Path(local["root"]).resolve() if local else own_root
        if local and local["source"] == "cache" and selected_root != own_root:
            # A verified newer bootstrap takes over on the next launch. Its own
            # bundled root equals the selected cache, so this does not recurse.
            return subprocess.call([sys.executable, str(selected_root / "provider/update_launcher.py"),
                                    *list(sys.argv[1:] if argv is None else argv)])
        result = update_and_select()
        for warning in result["warnings"]:
            print("Relay: " + warning, file=sys.stderr)
        if result["updated"]:
            print("Relay PC setup updated to " + result["version"] + ".")
        if check_only:
            print(json.dumps(result, ensure_ascii=True))
            return 0
        return subprocess.call([sys.executable, str(Path(result["root"]) / "provider/setup_gui.py"), *arguments])
    except (OSError, UpdateError) as error:
        print("Relay: " + _failure_message(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

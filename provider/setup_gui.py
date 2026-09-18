#!/usr/bin/env python3
"""Relay participant setup. Python 3.10+, with the standard-library Tk UI.

Connection files contain coordinator, pool, node, token, context and optionally
model ({digest or modelDigest, runtime, template, context}). They never choose
executables: participants select every local runtime/model/template themselves.
"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import webbrowser
from types import SimpleNamespace
from urllib.parse import urlsplit, urlunsplit

_spec = importlib.util.spec_from_file_location("relay_provider_runtime", Path(__file__).with_name("provider.py"))
runtime = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runtime)
MAX_CONFIG_BYTES = 65536
EVENT_PREFIX = "RELAY_UI "
_discovery_spec = importlib.util.spec_from_file_location("relay_model_discovery", Path(__file__).with_name("model_discovery.py"))
model_discovery = importlib.util.module_from_spec(_discovery_spec)
sys.modules[_discovery_spec.name] = model_discovery
_discovery_spec.loader.exec_module(model_discovery)
_metadata_spec = importlib.util.spec_from_file_location("relay_gguf_metadata", Path(__file__).with_name("gguf_metadata.py"))
gguf_metadata = importlib.util.module_from_spec(_metadata_spec)
sys.modules[_metadata_spec.name] = gguf_metadata
_metadata_spec.loader.exec_module(gguf_metadata)
_connection_spec = importlib.util.spec_from_file_location("relay_connection_discovery", Path(__file__).with_name("connection_discovery.py"))
connection_discovery = importlib.util.module_from_spec(_connection_spec)
sys.modules[_connection_spec.name] = connection_discovery
_connection_spec.loader.exec_module(connection_discovery)
_runtime_spec = importlib.util.spec_from_file_location("relay_runtime_discovery", Path(__file__).with_name("runtime_discovery.py"))
runtime_discovery = importlib.util.module_from_spec(_runtime_spec)
sys.modules[_runtime_spec.name] = runtime_discovery
_runtime_spec.loader.exec_module(runtime_discovery)


def integer(value, label, minimum, maximum):
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]+", str(value)):
        raise ValueError(f"{label}: 정수를 입력해 주세요.")
    number = int(value)
    if not minimum <= number <= maximum:
        raise ValueError(f"{label}: {minimum:,}~{maximum:,} 범위로 입력해 주세요.")
    return number


def service_address(value):
    """Validate an address independently of credentials for first-use web help."""
    if (not isinstance(value, str) or not value.strip() or len(value) > 4096
            or any(ord(character) < 32 for character in value) or "\\" in value):
        raise ValueError("서비스 주소를 확인해 주세요.")
    value = value.strip()
    try:
        address = urlsplit(value)
        port = address.port
    except ValueError:
        raise ValueError("서비스 주소를 확인해 주세요.") from None
    if (not address.hostname or address.username or address.password or address.query or address.fragment
            or (port is not None and port == 0)
            or not (address.scheme == "https" or (address.scheme == "http" and address.hostname in {"127.0.0.1", "localhost", "::1"}))):
        raise ValueError("원격 서비스는 HTTPS 주소가 필요합니다. 로컬 서비스만 HTTP를 사용할 수 있습니다.")
    return value.rstrip("/")


def web_console_url(coordinator):
    address = urlsplit(service_address(coordinator))
    return urlunsplit((address.scheme, address.netloc, "/", "", "connect-pc"))


def connection_config(data):
    """Validate a downloaded connection file; deliberately discard local paths."""
    if not isinstance(data, dict):
        raise ValueError("연결 파일의 형식이 올바르지 않습니다.")
    result = {}
    for key, label in (("coordinator", "서비스 주소"), ("pool", "풀 ID"), ("node", "참여 PC ID"), ("token", "참여 키")):
        value = data.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > 4096 or any(ord(c) < 32 for c in value):
            raise ValueError(f"{label} 값이 없거나 올바르지 않습니다.")
        result[key] = value.strip()
    result["coordinator"] = service_address(result["coordinator"])
    if "nodeName" in data:
        name = data["nodeName"]
        if (not isinstance(name, str) or not name.strip() or len(name.strip()) > 80
                or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in name)):
            raise ValueError("PC 이름의 형식이 올바르지 않습니다.")
        result["nodeName"] = name.strip()
    result["context"] = integer(data.get("context", 8192), "컨텍스트", 4096, 131072)
    model = data.get("model", data.get("contract"))
    if model is not None:
        if not isinstance(model, dict):
            raise ValueError("모델 검증 정보의 형식이 올바르지 않습니다.")
        expected = {"modelDigest": model.get("modelDigest", model.get("digest")),
                    "runtime": model.get("runtime"), "template": model.get("template")}
        if any(not isinstance(v, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", v) for v in expected.values()):
            raise ValueError("모델 검증 정보에는 세 파일의 SHA-256 값이 필요합니다.")
        expected = {k: v.lower() for k, v in expected.items()}
        expected["context"] = integer(model.get("context", result["context"]), "모델 컨텍스트", 4096, 131072)
        if expected["context"] != result["context"]:
            raise ValueError("연결 파일과 모델의 컨텍스트가 일치하지 않습니다.")
        result["model"] = expected
    return result


def read_connection(path):
    with open(path, "rb") as source:
        raw = source.read(MAX_CONFIG_BYTES + 1)
    if len(raw) > MAX_CONFIG_BYTES:
        raise ValueError("연결 파일이 너무 큽니다.")
    try:
        return connection_config(json.loads(raw.decode("utf-8-sig")))
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError("올바른 JSON 연결 파일을 선택해 주세요.") from None


PREFERENCE_PATHS = {"server": "llama-server", "model": "GGUF 모델", "template": "채팅 템플릿", "connection_file": "연결 파일", "search_folder": "모델 검색 폴더", "connection_folder": "연결 파일 검색 폴더", "runtime_search_folder": "실행기 검색 폴더"}


def preferences_path():
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        return (Path(local) if local else Path.home() / "AppData" / "Local") / "Relay" / "provider-setup.json"
    return Path.home() / ".config" / "relay" / "provider-setup.json"


def preference_values(data):
    """Persist only local file paths, never connection data or runtime credentials."""
    result = {}
    for key in PREFERENCE_PATHS:
        value = data.get(key)
        if (isinstance(value, str) and value and len(value) <= 32767
                and not any(ord(character) < 32 for character in value)):
            path = Path(value).expanduser()
            if path.is_absolute():
                result[key] = str(path)
    return result


def save_preferences(data, path=None):
    destination = Path(path) if path is not None else preferences_path()
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, **preference_values(data)}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent,
                                         prefix=".provider-setup-", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            json.dump(payload, output, ensure_ascii=False, indent=2)
        temporary.replace(destination)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def load_preferences(path=None, *, preserve_missing_connection=False, check_paths=True):
    destination = Path(path) if path is not None else preferences_path()
    try:
        with destination.open("rb") as source:
            raw = source.read(MAX_CONFIG_BYTES + 1)
        if len(raw) > MAX_CONFIG_BYTES:
            raise ValueError("preferences too large")
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("unknown preferences")
        chosen = preference_values(data)
    except FileNotFoundError:
        return {}, []
    except (OSError, ValueError, UnicodeError):
        return {}, ["이전 파일 선택을 불러오지 못했습니다. 연결 파일과 모델 파일을 다시 선택해 주세요."]
    if not check_paths:
        return chosen, []
    restored, notices = {}, []
    for key, value in chosen.items():
        try:
            available = Path(value).is_dir() if key in {"search_folder", "connection_folder", "runtime_search_folder"} else Path(value).is_file()
        except OSError:
            available = False
        if available:
            restored[key] = value
        else:
            if key == "connection_file" and preserve_missing_connection:
                restored[key] = value
            notices.append(PREFERENCE_PATHS[key] + "을 찾을 수 없습니다. 파일을 다시 선택해 주세요.")
    if len(chosen) != sum(key in data for key in PREFERENCE_PATHS):
        notices.append("저장된 파일 경로 일부가 올바르지 않습니다. 해당 파일을 다시 선택해 주세요.")
    return restored, notices


def bounded_read(read, timeout=4):
    """Keep an offline redirected folder from blocking the UI indefinitely."""
    result = queue.Queue(maxsize=1)
    def inspect():
        try:
            result.put((read(), None))
        except Exception as exc:
            result.put((None, exc))
    threading.Thread(target=inspect, daemon=True).start()
    try:
        value, error = result.get(timeout=timeout)
    except queue.Empty:
        raise TimeoutError("파일 위치의 응답이 늦습니다. 연결 폴더를 확인한 뒤 다시 선택하세요.") from None
    if error:
        raise error
    return value


def prepare_model_template(model_path, destination, timeout=20):
    """Bound a potentially unavailable WSL file read; late results cannot write."""
    result = queue.Queue(maxsize=1)
    def read():
        try:
            result.put((gguf_metadata.read_chat_template(model_path), None))
        except Exception as exc:
            result.put((None, exc))
    threading.Thread(target=read, daemon=True).start()
    try:
        template, error = result.get(timeout=timeout)
    except queue.Empty:
        raise ValueError("모델 파일 응답이 늦습니다. WSL과 파일 위치를 확인한 뒤 다시 선택하세요.") from None
    if error:
        raise error
    if not template:
        return None
    raw = template.encode("utf-8")
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / (hashlib.sha256(raw).hexdigest() + ".jinja")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination, prefix=".template-", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            output.write(raw)
        temporary.replace(target)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    return str(target)


def local_files(data):
    result = {}
    for key, label in (("server", "llama-server 실행 파일"), ("model", "GGUF 모델"), ("template", "채팅 템플릿")):
        path = Path(data.get(key, "")).expanduser()
        if not path.is_file():
            raise ValueError(f"{label}을 선택해 주세요.")
        result[key] = str(path.resolve())
    return result


def compute_contract(files, context):
    files = local_files(files)
    return {"version": 1, "modelDigest": runtime.digest_file(files["model"]),
            "runtime": runtime.digest_file(files["server"]),
            "template": runtime.digest_file(files["template"]),
            "context": integer(context, "컨텍스트", 4096, 131072)}


def match_contract(actual, expected):
    if not expected:
        return
    labels = {"modelDigest": "GGUF 모델", "runtime": "llama-server", "template": "채팅 템플릿", "context": "컨텍스트"}
    mismatch = [label for key, label in labels.items() if actual.get(key) != expected.get(key)]
    if mismatch:
        raise ValueError("서비스에 등록된 설정과 다릅니다: " + ", ".join(mismatch))


class WindowsJob:
    """Own the worker and descendants, including when the GUI is closed abruptly."""
    def __init__(self, process):
        import ctypes
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.SetInformationJobObject.restype = wintypes.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits))
                or not self.kernel.AssignProcessToJobObject(self.handle, wintypes.HANDLE(process._handle))):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def close(self):
        handle, self.handle = self.handle, None
        if handle:
            self.kernel.CloseHandle(handle)


class WorkerProcess:
    def __init__(self, messages):
        self.messages = messages
        self.process = None
        self.job = None

    @property
    def running(self):
        return self.process is not None and self.process.poll() is None

    def start(self, config, files, port, gpu_layers):
        if self.running:
            raise RuntimeError("이미 참여 중입니다.")
        config = connection_config(config)
        files = local_files(files)
        payload = {"connection": config, "files": files,
                   "port": integer(port, "로컬 포트", 1024, 65535),
                   "gpu_layers": integer(gpu_layers, "GPU 레이어", 0, 999)}
        # The token goes only through stdin, never through arguments or a saved file.
        options = {"stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT,
                   "text": True, "encoding": "utf-8", "errors": "replace", "bufsize": 1, "shell": False}
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        else:
            options["start_new_session"] = True
        executable = Path(sys.executable)
        if executable.name.lower() == "pythonw.exe":
            executable = executable.with_name("python.exe")
        process = subprocess.Popen([str(executable), "-u", str(Path(__file__).resolve()), "--worker"], **options)
        self.process = process
        try:
            # The worker blocks on stdin until it belongs to the cleanup job.
            self.job = WindowsJob(process) if os.name == "nt" else None
            process.stdin.write(json.dumps(payload) + "\n")
            process.stdin.flush()
        except Exception:
            if self.job:
                self.job.close()
                self.job = None
            process.kill()
            process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()
            raise
        threading.Thread(target=self._read, args=(process, config["token"], self.job), daemon=True).start()

    def _read(self, process, token, job):
        try:
            for line in process.stdout:
                self.messages.put(("log", line.rstrip().replace(token, "[참여 키 숨김]")))
            code = process.wait()
        finally:
            if job:
                job.close()
            process.stdout.close()
            process.stdin.close()
        self.messages.put(("exit", code))

    def stop(self):
        process = self.process
        if not process or process.poll() is not None:
            return
        try:
            process.stdin.write("stop\n")
            process.stdin.flush()
        except (OSError, ValueError):
            pass
        threading.Thread(target=self._finish_stop, args=(process, self.job), daemon=True).start()

    def _finish_stop(self, process, job):
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if job:
                job.close()
            elif os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()


def worker_main():
    def event(status):
        print(EVENT_PREFIX + json.dumps({"status": status}, ensure_ascii=False), flush=True)

    class GuiProvider(runtime.Provider):
        def api(self, action, payload):
            result = super().api(action, payload)
            if result.get("paused"):
                event("서비스에서 참여를 일시정지했습니다")
            elif action == "submit" or (action == "poll" and not result.get("task") and self.lease is None):
                event("연결됨 · 작업 대기 중")
            return result

        def start_runtime(self):
            if self.process is None:
                event("모델을 GPU에 불러오는 중…")
            return super().start_runtime()

        def infer(self, task):
            event("문서를 처리하는 중…")
            return super().infer(task)

    class HiddenSubprocess:
        DEVNULL = subprocess.DEVNULL
        TimeoutExpired = subprocess.TimeoutExpired

        @staticmethod
        def Popen(*args, **kwargs):
            if os.name == "nt":
                kwargs["creationflags"] = kwargs.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
            return subprocess.Popen(*args, **kwargs)

    try:
        payload = json.loads(sys.stdin.readline(MAX_CONFIG_BYTES + 1))
        connection = connection_config(payload["connection"])
        files = local_files(payload["files"])
        args = SimpleNamespace(**files, context=connection["context"],
                               port=integer(payload["port"], "로컬 포트", 1024, 65535),
                               gpu_layers=integer(payload["gpu_layers"], "GPU 레이어", 0, 999),
                               coordinator=connection["coordinator"], pool=connection["pool"],
                               node=connection["node"], once=False)
        runtime.subprocess = HiddenSubprocess
        event("선택한 파일을 검증하는 중…")
        provider = GuiProvider(args)
        provider.token = connection["token"]
        match_contract({**provider.contract, "context": args.context}, connection.get("model"))

        def watch_parent():
            # End of pipe also means the GUI exited. Stop only our own runtime.
            sys.stdin.readline()
            provider.stop = True

        threading.Thread(target=watch_parent, daemon=True).start()
        event("서비스에 연결하는 중…")
        provider.run()
        return 0
    except Exception as exc:
        # Validation messages are safe; network/runtime details never include credentials.
        message = str(exc) if isinstance(exc, ValueError) else "연결 또는 실행에 실패했습니다. 참여 키, 서비스 주소와 선택한 파일을 확인해 주세요."
        event(message)
        return 1


def gui_main(initial_config=None):
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    from tkinter.scrolledtext import ScrolledText

    root = tk.Tk()
    root.title("Relay · 모델 찾기 및 GPU 참여 설정")
    root.geometry("820x700")
    root.minsize(680, 600)
    style = ttk.Style(root)
    if "clam" in style.theme_names():
        style.theme_use("clam")
    style.configure("TFrame", background="#f4f6fa")
    style.configure("TLabel", background="#f4f6fa", font=("Malgun Gothic", 10))
    style.configure("Title.TLabel", font=("Malgun Gothic", 21, "bold"), foreground="#142b39")
    style.configure("TButton", padding=(10, 7), font=("Malgun Gothic", 10))
    style.configure("TLabelframe", background="#f4f6fa", padding=14)
    style.configure("TLabelframe.Label", background="#f4f6fa", font=("Malgun Gothic", 11, "bold"))
    body = ttk.Frame(root, padding=24)
    body.pack(fill="both", expand=True)
    body.columnconfigure(0, weight=1)
    ttk.Label(body, text="내 GPU로 함께하기", style="Title.TLabel").grid(sticky="w")
    ttk.Label(body, text="이미 받은 모델을 자동으로 찾아 드립니다. 목록에서 선택하거나 저장한 폴더를 추가하세요.", wraplength=720).grid(sticky="w", pady=(5, 16))
    form_holder = ttk.Frame(body)
    form_holder.grid(sticky="nsew", pady=(0, 12))
    form_holder.rowconfigure(0, weight=1)
    form_holder.columnconfigure(0, weight=1)
    form_canvas = tk.Canvas(form_holder, background="#f4f6fa", highlightthickness=0, height=340)
    form_canvas.grid(row=0, column=0, sticky="nsew")
    form_scroll = ttk.Scrollbar(form_holder, orient="vertical", command=form_canvas.yview)
    form_scroll.grid(row=0, column=1, sticky="ns")
    form_canvas.configure(yscrollcommand=form_scroll.set)
    form = ttk.Frame(form_canvas)
    form.columnconfigure(0, weight=1)
    form_window = form_canvas.create_window(0, 0, anchor="nw", window=form)
    form.bind("<Configure>", lambda _: form_canvas.configure(scrollregion=form_canvas.bbox("all")))
    form_canvas.bind("<Configure>", lambda event: form_canvas.itemconfigure(form_window, width=event.width))

    def scroll_form(event):
        if str(event.widget).startswith(str(form)) or event.widget == form_canvas:
            form_canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")
    root.bind("<MouseWheel>", scroll_form)
    body.rowconfigure(2, weight=1)
    messages = queue.Queue()
    worker = WorkerProcess(messages)
    variables = {key: tk.StringVar(value=value) for key, value in {
        "coordinator": "http://127.0.0.1:8788", "pool": "local-owner", "node": "", "token": "",
        "server": "", "model": "", "template": "", "context": "8192", "port": "8081", "gpu_layers": "99"}.items()}
    state = {"expected": None, "contract": None, "busy": False, "closing": False, "stopping": False, "connection_file": "", "importing": False, "search_folder": "", "discovering": False, "discovered": {}, "discovery_cancel": threading.Event()}
    state.update({"connection_folder": "", "connection_scanning": False, "connection_candidates": [],
                  "connection_manual": False, "connection_scan_warnings": (), "connection_generation": 0,
                  "connection_auto_watch": True, "connection_restore_failed": False})
    state.update({"runtime_searching": False, "runtime_candidates": [], "runtime_search_folder": "", "preferences_restore_failed": False})
    editable = []

    def values(*keys):
        return {key: variables[key].get() for key in keys}

    def connection():
        data = values("coordinator", "pool", "node", "token", "context")
        if state["expected"]:
            data["model"] = state["expected"]
        return connection_config(data)

    def remember_selection():
        try:
            save_preferences({**values("server", "model", "template"), "connection_file": state["connection_file"], "search_folder": state["search_folder"], "connection_folder": state["connection_folder"], "runtime_search_folder": state["runtime_search_folder"]})
            return True
        except (OSError, ValueError):
            notice = "파일 선택을 저장하지 못했습니다. 현재 참여는 가능하며 다음 실행 때 파일을 다시 선택해 주세요."
            status.set(notice)
            append_log(notice)
            return False

    def apply_connection(config, path, *, restoring=False, automatic=False):
        state["importing"] = True
        try:
            for key in ("coordinator", "pool", "node", "token", "context"):
                variables[key].set(config[key])
        finally:
            state["importing"] = False
        state["expected"] = config.get("model")
        state["connection_file"] = str(Path(path).absolute())
        state["connection_manual"] = False
        state["connection_restore_failed"] = False
        label = config.get("nodeName") or config["node"][:48]
        connection_summary.set(("자동으로 불러옴 · " if automatic else "불러옴 · ") + config["coordinator"] + " · " + label)
        status.set("연결 정보를 불러왔습니다. 준비되면 ‘검사하고 참여 시작’을 눌러 주세요."
                   if all(variables[key].get() for key in ("server", "model", "template"))
                   else "연결 정보를 불러왔습니다. 이 PC의 모델 파일을 선택해 주세요.")
        if not restoring:
            remember_selection()
        return True

    def import_config(path=None, restoring=False):
        path = path or filedialog.askopenfilename(title="Relay 연결 파일 선택", filetypes=[("Relay 연결 파일", "*.json")])
        if not path:
            return
        state["busy"] = True
        lock(True)
        status.set("연결 파일을 확인하는 중…")
        def read():
            try:
                config = bounded_read(lambda: read_connection(path))
                messages.put(("connection-import", (config, path, restoring, None)))
            except Exception:
                messages.put(("connection-import", (None, path, restoring,
                    "연결 파일을 읽지 못했습니다. 파일 위치와 내용을 확인하고 목록에서 사용할 연결을 선택하세요.")))
        threading.Thread(target=read, daemon=True).start()

    def open_web_setup():
        try:
            address = web_console_url(variables["coordinator"].get())
            if not webbrowser.open(address):
                raise OSError("browser unavailable")
            status.set("웹에서 모델 승인 → PC 등록 → 연결 설정 저장을 누르세요. 다운로드가 끝나면 이 창에서 자동으로 찾습니다.")
        except ValueError as exc:
            messagebox.showerror("서비스 주소 확인", str(exc), parent=root)
        except OSError:
            messagebox.showerror("웹 설정 열기", "브라우저를 열지 못했습니다. 고급 설정에 표시된 서비스 주소를 브라우저에서 열어 주세요.", parent=root)

    group = ttk.LabelFrame(form, text="2  Relay에 이 PC 연결하기", name="connection_setup")
    group.grid(row=2, column=0, sticky="ew", pady=(0, 12))
    group.columnconfigure(0, weight=1)
    connection_summary = tk.StringVar(value="웹에서 받은 연결 파일을 다운로드 폴더에서 자동으로 찾습니다.")
    connection_summary_label = ttk.Label(group, textvariable=connection_summary, wraplength=620)
    connection_summary_label.grid(row=0, column=0, sticky="ew", pady=(0, 8))
    connection_search_status = tk.StringVar(value="연결 파일을 확인하는 중…")
    connection_status_label = ttk.Label(group, textvariable=connection_search_status, wraplength=620, name="connection_discovery_status")
    connection_status_label.grid(row=1, column=0, sticky="ew")
    connection_picker = ttk.Combobox(group, state="disabled", name="connection_candidates")
    connection_picker.grid(row=2, column=0, sticky="ew", pady=8)
    connection_actions = ttk.Frame(group)
    connection_actions.grid(row=3, column=0, sticky="ew")

    def update_connection_controls(_event=None):
        locked = state["busy"] or worker.running or state["closing"]
        count = len(state["connection_candidates"])
        connection_picker.configure(state="readonly" if count and not locked else "disabled")
        use_connection_button.configure(state="normal" if 0 <= connection_picker.current() < count and not locked else "disabled")
        connection_folder_button.configure(state="disabled" if locked else "normal")
        connection_refresh_button.configure(state="disabled" if locked or state["connection_scanning"] else "normal")

    def choose_connection():
        index = connection_picker.current()
        if state["busy"] or worker.running or state["closing"] or not 0 <= index < len(state["connection_candidates"]):
            return
        candidate = state["connection_candidates"][index]
        # The background scanner validated this immutable snapshot. No WSL/network
        # file access or credential logging occurs on the Tk event thread here.
        apply_connection(candidate["config"], candidate["path"])
        connection_search_status.set("선택한 연결 정보를 불러왔습니다. ‘검사하고 참여 시작’을 눌러야 실행됩니다.")

    def scan_connections():
        if state["closing"] or state["connection_scanning"] or state["busy"] or worker.running:
            return
        state["connection_scanning"] = True
        update_connection_controls()
        extra = [state["connection_folder"]] if state["connection_folder"] else []
        generation = state["connection_generation"]
        def inspect():
            try:
                result = connection_discovery.discover_connections(read_connection, extra_roots=extra,
                                                                   cancel_event=state["discovery_cancel"])
            except Exception:
                result = {"connections": [], "roots": [], "complete": False,
                          "warnings": ["연결 파일을 확인하지 못했습니다. 연결 폴더를 선택하거나 파일을 직접 불러오세요."]}
            messages.put(("connections", (generation, result)))
        threading.Thread(target=inspect, daemon=True).start()

    def choose_connection_folder():
        path = filedialog.askdirectory(title="연결 파일을 다운로드한 폴더 선택")
        if path:
            state["connection_folder"] = path
            state["connection_generation"] += 1
            remember_selection()
            scan_connections()

    use_connection_button = ttk.Button(connection_actions, text="선택한 연결 사용", name="use_connection", command=choose_connection, state="disabled")
    use_connection_button.pack(side="left")
    connection_refresh_button = ttk.Button(connection_actions, text="연결 다시 찾기", name="refresh_connection", command=scan_connections)
    connection_refresh_button.pack(side="left", padx=6)
    connection_folder_button = ttk.Button(connection_actions, text="연결 폴더 선택", command=choose_connection_folder)
    connection_folder_button.pack(side="left")
    connection_picker.bind("<<ComboboxSelected>>", update_connection_controls)
    manual_actions = ttk.Frame(group)
    manual_actions.grid(row=4, column=0, sticky="ew", pady=(8, 0))
    import_button = ttk.Button(manual_actions, text="연결 파일 불러오기", command=import_config)
    import_button.pack(side="left")
    editable.append(import_button)
    ttk.Button(manual_actions, text="연결 파일이 없나요? 웹 설정 열기", command=open_web_setup).pack(side="left", padx=6)
    help_label = ttk.Label(group, text="연결 파일에는 Relay 주소, PC 정보, 비밀 참여 키가 들어 있습니다. 웹에서 PC 등록 → ‘연결 설정 저장’을 누르면 자동으로 감지합니다. 여러 연결이 있으면 서비스 주소와 PC 이름을 보고 선택하세요. 다른 폴더에 저장했다면 ‘연결 폴더 선택’을 누르세요.", wraplength=620)
    help_label.grid(row=5, column=0, sticky="ew", pady=(8, 0))
    def wrap_connection(event):
        for label in (connection_summary_label, connection_status_label, help_label):
            label.configure(wraplength=max(300, event.width - 35))
    group.bind("<Configure>", wrap_connection)

    def watch_connections():
        if state["closing"]:
            return
        if state["connection_auto_watch"]:
            scan_connections()
        root.after(3000, watch_connections)

    discovery_group = ttk.LabelFrame(form, text="1  이 컴퓨터에 저장된 모델")
    discovery_group.grid(row=0, column=0, sticky="ew", pady=(0, 12))
    discovery_group.columnconfigure(0, weight=1)
    discovery_summary = tk.StringVar(value="Windows와 WSL의 모델 저장 위치를 확인하고 있습니다…")
    ttk.Label(discovery_group, textvariable=discovery_summary, wraplength=650).grid(row=0, column=0, sticky="w", pady=(0, 8))
    model_tree = ttk.Treeview(discovery_group, columns=("format", "size", "availability"), show="tree headings", height=4, selectmode="browse")
    model_tree.heading("#0", text="모델")
    model_tree.heading("format", text="형식")
    model_tree.heading("size", text="용량")
    model_tree.heading("availability", text="사용 방법")
    model_tree.column("#0", width=220, minwidth=150, stretch=True)
    model_tree.column("format", width=100, minwidth=90, stretch=False)
    model_tree.column("size", width=70, minwidth=65, stretch=False)
    model_tree.column("availability", width=125, minwidth=100, stretch=False)
    model_tree.grid(row=1, column=0, sticky="ew")
    list_scroll = ttk.Scrollbar(discovery_group, orient="vertical", command=model_tree.yview)
    list_scroll.grid(row=1, column=1, sticky="ns")
    model_tree.configure(yscrollcommand=list_scroll.set)
    discovery_detail = tk.StringVar(value="전체 모델 파일을 복사하거나 새로 다운로드하지 않고 저장 위치와 형식을 확인합니다.")
    detail_label = ttk.Label(discovery_group, textvariable=discovery_detail, wraplength=650)
    detail_label.grid(row=2, column=0, columnspan=2, sticky="ew", pady=8)
    discovery_group.bind("<Configure>", lambda event: detail_label.configure(wraplength=max(300, event.width - 35)))
    discovery_actions = ttk.Frame(discovery_group)
    discovery_actions.grid(row=3, column=0, columnspan=2, sticky="ew")

    def selected_discovery():
        selection = model_tree.selection()
        return state["discovered"].get(selection[0]) if selection else None

    def update_model_selection(_event=None):
        model = selected_discovery()
        usable = model and model.get("complete") and model.get("compatible")
        choose_model_button.configure(state="normal" if usable and not state["busy"] and not worker.running else "disabled")
        folder_button.configure(state="normal" if model else "disabled")
        if not model:
            return
        explanation = ("선택하면 모델 경로가 입력되고 내장 채팅 템플릿도 준비됩니다. llama-server 실행파일을 확인한 뒤 파일 검사를 진행하세요."
                       if usable else
                       "모델 파일은 찾았습니다. 이 모델은 vLLM/Transformers용이며 현재 Relay의 GGUF 실행기에서 바로 실행할 수 없습니다. GGUF 변환 또는 vLLM 실행기 연동이 필요합니다."
                       if model.get("complete") and model.get("format") == "huggingface" else
                       "이 모델 구성은 현재 실행기에서 지원하지 않습니다. 아래 상세 이유를 확인하세요."
                       if model.get("complete") else
                       "다운로드가 끝나지 않았거나 필요한 파일이 빠져 있습니다. 누락 파일을 확인하세요.")
        issues = " · ".join(str(issue) for issue in model.get("issues", [])[:3])
        discovery_detail.set(model["path"] + "\n" + explanation + ("\n" + issues if issues else ""))

    def choose_discovered_model():
        model = selected_discovery()
        if not model or not model.get("complete") or not model.get("compatible") or state["busy"] or worker.running:
            return
        chosen_path = model["path"]
        variables["model"].set(chosen_path)
        state["busy"] = True
        lock(True)
        status.set("선택한 모델의 내장 템플릿을 확인하는 중… 모델 가중치는 읽지 않습니다.")
        if not variables["server"].get():
            discover_runtimes()
        def prepare_template():
            try:
                template_path = prepare_model_template(chosen_path, preferences_path().parent / "templates")
                messages.put(("model-template", (chosen_path, template_path, None)))
            except (OSError, ValueError) as exc:
                messages.put(("model-template", (chosen_path, None, str(exc))))
            except Exception:
                messages.put(("model-template", (chosen_path, None, "내장 템플릿을 읽지 못했습니다. 모델에 맞는 템플릿을 직접 선택하세요.")))
        threading.Thread(target=prepare_template, daemon=True).start()
        form_canvas.yview_moveto(0.36)

    def show_model_folder():
        model = selected_discovery()
        if not model:
            return
        folder = Path(model["path"])
        if not folder.is_dir():
            folder = folder.parent
        try:
            if not folder.is_dir():
                raise OSError()
            if os.name == "nt":
                os.startfile(str(folder))
            else:
                subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(folder)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            messagebox.showerror("폴더 열기", "폴더를 열지 못했습니다. 모델 위치를 확인하고 다시 찾아 주세요.", parent=root)

    def discover():
        if state["discovering"] or state["closing"]:
            return
        state["discovering"] = True
        search_button.configure(state="disabled")
        add_folder_button.configure(state="disabled")
        discovery_summary.set("저장된 모델을 찾는 중… Windows 캐시와 WSL을 함께 확인합니다.")
        extra = [state["search_folder"]] if state["search_folder"] else []
        def inspect():
            try:
                result = model_discovery.discover_models(extra_roots=extra, cancel_event=state["discovery_cancel"])
                messages.put(("discovery", result))
            except Exception:
                messages.put(("discovery", {"models": [], "roots": [], "warnings": ["모델 위치를 읽지 못했습니다. 저장한 폴더를 직접 추가하고 다시 찾아 주세요."]}))
        threading.Thread(target=inspect, daemon=True).start()

    def add_model_folder():
        path = filedialog.askdirectory(title="모델이 저장된 폴더 선택 (WSL 폴더도 가능)")
        if path:
            state["search_folder"] = path
            remember_selection()
            discover()

    choose_model_button = ttk.Button(discovery_actions, text="이 모델 선택", command=choose_discovered_model, state="disabled")
    choose_model_button.pack(side="left")
    search_button = ttk.Button(discovery_actions, text="다시 찾기", command=discover)
    search_button.pack(side="left", padx=6)
    add_folder_button = ttk.Button(discovery_actions, text="폴더 추가", command=add_model_folder)
    add_folder_button.pack(side="left")
    folder_button = ttk.Button(discovery_actions, text="모델 폴더 열기", command=show_model_folder, state="disabled")
    folder_button.pack(side="left", padx=6)
    model_tree.bind("<<TreeviewSelect>>", update_model_selection)
    model_tree.bind("<Double-1>", lambda _event: choose_discovered_model())

    files_group = ttk.LabelFrame(form, text="선택한 GGUF 모델의 실행 준비")
    files_group.grid(row=1, column=0, sticky="ew", pady=(0, 12))
    files_group.columnconfigure(1, weight=1)

    def choose_file(key):
        kinds = {"server": [("실행 파일", "*.exe"), ("모든 파일", "*")],
                 "model": [("GGUF 모델", "*.gguf"), ("모든 파일", "*")],
                 "template": [("템플릿", "*.jinja *.j2 *.txt"), ("모든 파일", "*")]}
        path = filedialog.askopenfilename(title="사용할 파일 선택", filetypes=kinds[key])
        if path:
            variables[key].set(path)
            remember_selection()

    ttk.Label(files_group, text="llama-server").grid(row=0, column=0, sticky="w", padx=(0, 12), pady=6)
    runtime_picker = ttk.Combobox(files_group, name="runtime_candidates", state="disabled", width=40)
    runtime_picker.grid(row=0, column=1, sticky="ew")
    runtime_summary = tk.StringVar(value="설치된 llama-server를 자동으로 찾습니다…")
    runtime_summary_label = ttk.Label(files_group, name="runtime_summary", textvariable=runtime_summary, wraplength=650)
    runtime_summary_label.grid(row=1, column=0, columnspan=3, sticky="ew", pady=(2, 6))
    ttk.Label(files_group, text="선택된 실행기").grid(row=2, column=0, sticky="w", padx=(0, 12))
    server_entry = ttk.Entry(files_group, name="setting_server", textvariable=variables["server"], state="readonly")
    server_entry.grid(row=2, column=1, columnspan=2, sticky="ew")
    runtime_actions = ttk.Frame(files_group)
    runtime_actions.grid(row=3, column=0, columnspan=3, sticky="ew", pady=6)

    def select_runtime(_event=None):
        index = runtime_picker.current()
        if state["busy"] or worker.running or state["closing"] or not 0 <= index < len(state["runtime_candidates"]):
            return
        candidate = state["runtime_candidates"][index]
        variables["server"].set(candidate["path"])
        remember_selection()
        runtime_summary.set("실행기를 선택했습니다. 모델과 템플릿을 확인한 뒤 ‘파일 검사’를 누르세요.")

    def update_runtime_controls():
        locked = state["busy"] or worker.running or state["closing"]
        candidates = state["runtime_candidates"]
        runtime_picker.configure(state="readonly" if candidates and not locked and not state["runtime_searching"] else "disabled")
        runtime_refresh_button.configure(state="disabled" if locked or state["runtime_searching"] else "normal")
        runtime_folder_button.configure(state="disabled" if locked or state["runtime_searching"] else "normal")
        server_entry.configure(state="disabled" if locked else "readonly")
        if (len(candidates) == 1 and not variables["server"].get() and not locked
                and not state["runtime_searching"] and not state["preferences_restore_failed"]):
            runtime_picker.current(0)
            select_runtime()
            runtime_summary.set("llama-server 1개를 찾아 자동으로 선택했습니다. ‘파일 검사’로 확인하세요.")

    def discover_runtimes():
        if state["runtime_searching"] or state["closing"] or worker.running:
            return
        state["runtime_searching"] = True
        runtime_summary.set("llama-server를 찾는 중… 설치 위치와 다운로드·프로젝트 폴더를 확인합니다.")
        update_runtime_controls()
        extra = [state["runtime_search_folder"]] if state["runtime_search_folder"] else []
        current = variables["server"].get()
        if current:
            extra.append(str(Path(current).parent))
        if variables["model"].get():
            extra.append(str(Path(variables["model"].get()).parent))
        def inspect():
            try:
                result = runtime_discovery.discover_runtimes(extra_roots=extra, cancel_event=state["discovery_cancel"])
                messages.put(("runtimes", result))
            except Exception:
                messages.put(("runtimes", {"runtimes": [], "roots": [], "warnings": ["실행기 검색을 완료하지 못했습니다. ‘다시 찾기’를 눌러 주세요."]}))
        threading.Thread(target=inspect, daemon=True).start()

    def add_runtime_folder():
        path = filedialog.askdirectory(title="llama-server 검색 범위에 추가할 폴더")
        if path:
            state["runtime_search_folder"] = path
            remember_selection()
            discover_runtimes()

    runtime_refresh_button = ttk.Button(files_group, name="refresh_runtime", text="다시 찾기", command=discover_runtimes)
    runtime_refresh_button.grid(row=0, column=2, padx=(8, 0))
    runtime_folder_button = ttk.Button(runtime_actions, name="add_runtime_folder", text="검색 폴더 추가", command=add_runtime_folder)
    runtime_folder_button.pack(side="left")
    ttk.Label(runtime_actions, text="  목록에서 선택하면 실행기 경로가 자동 입력됩니다.").pack(side="left")
    runtime_picker.bind("<<ComboboxSelected>>", select_runtime)
    files_group.bind("<Configure>", lambda event: runtime_summary_label.configure(wraplength=max(300, event.width - 35)))

    for row, (key, label) in enumerate((("model", "GGUF 모델"), ("template", "채팅 템플릿")), start=4):
        ttk.Label(files_group, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=6)
        entry = ttk.Entry(files_group, name="setting_" + key, textvariable=variables[key])
        entry.grid(row=row, column=1, sticky="ew")
        button = ttk.Button(files_group, text="찾아보기", command=lambda k=key: choose_file(k))
        button.grid(row=row, column=2, padx=(8, 0))
        editable.extend((entry, button))
    ttk.Label(files_group, text="목록에서 모델을 선택하면 내장 템플릿이 자동 입력됩니다. 자동으로 찾은 llama-server를 목록에서 선택하고 ‘파일 검사’를 누르세요. 연결 파일은 아직 없어도 됩니다.\n검사가 끝나면 ‘모델 검증 파일 저장’을 눌러 웹에서 승인할 파일을 만드세요.", wraplength=650).grid(row=6, column=0, columnspan=3, sticky="w", pady=(10, 0))

    settings = ttk.Frame(form)
    settings.grid(row=3, column=0, sticky="ew", pady=(0, 8))
    settings.columnconfigure(0, weight=1)
    advanced = ttk.Frame(settings, padding=(4, 12))
    advanced.grid(row=1, column=0, sticky="ew")
    advanced.columnconfigure(1, weight=1)

    def toggle_advanced():
        if advanced.winfo_manager():
            advanced.grid_remove()
            advanced_button.configure(text="고급 설정 ▸")
        else:
            advanced.grid()
            advanced_button.configure(text="고급 설정 ▾")

    advanced_button = ttk.Button(settings, text="고급 설정 ▸", command=toggle_advanced)
    advanced_button.grid(row=0, column=0, sticky="w")
    for row, (key, label) in enumerate((("coordinator", "서비스 주소"), ("pool", "풀 ID"),
                                       ("node", "참여 PC ID"), ("token", "참여 키"),
                                       ("context", "컨텍스트"), ("port", "로컬 포트"), ("gpu_layers", "GPU 레이어"))):
        ttk.Label(advanced, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=5)
        entry = ttk.Entry(advanced, name="setting_" + key, textvariable=variables[key], show="●" if key == "token" else "")
        entry.grid(row=row, column=1, sticky="ew")
        editable.append(entry)
    advanced.grid_remove()

    status = tk.StringVar(value="연결 파일 없이 시작하세요. 위 목록에서 모델 선택 → 실행파일 확인 → 파일 검사.")
    status_label = ttk.Label(body, textvariable=status, wraplength=720, foreground="#176548")
    status_label.grid(sticky="ew", pady=(0, 12))
    body.bind("<Configure>", lambda event: status_label.configure(wraplength=max(300, event.width - 48)))
    actions = ttk.Frame(body)
    actions.grid(sticky="ew", pady=(0, 12))

    def lock(locked):
        for widget in editable:
            widget.configure(state="disabled" if locked else "normal")
        scan_button.configure(state="disabled" if locked else "normal")
        start_button.configure(state="disabled" if locked else "normal")
        export_button.configure(state="normal" if state["contract"] and not locked else "disabled")
        stop_button.configure(state="normal" if worker.running and not state["stopping"] else "disabled")
        update_model_selection()
        update_connection_controls()
        update_runtime_controls()

    def scan():
        try:
            files = local_files(values("server", "model", "template"))
            context = integer(variables["context"].get(), "컨텍스트", 4096, 131072)
        except ValueError as exc:
            messagebox.showerror("파일 선택 확인", str(exc), parent=root)
            return
        state["busy"] = True
        lock(True)
        status.set("파일 지문을 계산하는 중… 큰 모델은 수 분이 걸릴 수 있습니다.")

        def calculate():
            try:
                contract = compute_contract(files, context)
                match_contract(contract, state["expected"])
                messages.put(("contract", contract))
            except Exception as exc:
                messages.put(("error", str(exc)))
        threading.Thread(target=calculate, daemon=True).start()

    def export():
        path = filedialog.asksaveasfilename(title="모델 검증 파일 저장", initialfile="relay-model-contract.json", defaultextension=".json", filetypes=[("JSON", "*.json")])
        if path:
            try:
                Path(path).write_text(json.dumps(state["contract"], ensure_ascii=False, indent=2), encoding="utf-8")
                status.set("모델 검증 파일을 저장했습니다. ‘웹 설정 열기’에서 모델 승인 → PC 등록 → 연결 설정 저장을 진행하세요.")
            except OSError:
                messagebox.showerror("저장 실패", "저장할 폴더와 파일 권한을 확인해 주세요.", parent=root)

    def start():
        try:
            worker.start(connection(), values("server", "model", "template"), variables["port"].get(), variables["gpu_layers"].get())
            state["stopping"] = False
            status.set("파일 검증과 GPU 준비를 시작합니다…")
            remember_selection()
            lock(True)
        except (ValueError, OSError, RuntimeError) as exc:
            messagebox.showerror("참여 시작 확인", str(exc), parent=root)

    def stop():
        state["stopping"] = True
        status.set("참여를 중지하고 GPU를 정리하는 중…")
        lock(True)
        worker.stop()

    scan_button = ttk.Button(actions, text="파일 검사", command=scan)
    scan_button.pack(side="left")
    export_button = ttk.Button(actions, text="모델 검증 파일 저장", command=export, state="disabled")
    export_button.pack(side="left", padx=8)
    stop_button = ttk.Button(actions, text="참여 중지", command=stop, state="disabled")
    stop_button.pack(side="right")
    start_button = ttk.Button(actions, text="검사하고 참여 시작", command=start)
    start_button.pack(side="right", padx=8)
    ttk.Label(body, text="실행 기록").grid(sticky="w", pady=(0, 6))
    log = ScrolledText(body, height=3, font=("Malgun Gothic", 9), relief="flat", state="disabled", wrap="word")
    log.grid(sticky="nsew")
    ttk.Label(body, text="이 창을 닫으면 참여와 모델 실행이 함께 종료됩니다.").grid(sticky="w", pady=(10, 0))

    def invalidate(*_):
        state["contract"] = None
        export_button.configure(state="disabled")

    for key in ("model", "server", "template", "context"):
        variables[key].trace_add("write", invalidate)

    def manual_connection_changed(key, *_):
        if not state["importing"]:
            if key == "context" and not state["connection_file"] and not variables["node"].get() and not variables["token"].get():
                return
            state["connection_manual"] = True
            state["connection_file"] = ""
            connection_summary.set("수동 연결 정보 사용 중 · 참여 키는 저장되지 않아 다음 실행 때 다시 입력해야 합니다.")

    for key in ("coordinator", "pool", "node", "token", "context"):
        variables[key].trace_add("write", lambda *args, field=key: manual_connection_changed(field, *args))

    def append_log(text):
        log.configure(state="normal")
        log.insert("end", text + "\n")
        if int(log.index("end-1c").split(".")[0]) > 300:
            log.delete("1.0", "100.0")
        log.see("end")
        log.configure(state="disabled")

    def receive():
        try:
            while True:
                kind, value = messages.get_nowait()
                if kind == "restore-preferences":
                    preferences, notices, problem = value
                    if problem:
                        state["preferences_restore_failed"] = True
                        state["connection_manual"] = True
                        state["connection_restore_failed"] = True
                        state["busy"] = False
                        status.set(problem)
                        append_log(problem)
                        lock(False)
                        discover()
                        discover_runtimes()
                        continue
                    # With check_paths=False, notices mean the preference file could
                    # not be read or parsed. Do not autosave an empty replacement.
                    state["preferences_restore_failed"] = bool(notices)
                    state["search_folder"] = preferences.get("search_folder", "")
                    state["connection_folder"] = preferences.get("connection_folder", "")
                    state["runtime_search_folder"] = preferences.get("runtime_search_folder", "")
                    for key in ("server", "model", "template"):
                        if key in preferences:
                            variables[key].set(preferences[key])
                    for notice in notices:
                        append_log(notice)
                    discover()
                    discover_runtimes()
                    previous_connection = initial_config or preferences.get("connection_file")
                    if previous_connection:
                        state["connection_file"] = str(Path(previous_connection).absolute())
                        state["connection_manual"] = True
                        import_config(previous_connection, restoring=True)
                    else:
                        state["busy"] = False
                        lock(False)
                        scan_connections()
                elif kind == "connection-import":
                    config, path, restoring, problem = value
                    state["busy"] = False
                    if config is not None:
                        apply_connection(config, path, restoring=restoring)
                        if restoring and initial_config:
                            remember_selection()
                    else:
                        if restoring:
                            state["connection_restore_failed"] = True
                        status.set(problem)
                        append_log(problem)
                    lock(False)
                elif kind == "connections":
                    generation, value = value
                    state["connection_scanning"] = False
                    if generation != state["connection_generation"]:
                        update_connection_controls()
                        scan_connections()
                        continue
                    # A stalled redirected folder must not create a new blocked
                    # daemon every few seconds. Explicit refresh can retry.
                    state["connection_auto_watch"] = bool(value.get("complete"))
                    previous_index = connection_picker.current()
                    previous = (state["connection_candidates"][previous_index]["fingerprint"]
                                if 0 <= previous_index < len(state["connection_candidates"]) else None)
                    candidates = value.get("connections", [])
                    state["connection_candidates"] = candidates
                    labels = [(c["config"].get("nodeName") or c["config"]["node"][:36]) + " · " +
                              c["config"]["coordinator"] + " · " + Path(c["path"]).name for c in candidates]
                    connection_picker.configure(values=labels)
                    chosen = next((i for i, c in enumerate(candidates) if c["fingerprint"] == previous), -1)
                    if chosen >= 0:
                        connection_picker.current(chosen)
                    else:
                        connection_picker.set("")
                    existing = bool(state["connection_file"] or state["connection_manual"] or variables["node"].get() or variables["token"].get())
                    if value.get("complete") and len(candidates) == 1 and not existing and not state["busy"] and not worker.running:
                        candidate = candidates[0]
                        apply_connection(candidate["config"], candidate["path"], automatic=True)
                        connection_picker.current(0)
                        connection_search_status.set("연결 파일을 자동으로 불러왔습니다. ‘검사하고 참여 시작’을 눌러야 실행됩니다.")
                    elif not value.get("complete"):
                        connection_search_status.set("일부 위치를 확인하지 못해 자동 검색을 잠시 멈췄습니다. 연결 폴더를 선택하거나 ‘연결 다시 찾기’를 누르세요.")
                    elif state["connection_restore_failed"]:
                        connection_search_status.set("이전에 선택한 연결을 불러오지 못했습니다. 사용할 연결을 목록에서 선택하세요.")
                    elif len(candidates) > 1:
                        connection_search_status.set(f"서로 다른 연결 {len(candidates)}개를 찾았습니다. 사용할 서비스와 PC를 선택하세요.")
                    elif existing:
                        connection_search_status.set("현재 연결 정보를 유지합니다. 다른 연결을 쓰려면 목록에서 직접 선택하세요."
                                                     if candidates else "현재 연결 정보를 사용합니다. 새 다운로드도 자동으로 확인합니다.")
                    else:
                        connection_search_status.set("새 연결 파일을 기다립니다. 웹에서 ‘연결 설정 저장’을 누르면 자동으로 감지합니다.")
                    warnings = tuple(value.get("warnings", [])[:3])
                    if warnings != state["connection_scan_warnings"]:
                        for warning in warnings:
                            append_log("연결 파일 탐색: " + warning)
                    state["connection_scan_warnings"] = warnings
                    update_connection_controls()
                elif kind == "runtimes":
                    state["runtime_searching"] = False
                    candidates = value.get("runtimes", [])
                    state["runtime_candidates"] = candidates
                    runtime_picker.configure(values=[candidate["name"] + " · " + candidate["path"] for candidate in candidates])
                    current = variables["server"].get()
                    selected = next((index for index, candidate in enumerate(candidates)
                                     if os.path.normcase(candidate["path"]) == os.path.normcase(current)), -1)
                    if selected >= 0:
                        runtime_picker.current(selected)
                    else:
                        runtime_picker.set("")
                    if current:
                        runtime_summary.set(f"현재 실행기 선택을 유지합니다. 발견된 {len(candidates)}개 중 다른 실행기를 선택할 수 있습니다."
                                            if candidates else "이전에 선택한 실행기를 유지합니다. ‘파일 검사’로 파일 상태를 확인하세요.")
                    elif candidates:
                        runtime_summary.set(f"llama-server {len(candidates)}개를 찾았습니다. 목록에서 사용할 실행기를 선택하세요.")
                    else:
                        runtime_summary.set("llama-server를 찾지 못했습니다. 설치 파일이 ZIP이라면 먼저 모두 압축을 푼 뒤 ‘다시 찾기’를 누르세요. 다른 위치는 ‘검색 폴더 추가’로 찾을 수 있습니다.")
                    for warning in value.get("warnings", [])[:5]:
                        append_log("실행기 탐색: " + str(warning))
                    update_runtime_controls()
                elif kind == "discovery":
                    state["discovering"] = False
                    search_button.configure(state="normal")
                    add_folder_button.configure(state="normal")
                    previous = selected_discovery()
                    model_tree.delete(*model_tree.get_children())
                    state["discovered"] = {}
                    candidates = sorted(value.get("models", []), key=lambda model: ("qwen" not in model["name"].lower(), model["name"].lower()))
                    for index, model in enumerate(candidates):
                        key = str(index)
                        state["discovered"][key] = model
                        size = model.get("size_bytes", 0)
                        size_label = f"{size / (1024 ** 3):.1f} GB" if size >= 1024 ** 3 else f"{size / (1024 ** 2):.0f} MB"
                        format_label = {"gguf": "GGUF", "huggingface": "Transformers", "ollama": "Ollama GGUF"}.get(model.get("format"), "확인 필요")
                        availability = ("선택 가능" if model.get("complete") and model.get("compatible") else
                                        "vLLM / 변환 필요" if model.get("complete") and model.get("format") == "huggingface" else
                                        "구성 미지원" if model.get("complete") else "파일 확인 필요")
                        model_tree.insert("", "end", iid=key, text=model["name"], values=(format_label, size_label, availability))
                    discovery_summary.set(f"모델 {len(candidates)}개를 찾았습니다. 목록에서 모델을 선택해 저장 위치와 실행 방식을 확인하세요."
                                          if candidates else "기본 위치에서 모델을 찾지 못했습니다. ‘폴더 추가’로 저장한 위치를 알려 주세요.")
                    if candidates:
                        selected_key = next((key for key, model in state["discovered"].items() if previous and model["path"] == previous["path"]), "0")
                        model_tree.selection_set(selected_key)
                        model_tree.see(selected_key)
                    else:
                        discovery_detail.set("WSL은 설치된 배포판의 캐시와 모델 폴더를 확인합니다. 사용자 지정 경로는 ‘폴더 추가’로 탐색할 수 있습니다.")
                    update_model_selection()
                    for warning in value.get("warnings", [])[:8]:
                        append_log("모델 탐색: " + str(warning))
                elif kind == "model-template":
                    chosen_path, template_path, problem = value
                    state["busy"] = False
                    if variables["model"].get() == chosen_path:
                        variables["template"].set(template_path or "")
                        remember_selection()
                        status.set("모델과 내장 템플릿이 준비되었습니다. 자동으로 찾은 llama-server 목록을 확인한 뒤 파일 검사를 누르세요."
                                   if template_path else "내장 템플릿을 준비하지 못했습니다. 로그를 확인하거나 모델에 맞는 템플릿을 직접 선택하세요."
                                   if problem else "모델을 선택했습니다. 내장 템플릿이 없어 모델에 맞는 템플릿을 직접 선택해야 합니다.")
                        if problem:
                            append_log(problem)
                    lock(False)
                elif kind == "contract":
                    state["contract"] = value
                    state["busy"] = False
                    status.set("파일 검사가 완료됐습니다. ‘검사하고 참여 시작’을 눌러 주세요."
                               if variables["node"].get() and variables["token"].get()
                               else "파일 검사가 완료됐습니다. ‘모델 검증 파일 저장’을 누른 뒤 웹에서 모델 승인과 PC 등록을 진행하세요.")
                    lock(False)
                elif kind == "error":
                    state["busy"] = False
                    status.set(value)
                    append_log(value)
                    lock(False)
                elif kind == "exit":
                    if state["stopping"] or value == 0:
                        status.set("참여가 중지되었습니다. 실행 프로세스가 종료되었습니다.")
                    else:
                        append_log("실행이 종료되었습니다. 위 안내를 확인하고 다시 시작하세요.")
                    lock(False)
                elif kind == "log":
                    if value.startswith(EVENT_PREFIX):
                        try:
                            value = json.loads(value[len(EVENT_PREFIX):])["status"]
                            if not state["stopping"]:
                                status.set(value)
                        except (ValueError, KeyError):
                            continue
                    elif value.startswith("Provider recovery:"):
                        status.set("연결 또는 모델 실행을 다시 시도하는 중… 주소, 파일, GPU 메모리를 확인하세요.")
                    append_log(value)
        except queue.Empty:
            pass
        if state["closing"] and not worker.running:
            root.destroy()
            return
        root.after(120, receive)

    def close():
        state["discovery_cancel"].set()
        remember_selection()
        state["closing"] = True
        if worker.running:
            stop()
        else:
            root.destroy()

    def restore_selection():
        state["busy"] = True
        lock(True)
        status.set("이전 파일 선택과 연결 정보를 확인하는 중…")
        def restore():
            try:
                # Restore path strings first. Existence checks on disconnected
                # WSL/UNC folders belong to later bounded background work.
                preferences, notices = bounded_read(lambda: load_preferences(check_paths=False))
                messages.put(("restore-preferences", (preferences, notices, None)))
            except Exception:
                messages.put(("restore-preferences", ({}, [],
                    "이전 설정 위치를 읽지 못했습니다. 사용할 연결을 목록에서 직접 선택하세요.")))
        threading.Thread(target=restore, daemon=True).start()

    root.protocol("WM_DELETE_WINDOW", close)
    root.after(120, receive)
    root.after(50, restore_selection)
    root.after(400, watch_connections)
    root.mainloop()


if __name__ == "__main__":
    if "--worker" in sys.argv:
        if sys.stdout is not None:
            sys.stdout.reconfigure(encoding="utf-8")
        raise SystemExit(worker_main())
    gui_main(sys.argv[1] if len(sys.argv) > 1 else None)

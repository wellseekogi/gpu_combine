# AWS Relay 실제 GPU 실행·검증 — 다른 컴퓨터의 Codex에게 전달할 지침서

작성일: 2026-09-19. **이 MD 한 파일을 참여자 컴퓨터의 Codex에 전달한다.** 프로젝트 저장소나 원래 개발 PC가 없어도 AWS 사이트에서 참여자 프로그램을 받아 진행한다. 기본 설명은 Windows + NVIDIA 기준이며, 다른 OS/GPU는 실제 장치에 맞는 실행기와 계측으로 대체한다.

## 0. 사용자가 할 일

다른 컴퓨터에서 작업할 빈 폴더를 열고 Codex에 이 파일을 첨부한 뒤 아래 문장을 보낸다.

> 이 파일을 실행 지침서로 사용해서 지금 컴퓨터의 실제 GPU에 모델 가중치를 올리고, AWS 사이트에서 요청한 작업을 이 컴퓨터가 처리하는지 검증해 줘. 설명에서 멈추지 말고 설치·실행·계측·결과 확인·정리까지 진행하고 보고서를 만들어 줘.

서비스 주소는 **<https://gpu-together.3.38.50.72.sslip.io>**다. 회원 복구 파일이 있으면 같은 컴퓨터의 비공개 폴더에 두고 경로만 알려준다. 비밀키를 대화에 붙이지 않는다. 기존 계정이 없어도 테스트용 제공자·이용자 계정을 각각 하나씩 만들 수 있다.

현재 작성 환경에서는 이 주소의 HTTPS 연결이 거부되었다. 이는 다른 PC에서의 검사 결과가 아니며 서버가 준비된 뒤 다시 확인해야 한다. **실제 원격 GPU 검증은 아직 NOT RUN이다.** 아래 절차가 그 검증을 수행한다.

## 1. 이 파일을 읽는 Codex의 임무

지금 컴퓨터를 **B(실제 GPU 참여자)**, 위 HTTPS 사이트를 **A(AWS 중앙 서버)**로 부른다. A는 웹·계정·작업 배정·결과 검증·정산을 담당하고 B의 전용 llama-server가 모델을 적재하여 추론한다. 브라우저 접속만으로 가중치가 GPU에 올라가지는 않는다.

다음을 실제 수행하라.

1. A의 HTTPS와 API를 확인하고 B의 OS·Python·GPU·메모리·디스크를 조사한다.
2. A에서 PC 도우미를 받고 검증한 뒤 B에 있는 모델·실행기를 찾는다. 없으면 아래 범위에서 준비한다.
3. 실제 파일의 계약을 생성하고 개인 계정으로 B를 등록한다.
4. GPU 기준값을 측정한 다음 참여자를 실행하여 모델 적재와 연결을 확인한다.
5. 별도 이용자 계정으로 **B에만** 실제 작업을 배정하고 결과·GPU 사용·정산을 검증한다.
6. 일시 중지 → VRAM 반환 → 재개 → 새 작업을 검사한다. 실행 중 회수도 별도로 시도한다.
7. 테스트가 점유한 프로세스와 예약을 정리하고 증거를 포함한 MD/JSON 보고서를 만든다.

일반적인 다운로드·압축 해제·작업 폴더 생성·테스트 계정/PC 등록·모델 적재·아래 한도 내 작업 요청은 이 실행 요청에 포함된다. 매 단계 진행 여부를 다시 묻지 않는다. 필요한 주소·파일을 찾을 수 없거나 관리자 설치 권한이 꼭 필요한 경우에만 해당 입력을 요청하고, 독립적인 조사는 계속한다. 도구의 실제 권한·승인 제한은 따른다.

AWS 자원 생성·재배포·재부팅·DB 변경은 이 검수의 범위에 없다. B에 중앙 서버를 새로 띄우거나 `START-RELAY.cmd`를 실행하지 않는다. B의 추론 포트나 RPC 포트를 인터넷에 열지 않는다. 원격 API의 TLS 검증을 끄지 않는다. 기존 모델·드라이버·다른 사용자의 프로세스를 바꾸거나 일괄 종료하지 않는다.

fixture/demo/가짜 결과 제출/외부 LLM 호출/CPU 전용 추론을 GPU 성공으로 기록하지 않는다. 문제가 생기면 실제 오류와 단계별 증거를 기록한다. 실행하지 않은 항목은 PASS가 아니다.

## 2. 기본값과 산출물

```text
COORDINATOR = https://gpu-together.3.38.50.72.sslip.io
POOL = local-owner
CONTEXT = 4096                 # 기본 시작값. 실제 모델 상한을 확인하고 계약에 고정
GPU_LAYERS = 99                # 요청값일 뿐, GPU 적재/연산을 보증하지 않음
LOCAL_PORT = 8081              # 이미 사용 중이면 기존 프로세스를 건드리지 말고 빈 포트 선택
MAX_JOBS = 4                   # 최초 성공, 재개 성공, 실행 중 회수, 보완 시험을 모두 포함
MAX_RESERVED_CR = 40           # 전체 작업 예산 합계 상한. 문서 1개당 10 CR
JOB_TIMEOUT_SECONDS = 600
WORKER_MAX_SECONDS = 3600      # worker 시작 후 전체 검수 실행 상한; 준비/다운로드 시간 제외
```

`RUN_ID`는 UTC 날짜와 임의 ID를 합쳐 생성한다. 현재 작업 폴더 안에 아래 디렉터리를 만든다. `private`에는 계정/노드 키가 들어가므로 Git·공개 공유·최종 증거 ZIP에 넣지 않는다. 기존 파일이 있으면 덮어쓰기 전에 같은 실행의 상태인지 확인한다.

```text
relay-aws-check/<RUN_ID>/
  package/                    # ZIP, 체크섬, 검증한 PC 도우미
  private/                    # 계정 복구 파일, 연결 JSON, 멱등 요청 상태
  scripts/                    # Codex가 이 문서에 따라 만드는 로컬 자동화
  evidence/                   # 비밀값을 제거한 계측·결과·로그
  aws-remote-gpu-report.md
  aws-remote-gpu-report.json
```

보고서·공유 로그에는 키, Authorization/Cookie, 전체 환경변수, 연결 JSON 원문을 넣지 않는다. 스크립트에 비밀값을 하드코딩하거나 프로세스 인자로 넘기지 않는다. 비공개 JSON에서 메모리로 읽는다. 명령·예외를 기록할 때 요청 헤더와 본문 전체를 덤프하지 않는다.

worker 실행 상한까지 14분 미만이 남으면 새 작업을 만들지 않고 진행 중 결과 확인과 정리로 전환한다. 완료하지 못한 검사를 NOT RUN으로 기록하며 계측기는 worker 종료 후 VRAM 회수 관찰까지 유지한다.

## 3. HTTPS·배포 버전·PC 사전 검사

### A 접속

다음 PowerShell은 읽기 전용이다. 오류가 나면 성공한 것으로 넘어가지 않는다.

```powershell
$ErrorActionPreference = 'Stop'
$relayOrigin = 'https://gpu-together.3.38.50.72.sslip.io'
$relayInfo = Invoke-RestMethod -Uri "$relayOrigin/api/participation/info" -TimeoutSec 20
if ($relayInfo.coordinator.TrimEnd('/') -ne $relayOrigin -or $relayInfo.localOnly -ne $false) {
    throw 'AWS 공개 주소 설정이 다릅니다. 서버 주소를 먼저 확인하세요.'
}
$relayPage = Invoke-WebRequest -Uri $relayOrigin -UseBasicParsing -TimeoutSec 20
Write-Output "HTTPS status: $($relayPage.StatusCode); signup CR: $($relayInfo.signupCredits)"
```

B의 **실제로 참여자에 사용할 Python**으로도 `urllib.request.urlopen(COORDINATOR + '/api/participation/info', timeout=20)`을 실행한다. 인증서 검증 기본값을 유지한다. 홈페이지 200, JSON 응답, coordinator 일치, `localOnly == false`를 기록한다. 인증 없는 `GET /api/relay`와 `GET /api/member/me`는 401이어야 한다.

연결 거부/시간 초과면 DNS 결과, 443 연결 결과, UTC 시각, 예외 종류를 남기고 원격 단계는 BLOCKED다. 최대 3회, 10초 간격으로 재확인한 뒤 로컬 조사만 진행한다. 주소를 예전 터널·localhost로 바꾸어 통과시키지 않는다. 공개 참여 API가 404/410이면 배포 버전 문제로 보고하며 관리자 키를 요구해 우회하지 않는다.

가능하면 브라우저로 사이트를 열어 **내 GPU 연결하기 / 내 GPU·토큰 / 다른 GPU 사용** 진입과 화면을 확인한다. 브라우저 조작 도구가 없으면 HTTPS/API 검증은 계속하고 화면 검증만 NOT RUN으로 구분한다. 회원 키를 주소 쿼리에 넣지 않는다.

### B 조사

```powershell
hostname
Get-Command python, py, nvidia-smi -ErrorAction SilentlyContinue | Select-Object Name, Source
python --version
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion
nvidia-smi --query-gpu=index,uuid,name,driver_version,memory.total,memory.used,memory.free --format=csv,noheader,nounits
```

`python`이 설치 안내용 alias면 `py -3` 또는 실제 설치 경로를 찾는다. Python 3.10 이상이 필요하다. 없으면 공식 Python 배포처에서 사용자 범위 설치를 준비하고 설치 후 실행 경로를 고정한다. GUI에는 Tkinter가 필요하지만 아래 headless WorkerProcess 방식은 GUI를 열지 않는다. 참여자만 실행하는 B에는 Node.js/npm이나 전체 프로젝트 설치가 필요하지 않다.

GPU UUID, 호스트명, GPU 총량/사용량/여유량(MiB), 드라이버, RAM, 디스크 여유를 기록한다. CUDA용 `nvidia-smi`가 없는 AMD/Intel/Apple 장치는 해당 backend와 PID별 계측 도구로 진행하고 NVIDIA 명령 실패를 GPU 없음으로 단정하지 않는다. 실제 GPU backend를 준비할 수 없으면 CPU 성능 확인으로 목표를 바꾸지 말고 GPU 검증을 BLOCKED로 남긴다.

## 4. PC 도우미 다운로드와 파일 무결성

현재 공개 다운로드 주소:

**<https://gpu-together.3.38.50.72.sslip.io/api/participation/provider.zip>**

이 경로는 관리자 로그인이 필요 없다. `/api/setup/provider.zip`는 관리자용이므로 여기서는 사용하지 않는다. URL이 다른 origin으로 리다이렉트되면 자동 실행 전에 출처를 확인한다.

1. ZIP을 새 `package` 디렉터리로 다운로드하고 크기·UTC 시각·SHA-256을 기록한다.
2. ZIP 목록을 먼저 읽어 절대 경로, 드라이브 경로, `..`, 중복 항목, symlink를 거부하고 압축 해제 경로가 새 대상 디렉터리 안인지 확인한다.
3. 다음 파일과 `provider-manifest.json`의 `files` 해시를 확인한다. 누락·해시 불일치면 실행하지 않는다.

```text
START-PROVIDER.cmd
provider/provider.py
provider/setup_gui.py
provider/model_discovery.py
provider/gguf_metadata.py
provider/connection_discovery.py
provider/distributed_runtime.py
provider/runtime_discovery.py
provider/update_launcher.py
provider/update-config.json
provider/version.json
provider-manifest.json
```

문서 작성 시 소스 버전은 `0.3.1`이다. 실행 시 내려받은 실제 manifest/version과 파일 해시를 보고서에 기록한다. ZIP 안 manifest와의 일치는 내부 일관성 검사이며, 독립적인 배포자 서명 확인으로 표현하지 않는다. 신뢰 출처는 사용자가 지정한 HTTPS 서비스이며 별도 공표 체크섬이 있으면 함께 비교한다.

`START-PROVIDER.cmd`는 GitHub 자동 업데이트 후 다른 캐시 폴더의 버전을 실행할 수 있다. 재현 가능한 자동 검수의 기본 경로는 **검증한 압축 해제 폴더의 `provider/setup_gui.py`와 `WorkerProcess`를 직접 사용하는 것**이다. GUI로 검사한다면 실제 실행 경로·버전을 별도로 기록한다. `update_launcher.py --check-only`도 다운로드/업데이트를 수행할 수 있으므로 읽기 전용 조회로 취급하지 않는다.

## 5. 모델·실행기 선택과 실제 계약

검증한 패키지의 `provider` 폴더를 Python import 경로 앞에 추가한 후 기존 검색 함수를 사용한다.

```python
from model_discovery import discover_models
from runtime_discovery import discover_runtimes
models = discover_models()       # models / roots / warnings
runtimes = discover_runtimes()   # runtimes / roots / warnings
```

검색 범위는 기본 모델 캐시와 사용자 지정 폴더로 제한한다. 디스크 전체를 재귀 검색하지 않는다. `complete`와 `compatible`이 참인 단일 GGUF 후보를 선택한다. 현재 이 경로의 분할 GGUF·safetensors는 지원하지 않는다. Windows/WSL 경로와 실행기 플랫폼을 섞지 않는다.

기존 후보가 여러 개면 GPU 여유 메모리 안에서 동작할 작은 instruction/chat 모델을 우선한다. 모델 크기만으로 필요한 VRAM을 계산하지 말고 KV·연산 버퍼·OS 사용량 여유를 남긴다. GPU가 여러 개면 한 장을 선택하여 UUID를 기록한다. NVIDIA에서는 runtime을 시작하는 컨트롤러 환경의 `CUDA_VISIBLE_DEVICES=<선택 GPU UUID>`로 대상 장치를 제한할 수 있다.

없으면 공식 Python, `ggml-org/llama.cpp` 릴리스, 모델 배포자가 제공하는 GGUF를 조사해 준비한다. 런타임과 필요한 backend DLL을 함께 받는다. 모델 신규 다운로드는 기본 합계 8 GiB 안에서 작은 후보 하나를 우선하고, 라이선스·정확한 파일 URL·고정 릴리스/리비전·크기·로컬 SHA-256 및 제공된 체크섬을 기록한다. 그보다 큰 다운로드, 유료 결제, 라이선스 동의나 새 GPU 드라이버 설치가 필요하면 준비 정보를 모은 뒤 해당 선택만 사용자에게 확인한다. 기존 모델/드라이버를 삭제하지 않는다.

실행기는 다음을 모두 지원해야 한다. 단순히 OpenAI 호환 API가 있다는 이유로 다른 런타임을 대입하지 않는다.

- 해당 B GPU backend와 `--jinja`, `--chat-template-file`, `--no-context-shift`.
- `/health`, `/props`, 단일 slot과 계약과 일치하는 context/template.
- **`POST /v1/chat/completions/input_tokens`**, `/v1/chat/completions`, JSON response schema.

필요하면 참여자 실행 **전에** 동일 인자로 짧은 로컬 진단을 수행해 stdout/stderr의 backend·offload 정보를 보관한다. 진단용 PID만 종료하고 VRAM 반환을 확인한 뒤 본 검수 baseline을 다시 측정한다. 참여자 코드 자체는 llama-server stdout/stderr를 버리므로 본 실행의 worker.log에 offload 로그가 있다고 가정하지 않는다.

계약 생성은 아래 함수로 한다. `files`에는 실제 절대 경로를 넣고 새 자동화 스크립트에서 호출한다.

```python
from pathlib import Path
import json
from setup_gui import prepare_model_template, compute_contract

# files = {'server': 절대경로, 'model': 절대경로, 'template': 절대경로}
# 템플릿이 없다면 정확한 모델의 내장 템플릿을 추출한다.
# template = prepare_model_template(files['model'], output_template_directory)
# 반환값이 None이면 해당 모델의 정확한 템플릿을 준비해야 한다.
contract = compute_contract(files, context)
Path(contract_output).write_text(
    json.dumps(contract, ensure_ascii=False, indent=2), encoding='utf-8')
```

모델 파일·실행파일·템플릿의 SHA-256과 context를 저장한다. context는 `4096..131072`이면서 실제 모델 지원 범위여야 한다. `provider.py --print-contract` 출력에는 context가 없으므로 그대로 등록에 쓰지 않는다. 템플릿의 BOM/줄바꿈을 바꾸면 해시가 달라진다.

## 6. 회원 두 역할과 B 노드 등록 — 관리자 없이 실행

현재 서비스는 **자기 계정 소유 GPU로 자기 작업을 구매할 수 없다.** 제공자 역할과 이용자 역할은 서로 다른 회원 ID가 필요하다. 두 계정은 같은 B 컴퓨터에서 API로 제어해도 된다. 물리적 원격성은 AWS A와 실제 추론하는 B 사이에서 검증한다.

가능하면 사용자가 제공한 기존 계정을 재사용한다. 없으면 검수 이름이 붙은 제공자/이용자 계정을 각각 하나만 만든다. 가입 CR은 `/api/participation/info`의 실제 값이며 기본 100이다. 잔액 부족을 피하려고 계정을 계속 만들지 않는다. 부족하면 실제 잔액과 필요한 CR을 보고하고 그 단계만 BLOCKED로 둔다.

### API 계약

모든 요청은 위 COORDINATOR의 같은 HTTPS origin에만 보낸다. `Content-Type: application/json`, timeout 20초를 적용한다. 인증 요청의 리다이렉트는 거부한다. Python 표준 라이브러리로 충분하며 요청/응답은 프로그램 내부에서 처리한다.

| 작업 | 메서드·경로 | JSON 또는 인증 |
|---|---|---|
| 회원 생성 | `POST /api/member/register` | `{id, token, name}` |
| 내 계정·모델·노드·작업·원장 | `GET /api/member/me` | 회원 인증 헤더 |
| 내 PC 등록 | `POST /api/member/devices` | 회원 인증 + 아래 PC JSON |
| 작업/중지/재개/취소 | `POST /api/member/command` | 회원 인증 + `{action, payload, requestId}` |
| 연결 상태 검증 | `POST /api/participation/verify` | `{node, token}` — **PC 키** |

회원 인증 헤더는 `X-Relay-Member: <회원 id>`, `Authorization: Bearer <회원 token>`이다. PC 연결 키와 회원 키는 서로 다르다. `id`와 `requestId`는 `str(uuid.uuid4())`, 각 token은 **서로 다른 두 소문자 UUID 문자열을 그대로 이어 붙인 72자**로 만든다. 회원 키·PC 키·역할 간 키를 재사용하지 않는다.

서버에 요청하기 **전에** 생성한 ID·키·payload를 비공개 상태 파일에 저장한다. 응답 유실 시 같은 요청 ID·같은 본문·같은 키로 제한적으로 재시도한다. 이미 성공한 작업을 다시 만들거나 409에서 새 ID를 계속 생성하지 않는다. 나중에 의도적으로 새 작업/새 pause를 할 때는 새 requestId를 쓴다.

회원 복구 파일 형식(값은 파일에만 기록):

```json
{"version":1,"kind":"relay-member-account","coordinator":"https://gpu-together.3.38.50.72.sslip.io","id":"생성한 회원 UUID","token":"생성한 회원 비밀키","name":"검수 역할 이름"}
```

`POST /api/member/devices`는 **제공자 회원**으로 요청한다.

```json
{
  "requestId": "생성한 PC 등록 UUID",
  "token": "회원 키와 별개로 생성한 PC 키",
  "name": "B-PC-RUN_ID",
  "modelName": "실제 모델 이름",
  "model": {
    "digest": "contract.modelDigest의 실제 SHA-256",
    "runtime": "contract.runtime의 실제 SHA-256",
    "template": "contract.template의 실제 SHA-256",
    "context": 4096
  },
  "vram": 4096
}
```

`context`와 `vram`은 예시 숫자를 그대로 쓰지 말고 확정한 문맥과 B가 제공할 수 있는 **MiB 정수**로 대체한다. `vram`은 등록 정보이므로 GPU 실측 증거가 아니다. 개인 등록은 서버가 새 모델의 `minVram`을 0으로 만들 수 있다. 클라이언트가 임의로 기존 모델 요구량을 낮추거나 그 값으로 GPU 적재를 보증하지 않는다.

응답은 `{config: {...}}`이며 **config에 token이 없다.** 요청 전에 저장한 PC 키를 `config.token`에 추가하여 `private/relay-provider-<node>.json`에 저장한다. `config.coordinator`, `pool == local-owner`, `node`, `model`, `context`를 검사한다. 등록만으로 온라인 상태가 되는 것은 아니다.

`GET /api/member/me`의 `state.books.live.nodes`에서 해당 `id == config.node`의 `model`이 실제 `MODEL_ID`다. 파일 해시나 모델 이름을 modelId로 사용하지 않는다. 재실행 시 이미 등록한 검수 B 노드·계정·연결 파일을 복원한다. 이전 검수에서 이 노드를 paused로 남겼다면 7절 baseline 측정 후, worker 시작 전에 제공자 회원으로 `resume`을 새 requestId와 함께 보낸다. paused 상태로 시작하면 worker는 모델을 적재하지 않고 대기한다.

## 7. GPU 계측과 참여자 실행

### 먼저 계측 시작

모델을 적재하기 전에 1초 간격으로 **30초 baseline**을 기록한다. 모델 적재·작업·pause·resume·종료 후 회수까지 같은 계측기를 계속 실행한다. 각 행에 UTC 시각과 GPU UUID를 포함한다.

```powershell
nvidia-smi --query-gpu=timestamp,index,uuid,name,memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory --format=csv,noheader,nounits
```

위는 1회 조회 예시다. 별도 계측 스크립트에서 1초 주기·종료 신호·최대 실행시간을 적용해 CSV/JSONL로 저장한다. 오류/미지원 필드를 0으로 바꾸지 않는다. worker PID와 자식 llama-server의 PID·시작시각·실행파일 경로·부모 PID를 기록한다. 전체 시스템의 명령줄을 덤프하지 않는다.

Windows WDDM에서 process VRAM이 `N/A`면 GPU Process Memory/GPU Engine 성능 카운터나 장치 도구로 **그 PID**의 전용 메모리와 연산 활동을 보완한다. 다른 앱이 쓴 전체 GPU 사용률만으로 본 모델의 연산을 인정하지 않는다. 대상 PID의 메모리·활동을 분리할 수 없으면 해당 항목은 INCONCLUSIVE다.

실행 전에 메모리 기준을 고정한다:

- `baselineMiB`: 30초 VRAM 사용량 중앙값, `baselineRangeMiB`: 최대−최소.
- `noiseAllowanceMiB = max(128, 3 * baselineRangeMiB)`.
- 적재 후 안정 구간 10초의 중앙값 증가가 `max(256, 2 * noiseAllowanceMiB)` 이상이고 대상 PID의 GPU 메모리 사용과 연결되어야 적재 PASS.
- 회수는 `baselineMiB + noiseAllowanceMiB` 이하 5회 연속 관측. 기본 목표: pause 후 PID 종료 30초 이내, VRAM 복귀 60초 이내, 이후 15초간 재적재 없음.

아주 작은 모델/통합 메모리 장치는 실행 전 타당한 기준을 정하고 이유를 기록한다. 결과를 본 뒤 합격시키려고 기준을 낮추지 않는다.

### headless 실행 기본 경로

검증한 `provider` 디렉터리에서 `setup_gui`의 `read_connection`, `compute_contract`, `match_contract`, `WorkerProcess`를 사용한다. 아래 컨트롤러를 `scripts/run_worker.py`로 만들고 경로 설정 JSON을 `private/worker-settings.json`에 저장한다. 컨트롤러는 **계속 실행 중이어야 한다.** 잠깐 시작한 뒤 컨트롤러를 종료하면 모델도 회수된다.

설정 JSON의 키는 `provider_dir`, `connection_file`, `files`(server/model/template 절대 경로), `port`, `gpu_layers`, `log_file`, `stop_file`, `pid_file`이다. 모두 실제 절대 경로로 쓰고 stop_file은 이번 RUN_ID 전용 새 경로여야 한다. 설정에는 키 문자열을 복사하지 않는다.

```python
import json, queue, sys, time
from datetime import datetime, timezone
from pathlib import Path

s = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
sys.path.insert(0, s['provider_dir'])
from setup_gui import read_connection, compute_contract, match_contract, WorkerProcess

config = read_connection(s['connection_file'])
match_contract(compute_contract(s['files'], config['context']), config['model'])
stop_file = Path(s['stop_file'])
if stop_file.exists():
    raise SystemExit('This run already has a stop signal; choose a new run or resume deliberately.')
messages = queue.Queue()
worker = WorkerProcess(messages)
reason = 'startup_failure'
worker_exit_code = None
exit_seen = False

def write_event(log, kind, value):
    value = str(value).replace(config['token'], '[REDACTED]')
    log.write(json.dumps({'utc': datetime.now(timezone.utc).isoformat(),
                          'kind': kind, 'value': value}, ensure_ascii=False) + '\n')
    log.flush()

with Path(s['log_file']).open('a', encoding='utf-8') as log:
    try:
        worker.start(config, s['files'], s['port'], s['gpu_layers'])
        Path(s['pid_file']).write_text(str(worker.process.pid), encoding='ascii')
        write_event(log, 'worker_pid', worker.process.pid)
        reason = 'controller_error'
        deadline = time.monotonic() + 3600
        while worker.running and not stop_file.exists() and time.monotonic() < deadline:
            try:
                kind, value = messages.get(timeout=0.5)
                write_event(log, kind, value)
                exit_seen = exit_seen or kind == 'exit'
            except queue.Empty:
                pass
        reason = ('stop_file' if stop_file.exists() else
                  'worker_exited_unexpectedly' if not worker.running else 'time_limit')
    finally:
        worker.stop()
        if worker.process is not None:
            try:
                worker_exit_code = worker.process.wait(timeout=20)
            except Exception:
                write_event(log, 'cleanup_error', 'Worker exit not confirmed; inspect owned PIDs.')
                raise
        # The stdout reader may enqueue its final lines after process.wait returns.
        drain_deadline = time.monotonic() + 2
        while worker.process is not None and not exit_seen and time.monotonic() < drain_deadline:
            try:
                kind, value = messages.get(timeout=0.1)
                write_event(log, kind, value)
                exit_seen = kind == 'exit'
            except queue.Empty:
                pass
        while not messages.empty():
            kind, value = messages.get_nowait()
            write_event(log, kind, value)
        write_event(log, 'termination_reason', reason)
        write_event(log, 'worker_exit_code', worker_exit_code)
        write_event(log, 'controller_stopped', 'Verify child PID exit and VRAM release.')
if reason != 'stop_file' or worker_exit_code != 0:
    raise SystemExit(1)
```

컨트롤러는 백그라운드에서 유지하고, Codex는 별도 명령으로 API와 계측을 조작한다. 각 단계마다 사용자 입력을 기다리는 구조로 만들지 않는다.

Windows에서 `Start-Process`를 사용하면 `-WindowStyle Hidden`과 로그 리다이렉트를 지정하고 Python 실행파일·인수의 따옴표를 정확히 처리한다. 공백이 있는 경로도 지원해야 한다. 일시적인 셸이 종료되면 자식도 종료되는 실행 환경에서는 유지되는 실행 세션을 사용한다. 중지할 때는 해당 RUN_ID의 stop_file을 생성한다.

모델은 작업을 받기 **전**에 적재된다. B 노드의 `lastSeen` 갱신, `connected == true` / `status == online` 상태와 B의 PID·VRAM 변화를 함께 확인한다. 온라인 확인까지 기본 3분을 기다린다. 준비 시간이 더 필요하면 실제 로그로 원인을 확인하고 무제한 대기하지 않는다.

## 8. AWS를 통한 실제 모델 추론

**이용자 회원**으로 `/api/member/command`에 다음 요청을 보낸다. 실행 전 이용자 잔액 ≥10 CR, B 노드 온라인, 계약·modelId 일치를 확인한다.

```json
{
  "action": "create",
  "requestId": "이번 작업의 새 UUID",
  "payload": {
    "title": "AWS-B-GPU-RUN_ID-01",
    "modelId": "실제 MODEL_ID",
    "publicData": true,
    "fields": ["product", "verification_code"],
    "documents": [{
      "title": "Synthetic public GPU verification document",
      "url": "",
      "text": "product: Relay Remote GPU Test\nverification_code: RUN_ID-01"
    }],
    "budget": 10,
    "minutes": 10,
    "allowedNodes": ["실제 B NODE_ID"]
  }
}
```

`RUN_ID-01`은 이번 실행의 고유 값으로 치환한다. 입력은 공개 합성 문서지만 결과는 **실제 로컬 LLM이 생성**해야 한다. `allowedNodes`를 반드시 B 하나로 제한한다. 회원 API가 실제 결제 계정을 결정하므로 `payer`나 `mode: demo`를 넣지 않는다. 응답의 `result.jobId`를 저장한다.

이용자 `GET /api/member/me`를 3초 간격으로 조회하여 `state.books.live.jobs`의 해당 jobId만 추적한다. 다른 사용자의 작업은 건드리지 않는다. 다음을 **모두** 검사한다.

1. `job.status == completed`, task `status == settled`, `quality == passed`.
2. `acceptedNode == B NODE_ID`; `acceptedAttempt`, `acceptedEpoch`, taskId, receipt를 기록한다.
3. items의 `product` 값이 `Relay Remote GPU Test`, `verification_code` 값이 실제 `RUN_ID-01`이다. 인용은 입력 원문에 존재하고 각 item의 `verified == true`다. 품질 상태만 보지 말고 값도 검사한다.
4. B 로그의 `Running assigned document <taskId>`와 `Settled receipt: <receipt>`가 서버 결과와 일치한다.
5. 같은 추론 시간 구간의 B runtime PID·GPU UUID·VRAM과 **그 PID의 GPU 연산 활동**을 확인한다. `gpu_layers=99`, CPU 사용량, 단순 VRAM 증가만으로 GPU 추론을 확정하지 않는다.
6. 이용자 원장의 해당 taskId에 `type == settlement`가 정확히 1건, `id == receipt`, `amount == 10`, `provider == 9`, `operator == 1`; 작업의 `spent == 10`, `reserved == 0`이다.
7. 격리된 검수 계정이면 이용자 잔액 −10, 제공자 잔액·B earned +9를 확인한다. 기존 계정이면 다른 동시 거래를 제외하고 receipt와 전후 원장 차이로 비교한다. 제공자 조회는 타인의 jobId/taskId를 숨길 수 있으므로 **이용자 원장**에서 taskId별 중복 정산을 검사한다.

10분 초과, 작업 실패 또는 결과 오류면 상태·오류·attempt·메모리를 보존하고 이번 작업만 취소한다. 작업이 정산되었어도 결과가 틀리면 품질 실패다. 모델/템플릿/문맥을 바꾸면 새 계약으로 등록/재연결하고 모든 시도를 보고한다. 전체 생성 작업 4개·예산 합계 40 CR 한도를 넘기지 않는다.

## 9. 일시 중지·메모리 반환·재개·실행 중 회수

명령 형식은 모두 `/api/member/command`의 `{action, payload, requestId}`다. 서버에 `recall` 명령은 없다.

| 동작 | 인증 | action / payload |
|---|---|---|
| B 제공 일시 중지 | 제공자 회원 | `pause` / `{nodeId: B NODE_ID}` |
| B 제공 허용 | 제공자 회원 | `resume` / `{nodeId: B NODE_ID}` |
| 특정 테스트 작업 취소 | 그 작업을 만든 이용자 회원 | `cancel` / `{jobId: TEST_JOB_ID}` |

1. 최초 성공 뒤 B가 유휴 상태일 때 pause하고 호출 UTC를 기록한다. llama-server PID 종료, VRAM 복귀, 15초간 재적재 없음을 계측한다. worker가 살아서 상태를 기다리는 것은 정상이다.
2. resume 후 **같은 연결 파일·같은 노드**로 적재/온라인 복귀를 확인한다. 새 고유 코드 `RUN_ID-02`로 작업을 만들어 동일 기준으로 성공을 검증한다. 서버 resume이 종료된 로컬 프로그램을 다시 켜 주는 것은 아니다.
3. 실행 중 회수는 별도 테스트다. `job.status == running`, 대상 `task.status == leased`와 `task.lease.attemptId/epoch/nodeId`, B의 `Running assigned document <taskId>`를 실제 관찰한 뒤 pause한다. **job.status에 leased를 기다리지 않는다.** 필요하면 이 구간만 1초 polling한다. 입력을 늘릴 경우 문서 4,000 UTF-16 코드 단위·필드 6개 이내로 제한하고, 서버가 예약하는 출력 1,024 토큰까지 포함해 계약 문맥을 넘기지 않는다.
4. 해당 attempt가 `status == expired`, `reason == 소유자 즉시 회수`로 바뀌고 이후 acceptedAttempt로 수락·정산되지 않는지 확인한다. 다른 attempt와 혼동하지 않는다. 회수 전에 이미 완료됐다면 실행 중 회수는 NOT RUN이며 성공으로 바꾸지 않는다. 기본 lease는 30초, attempt hard stop은 180초다. 최소 180초 동안 해당 작업·철회 attempt의 수락/원장을 관찰하되 짧은 호출로 진행 상황을 전달한다.
5. 회수 작업은 B를 paused로 유지한 상태에서 취소하고 예약 반환을 확인한다. 모델 적재와 실제 작업 성공까지는 확인했지만 실행 중 회수 타이밍을 잡지 못한 경우, 그 부분만 미검증으로 분리한다.

## 10. 항상 수행할 정리

자동화의 `finally` 경로로 정리한다. 실패했거나 사용자가 중단해도 실행한다.

1. 만들었던 검수 jobId 중 미완료 작업만 이용자 계정으로 취소한다.
2. 이번에 등록/사용한 검수 B 노드를 제공자 계정으로 pause한다.
3. 컨트롤러 stop_file을 생성하고 worker 종료를 기다린다. `WorkerProcess.stop()`은 비동기이므로 호출 직후 완료로 처리하지 않는다.
4. worker와 그 자식 runtime의 **기록된 PID·시작시각·경로**로 종료 여부를 확인하고 VRAM을 계측한다. 잔류 시 해당 테스트 프로세스만 정리한다. `taskkill /IM python.exe`, 전체 llama-server 종료 같은 명령은 사용하지 않는다.
5. 이번 작업의 `reserved == 0`을 확인한다. 기존 계정의 전체 reserved는 다른 작업 때문에 0이 아닐 수 있으므로 작업별로 확인한다.
6. 서버에 연결할 수 없으면 원격 pause/cancel은 BLOCKED로 남기고 로컬 worker·runtime 회수는 즉시 수행한다. 서버 복구 후 확인할 jobId/nodeId를 보고한다. 서버에 확인하지 않은 예약 반환을 성공으로 적지 않는다.
7. 마지막 계측을 저장하고 이번 계측 프로세스만 종료한다. 복구 파일과 연결 파일은 비공개로 남기고 위치만 사용자에게 알려준다. AWS 서버를 종료하거나 계정을 삭제하지 않는다. 테스트 노드는 paused로 남긴다.

## 11. 판정과 최종 보고서

각 항목의 상태는 `PASS / FAIL / BLOCKED / NOT RUN / INCONCLUSIVE` 중 하나다. 파일·시각·수치와 연결해 판정한다.

| ID | 검사 | 필수 증거 |
|---|---|---|
| T01 | AWS A와 물리 B, HTTPS | 실제 origin, TLS 결과, B 호스트/GPU UUID, 추론 PID가 B에 존재 |
| T02 | 패키지·파일 계약 | 실제 ZIP/manifest/런타임/모델/템플릿 해시, 문맥, 실행 경로 |
| T03 | 등록·원격 연결 | B nodeId/modelId, 실제 heartbeat/lastSeen, 온라인 상태 |
| T04 | B GPU에 가중치 적재 | baseline/load VRAM 시계열, 대상 PID 메모리, 적용 임계값 |
| T05 | B GPU의 실제 추론 | B에 한정한 job, 추론 구간의 대상 PID GPU 활동 |
| T06 | 결과·정산 | 고유 입력 결과/인용, acceptedNode/attempt/epoch, receipt, 단일 정산 |
| T07 | 유휴 pause·회수 | pause→PID 종료→VRAM 복귀 시간, 재적재 없음 |
| T08 | 재개 후 재실행 | 동일 노드/계약으로 새 작업 성공·GPU 증거 |
| T09 | 실행 중 회수 | 활성 attempt 관찰, 철회 후 해당 attempt 수락/정산 없음 |
| T10 | 최종 정리 | 테스트 worker/자식 종료, VRAM 반환, 테스트 예약 해제 |

**핵심 목표 PASS**는 T01~T06이 모두 PASS일 때다. **전체 검수 PASS**는 T01~T10이 모두 PASS일 때다. T04만 있으면 “VRAM 적재 확인”, T05가 부족하면 “실제 GPU 연산 미확인”이라고 명확히 쓴다. UI 화면 검사와 분산 LLM 검사는 별도 상태다.

최종 `aws-remote-gpu-report.md`와 `.json`에는 다음을 넣는다.

- 시작/종료 UTC, RUN_ID, AWS 주소, OS/Python/GPU/backend/드라이버/실행기 버전과 파일 해시.
- context, GPU layers 요청값, 선택 UUID, GPU 실제 적재 범위가 관찰되었는지. 일부 CPU offload면 그 사실을 명시한다.
- nodeId/modelId/jobId/taskId/attemptId/epoch/receipt와 모든 재시도·취소·품질 실패.
- baseline/loaded/inference peak/released MiB, PID 관계, GPU 활동, pause/종료/VRAM 반환 시간.
- T01~T10 판정과 증거 상대 경로. GPU 정보만 조회한 것은 성공 근거가 아니다.
- 최종 잔여 프로세스·서버 노드·예약 상태, 비공개 복구 파일 위치, 막힌 단계와 필요한 조치.
- 실제 결론을 첫 문장에 쓴다. 예: “이 PC의 RTX …에서 모델 적재 및 AWS 작업 2건의 실제 GPU 추론을 확인했다. 실행 중 회수는 타이밍을 잡지 못해 NOT RUN이다.”

증거 파일 예: `environment.json`, `package-check.json`, `model-contract.json`, `gpu-samples.csv`, `gpu-processes.jsonl`, `worker.log`, `events.jsonl`, `job-01.json`, `settlements.json`, `cleanup.json`. 공유 전 실제 회원/노드 token 문자열과 Authorization/Cookie 포함 여부를 검사하고 제거한다. `private` 파일 전체를 공유 보고서에 복사하지 않는다.

## 12. 장애별 확인점과 범위

| 현상 | 다음 확인 |
|---|---|
| HTTPS 연결 거부/시간 초과 | DNS·443·UTC 기록, AWS 운영자에게 서버 상태 확인 요청; B에 새 중앙 서버를 띄우지 않음 |
| ZIP 401 | 공개 `/api/participation/provider.zip` 경로인지 확인 |
| 회원/API 404 | 배포 버전 불일치; 기존 관리자 승인 방식으로 임의 전환하지 않음 |
| 회원 401 | 회원 id/키/서버 origin 일치, PC 키와 혼용 여부 |
| 등록 409 | 동일 requestId의 본문 변경·기존 계약 VRAM 조건·모델/PC 한도 확인; 중복 생성 중지 |
| 내 GPU가 구매 목록에 없음 | 제공자와 이용자가 같은 회원인지, B heartbeat·paused 확인 |
| llama-server 시작 실패 | DLL/backend/실제 포트 충돌/문맥/템플릿; 한정된 로컬 진단 로그 확보 |
| 온라인인데 작업 queued | allowedNodes, modelId, pause, 계약, 이용자 예산, 문맥 조건 |
| Provider recovery 반복 | worker는 오류 종류만 표시할 수 있음; 자기 job attempt reason과 로컬 진단을 교차 확인 |
| input_tokens 404/문맥 초과 | 실행기 지원 API·입력 길이 확인; CPU/외부 API로 대체하지 않음 |
| settled지만 값이 틀림 | 품질 FAIL, 원문·인용·고유 값 검사, 한도 내 보완 시험만 진행 |
| GPU 전체 사용량만 증가 | PID별 증거 보완; 다른 프로세스와 구분되지 않으면 INCONCLUSIVE |
| pause 후 VRAM 잔류 | 테스트 자식 PID와 다른 앱의 점유를 구분하여 자기 프로세스만 정리 |

이 검수는 **B 한 대에서 전체 모델을 실행하는 문서 추출 경로**다. 하나의 모델을 여러 컴퓨터의 VRAM으로 나눠 실행하는 분산 LLM/RPC, 임의 채팅 API, AWS GPU 사용은 검증하지 않는다. `distributed-model-test: NOT RUN`으로 보고한다. 그 기능까지 성공했다고 확장해서 표현하지 않는다.

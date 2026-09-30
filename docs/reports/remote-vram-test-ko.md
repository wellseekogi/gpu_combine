# 두 컴퓨터 실제 GPU·VRAM 검수 — Codex 실행 지시서

> AWS 사이트를 검증할 때는 [AWS-REMOTE-GPU-CODEX.md](../handoffs/AWS-REMOTE-GPU-CODEX.md)를 사용한다. 아래는 이전 임시 터널·관리자 등록 방식의 기록이며, 현재 AWS 검수에는 새 지침의 공개 다운로드·개인 계정 직접 등록 절차를 따른다.

작성일: 2026-09-18. 이 파일을 다른 컴퓨터의 Codex에 전달한다. Windows + NVIDIA를 기본으로 하며 다른 GPU는 동등한 장치·프로세스 측정 도구가 필요하다.

## 1. Codex에게 그대로 전달할 요청

```text
이 MD를 실행 지시서로 사용해 실제 원격 GPU 검수를 수행해 줘.
지금 컴퓨터는 B(참여자)이고, A(중앙 서버)는 별도 물리 컴퓨터다.
다운로드, 압축 검증, 로컬 모델 탐색, 파일 계약 생성, 연결 설정,
실제 작업 수신, VRAM 계측, 중지·재개, 결과 보고서 작성을 가능한 범위에서 자동 실행해 줘.
단순 설명이나 체크리스트 작성에서 끝내지 말고 실제 명령을 실행해 줘.
필수 입력이 없으면 해당 단계만 BLOCKED로 남기고 독립적인 사전 검사는 진행해 줘.
인증키를 출력하지 말고, 테스트용 프로세스만 정리해 줘.
demo, fixture, CPU 실행, 같은 컴퓨터의 두 프로세스로 원격 GPU 성공을 대신하지 마.
실행하지 않은 검사를 PASS로 적지 말고 원본 로그와 수치로 판정해 줘.
A 쪽 API 권한이 없으면 필요한 요청 JSON을 파일로 만들어 A의 Codex에 전달해 줘.
최종 산출물은 remote-vram-report.md, remote-vram-report.json, 증거 파일이다.
```

A에서 이어서 준비할 때는 위 요청의 역할을 `A(중앙 서버)`로 바꾸고 4~6절을 실행한다. 두 Codex 사이에 자동 통신 기능이 있다고 가정하지 않는다. 공유 경로나 명시적으로 준비된 원격 실행 수단이 없으면 계약 파일·연결 파일·준비 완료 신호를 교환하는 시점에 인계가 필요하다.

## 2. 검증 대상과 현재 준비 상태

주 검사는 **A의 live 문서 작업을 B의 전용 llama-server가 실행하면서 B의 물리 VRAM을 사용하는지**다. B에는 모델 전체가 들어가야 한다. 하나의 모델을 A/B VRAM에 나누는 분산 LLM 검사는 11절의 별도 범위다.

문서 작성 시 A에서 확인한 상태:

| 항목 | 값 / 상태 |
|---|---|
| 프로젝트 | `C:\gpu_togeter` |
| 로컬 서버 | `http://127.0.0.1:8788`, HTTP 200 확인 |
| 실행 방식 | 숨김 Node 프로세스, HTTPS 전환 후 PID `31844` |
| 테스트 데이터 | `C:\gpu_togeter\work\remote-vram-test\server` |
| 관리자 키 | 위 폴더의 `admin-key.txt` — 내용은 이 문서에 포함하지 않음 |
| 실행 로그·PID | 위 폴더의 `server.stdout.log`, `server.stderr.log`, `server.pid` |
| Node / Python | `v22.17.0` / `3.13.5` |
| 참여자 ZIP | 로컬 인증 다운로드 완료, 164,557바이트, 8개 파일을 배포 시점 소스와 비교 |
| 선행 회귀 검사 | 설정·실행기 Node 14개 / 제공자 Python audit 13개 PASS; GPU 실측 아님 |
| 원격 HTTPS 주소 | [https://laptop-mazda-ordering-horizon.trycloudflare.com](https://laptop-mazda-ordering-horizon.trycloudflare.com) — HTTPS 200, Python TLS 확인 |
| B의 모델 계약·노드 등록 | **아직 없음 — B의 실제 파일 검사 후 등록** |
| 두 물리 PC 종단 간 검사 | **NOT RUN** |

PID와 서버 생존 여부는 실행 직전에 다시 확인한다. 이 표는 영구적인 가동 보장이 아니다. Node 서버는 loopback 전용이고 Cloudflare Quick Tunnel이 외부 HTTPS를 전달한다. B에서는 위 HTTPS 주소를 사용한다. 관리자·노드 인증은 유지한다. 관리자 자동화 검증은 loopback에서만 실행했다. 공개 HTTPS 로그인은 NOT RUN이다.

준비한 `Relay-Provider.zip`의 SHA-256은 `e13cc88ee67961bccdaf8ae56d5e37f8b1bdb8fb274e5f1336c59e16ac12ff68`이다. 소스를 바꿔 다시 패키징하면 체크섬도 새로 발급한다. `outputs/remote-vram-handoff/`에 이 MD·ZIP·체크섬을 두었다.

### 지금 다른 PC에서 받을 주소

- 서버: [https://laptop-mazda-ordering-horizon.trycloudflare.com](https://laptop-mazda-ordering-horizon.trycloudflare.com)
- 검수 지시서: [remote-vram-test-ko.md](https://laptop-mazda-ordering-horizon.trycloudflare.com/downloads/remote-gpu/remote-vram-test-ko.md)
- 문서+프로그램: [Relay-Remote-VRAM-Handoff.zip](https://laptop-mazda-ordering-horizon.trycloudflare.com/downloads/remote-gpu/Relay-Remote-VRAM-Handoff.zip)
- 프로그램만: [Relay-Provider.zip](https://laptop-mazda-ordering-horizon.trycloudflare.com/downloads/remote-gpu/Relay-Provider.zip)
- 키 없는 연결 정보: [remote-connection-info.json](https://laptop-mazda-ordering-horizon.trycloudflare.com/downloads/remote-gpu/remote-connection-info.json)

이 다운로드 경로에는 공개 가능한 문서·프로그램만 있다. 노드 연결 JSON·관리자 키·DB는 포함하지 않는다. `/api/setup/provider.zip`의 관리자 인증은 그대로 유지된다. 프로그램을 받은 뒤 B의 실제 모델 계약을 A에 전달해 노드 등록·개별 연결 파일을 발급받아야 한다.

터널 PID는 `18880`, 실행파일은 `work/remote-vram-test/tunnel/cloudflared.exe`다. 버전 `2026.9.1`과 공식 SHA-256을 확인했다. 서버와 터널은 이 PC가 켜져 있고 해당 프로세스가 실행 중일 때만 제공된다. 터널을 새로 시작하면 새 주소를 확인하고 서버 origin·연결 파일·문서를 갱신한다. 이번 설정은 외부 PC의 HTTPS polling 검수용이다. Quick Tunnel은 테스트용이며 SSE를 지원하지 않는다. 분산 RPC나 SSE 검수의 네트워크 구성으로 대신하지 않는다. [공식 Quick Tunnel 안내](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

## 3. 실행에 필요한 입력과 파일

아래 값을 로컬 설정 파일에 모은다. 실제 값이 없는 항목을 추정해서 채우지 않는다.

| 입력 | 준비하는 쪽 | 의미 |
|---|---|---|
| `COORDINATOR_HTTPS` | A | 경로 없는 HTTPS origin. 예: `https://relay.example.org`는 예시일 뿐 |
| `PROVIDER_ZIP_SOURCE`, `PROVIDER_ZIP_SHA256` | A → B | 준비한 ZIP의 다운로드 URL 또는 공유 파일 경로와 SHA-256 |
| `RUNTIME_PATH`, `MODEL_PATH`, `TEMPLATE_PATH` | B | GPU backend가 있는 llama-server, GGUF, UTF-8 템플릿의 실제 절대 경로 |
| `CONTEXT` | A/B | 기본 후보 8192. 실제 파일·GPU에 맞게 선택 후 계약에서 고정 |
| `GPU_UUID`, `VRAM_BUDGET_MIB`, `MIN_VRAM_MIB` | B → A | 실장치 UUID, 다른 점유·여유분을 제외한 제공 한도, 모델에 필요한 검증된 한도 |
| `CONNECTION_FILE` | A → B | 해당 B 노드용 `relay-provider-<nodeId>.json` |
| `RUN_ID` | A/B | 동일 검수 묶음을 식별할 시간+임의 ID |

ZIP에는 Python, llama.cpp 실행파일/CUDA DLL, GGUF가 들어 있지 않다. 먼저 B의 기존 설치와 모델을 탐색한다. 없으면 신뢰하는 공식 배포처에서 **고정 버전·정확한 파일 URL·SHA-256·용량**을 기록해 내려받는다. 저장 공간과 GPU 용량을 검사한다. 승인하지 않은 모델로 대체하거나 무조건 최신 파일을 받지 않는다. 런타임에 필요한 DLL도 함께 준비한다.

모델·템플릿·실행파일이 A의 기존 승인 계약과 동일하면 그 계약을 재사용할 수 있다. B의 OS나 실행파일이 달라 해시가 달라지면 B용 계약을 새로 등록한다. 임의 해시로 등록 순서를 앞당기지 않는다.

산출물 디렉터리 예:

```text
A: work/remote-vram-test/server/       # DB·관리자 키: 전달 금지
A: outputs/remote-vram-handoff/       # MD·참여자 ZIP·체크섬: 전달 가능
A: work/remote-vram-test/private/      # 노드 연결 파일: 해당 B에만 전달
B: <검수 폴더>/provider/              # ZIP 압축 해제
B: <검수 폴더>/evidence/<RUN_ID>/     # 키를 제거한 결과·계측 로그
```

## 4. A — 서버와 HTTPS 준비

이번 실행의 HTTPS 터널은 이미 준비됐다. 재설정할 때만 다음 준비 단계를 수행한다.

1. 저장소의 `README.md`, `PROJECT_MAP.md`와 관련 코드의 현재 상태를 읽는다. 기존 변경을 되돌리지 않는다.
2. 현재 테스트 서버의 HTTP 응답과 소유 프로세스를 확인한다. 이미 실행 중이면 중복 시작하지 않는다.
3. B가 신뢰하는 인증서의 TLS reverse proxy를 구성해 HTTPS를 A의 `127.0.0.1:8788`로 전달한다. DNS/사설 overlay/프록시 설정이 없다면 네트워크 단계는 BLOCKED다. `RELAY_PUBLIC_ORIGIN`을 설정하는 것만으로 TLS가 생기지 않는다.
4. HTTPS 전환 시 이 검수용 Node 프로세스인지 실행 경로·명령줄·PID를 확인하고, 유휴 상태에서 재시작한다. 다른 Node 프로세스를 일괄 종료하지 않는다. 실제 작업 중이면 먼저 취소·참여 중지·lease 정리를 확인한다.

서버 실행 환경은 다음과 같다. 예시 주소를 실제 origin으로 바꾼다. 같은 데이터 디렉터리를 유지하고 관리자 키를 출력하지 않는다.

```powershell
$env:RELAY_DATA_DIR = 'C:\gpu_togeter\work\remote-vram-test\server'
$env:RELAY_HOST = '127.0.0.1'
$env:RELAY_PORT = '8788'
$env:RELAY_PUBLIC_ORIGIN = 'https://실제-서버-주소'
$env:RELAY_SECURE_COOKIE = '1'
# 다른 테스트의 RELAY_ADMIN_TOKEN / RELAY_INFERENCE_CONFIG가 상속되지 않았는지 확인
node standalone/server.mjs
```

위는 전경 실행이다. 자동화에서 `Start-Process`를 쓰면 `-WindowStyle Hidden`, stdout/stderr 파일, PID 기록을 지정한다. 서버는 검수 중 계속 실행해야 한다.

검사: B에서 TLS 검증을 켠 상태로 HTTPS 화면이 200이어야 한다. 인증 없는 `/api/relay`와 `/api/setup/provider.zip`는 401이어야 한다. A가 로그인 후 조회한 `/api/setup`은 `coordinator == COORDINATOR_HTTPS`, `localOnly == false`여야 한다. `-k`, `verify=False`, 전역 인증서 검증 해제로 통과시키지 않는다. 프록시뿐 아니라 B의 Python HTTPS 클라이언트도 인증서를 신뢰해야 한다.

원격 참여자는 A로 outbound HTTPS를 보낸다. 이 검수에서 B의 8081을 외부에 열 필요가 없다. 사설 IP라도 원격 HTTP는 제공자 코드에서 거부한다.

## 5. A → B — 참여자 다운로드와 실제 모델 계약

### A에서 ZIP 내보내기

`GET /api/setup/provider.zip`는 **관리자 세션 쿠키**가 필요하다. B 노드의 Bearer 키로 다운로드할 수 없다. A가 인증 후 다운로드해 B가 접근할 수 있는 지정 위치로 전달한다. 관리자 키를 B에 전달해서 다운로드 문제를 해결하지 않는다.

A의 로컬 PowerShell 예시다. 관리자 키는 `127.0.0.1`에만 전송한다. Secure 쿠키 설정에서도 인증 요청을 로컬로 유지하려고 응답 쿠키를 메모리의 명시적 Cookie 헤더로 전달한다. 이 헤더를 외부 주소로 보내거나 출력하지 않는다.

```powershell
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8788'
$out = 'C:\gpu_togeter\outputs\remote-vram-handoff'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$admin = (Get-Content -Raw -LiteralPath 'C:\gpu_togeter\work\remote-vram-test\server\admin-key.txt').Trim()
try {
  $login = Invoke-WebRequest -Uri "$base/api/login" -Method Post -ContentType 'application/json' -Body (@{token=$admin} | ConvertTo-Json)
  $cookie = ([string]$login.Headers['Set-Cookie']).Split(';')[0]
  Invoke-WebRequest -Uri "$base/api/setup/provider.zip" -Headers @{Cookie=$cookie} -OutFile "$out\Relay-Provider.zip"
  (Get-FileHash -LiteralPath "$out\Relay-Provider.zip" -Algorithm SHA256).Hash.ToLowerInvariant() | Set-Content -LiteralPath "$out\Relay-Provider.zip.sha256" -Encoding ascii
} finally {
  if ($cookie) { $null = Invoke-RestMethod -Uri "$base/api/logout" -Method Post -Headers @{Cookie=$cookie} }
  $cookie = $null
  $admin = $null
}
```

관리자 인증 응답·쿠키·요청 헤더·연결 JSON 전체를 로그에 남기지 않는다. ZIP과 체크섬을 실제 전달한 후에만 B 다운로드 준비 완료로 기록한다. 현재 파일이 로컬에 있다는 사실은 원격 다운로드 주소가 생겼다는 뜻이 아니다.

### B에서 다운로드·사전 검사

1. 지정된 URL이면 `Invoke-WebRequest -Uri <실제 URL> -OutFile <ZIP>`로 받는다. 공유 파일이면 그 파일을 복사한다. 전달받은 SHA-256과 일치하지 않으면 압축 실행을 중단한다. ZIP 항목에 절대 경로·`..` 경로가 없는지 확인하고 새 빈 폴더에 푼다.
2. 자동 업데이트 실행기와 검증 manifest를 포함한 다음 12개 파일이 있어야 한다: `START-PROVIDER.cmd`, `provider/provider.py`, `provider/setup_gui.py`, `provider/model_discovery.py`, `provider/gguf_metadata.py`, `provider/connection_discovery.py`, `provider/distributed_runtime.py`, `provider/runtime_discovery.py`, `provider/update_launcher.py`, `provider/update-config.json`, `provider/version.json`, `provider-manifest.json`.
3. `python --version`, Python 실행 경로, 호스트명, OS, 아래 GPU 목록을 기록한다. A와 B가 다른 물리 컴퓨터인지 확인한다.
4. 실행파일·GGUF·템플릿을 준비한다. GPU backend 사용 가능 여부, 모델 용량·문맥, 빈 로컬 포트(기본 8081), 디스크 공간을 확인한다. 다운로드만으로 GPU 실행 성공을 기록하지 않는다.

```powershell
hostname
python --version
nvidia-smi --query-gpu=index,uuid,name,driver_version,memory.total,memory.used,memory.free --format=csv,noheader,nounits
```

GUI 방식은 `START-PROVIDER.cmd` → 모델 선택 → 파일 검사 → 모델 검증 파일 저장이다. 자동화는 ZIP의 기존 함수로 같은 계약을 만든다. ZIP을 푼 루트에서 아래 내용을 `prepare_contract.py`로 저장해 실행할 수 있다. 세 경로와 문맥 값을 먼저 실제 값으로 바꾼다.

```python
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path('provider').resolve()))
from setup_gui import compute_contract
files = {
    'server': r'C:\실제경로\llama-server.exe',
    'model': r'C:\실제경로\model.gguf',
    'template': r'C:\실제경로\chat-template.jinja',
}
contract = compute_contract(files, 8192)
Path('relay-model-contract.json').write_text(
    json.dumps(contract, ensure_ascii=False, indent=2), encoding='utf-8')
```

내장 템플릿 추출은 `setup_gui.prepare_model_template(model_path, destination)`을 사용할 수 있다. `destination`은 출력 폴더이며 반환값은 생성한 `.jinja` 파일 경로 또는 `None`이다. 없으면 해당 모델의 정확한 템플릿을 준비한다. 줄바꿈·BOM 변경도 해시를 바꾸므로 파일을 임의 변환하지 않는다. `provider.py --print-contract`는 세 해시만 출력하며 문맥은 포함하지 않는다.

B는 **키가 없는** 계약 JSON, GPU 정보, 제공 VRAM 한도를 A에 전달한다. 연결 파일이 없으면 이 지점까지 자동 진행하고 `WAITING_FOR_REGISTRATION`으로 인계한다.

## 6. A — 모델 승인·B 노드 등록·연결 파일 발급

A의 로컬 UI 또는 로컬 API를 사용한다. 관리자 자동화는 `http://127.0.0.1:8788`에서만 수행하고 키·세션을 공개 터널로 보내지 않는다. API 자동화는 아래 계약을 그대로 따른다. `POST /api/login`의 JSON은 `{ "token": "로컬에서 읽은 관리자 키" }`이고 반환 세션 쿠키로 관리자 요청을 보낸다.

```text
POST /api/relay
{ "mode": "live", "action": "...", "payload": { ... }, "requestId": "새 UUID" }

action = model
payload = { name, digest, runtime, template, context, minVram }
→ response.result.modelId

action = node
payload = { name, modelId, vram, token }
→ response.result.nodeId

GET /api/relay
→ response.state.books.live
```

자동화 규칙:

- 모델의 `digest`에는 B 계약의 `modelDigest`를 매핑한다. 세 SHA-256과 context를 모두 비교한다.
- `minVram`과 `vram`은 MiB 정수다. 등록 수치는 자기 신고 값이며 물리 VRAM 측정 결과를 대신하지 않는다. 0으로 검사를 우회하지 않는다.
- 새 노드 키는 Node의 `crypto.randomUUID() + crypto.randomUUID()`로 생성한다. 현재 API 형식은 소문자 UUID 두 개를 연결한 72자다.
- 응답 유실 시 **같은 payload·token·requestId**로 재시도한다. 인계 상태는 비공개 파일에 저장한다. 새 ID로 중복 모델·노드를 계속 생성하지 않는다.
- `lib/relay/setup.mjs`의 `connectionConfig`로 연결 파일을 생성하면 UI와 동일하게 검증할 수 있다.

```javascript
// 저장소 안의 .mjs 도구에서 사용. 값들은 검증한 계약/API 응답에서 가져온다.
import { connectionConfig } from './lib/relay/setup.mjs';
const connection = connectionConfig({
  coordinator: coordinatorHttps,
  credential: { poolId: 'local-owner', nodeId, nodeName, token },
  model: { digest: contract.modelDigest, runtime: contract.runtime,
           template: contract.template, context: contract.context },
});
// connection은 비공개 relay-provider-<nodeId>.json으로만 저장한다.
// 토큰을 console.log나 보고서에 출력하지 않는다.
```

위 import는 저장소 루트에 둔 도구 기준이다. 다른 폴더의 도구는 실제 모듈 위치를 기준으로 import 경로를 조정한다. 노드 연결 파일은 지정 B에만 전달하고, 공유 ZIP·Git·최종 보고서에 포함하지 않는다.

등록 직후 `status: online`이라도 접속을 증명하지 않는다. 실제 `poll`이 와야 `connected`와 `lastSeen`이 갱신된다. B 연결 전엔 다음 단계의 성공을 기다린다.

## 7. B — 계측을 시작하고 참여 실행

Codex는 다음 동작을 수행하는 검수 컨트롤러를 로컬에 작성해 실행한다. 기존 제공자 구현을 재사용하며 가짜 `submit`이나 제품 소스 변경으로 성공을 만들지 않는다.

1. `setup_gui.read_connection(path)`으로 연결 JSON을 읽고 `https` origin·노드 ID·풀·문맥을 검사한다. `compute_contract`와 `match_contract`로 실제 파일을 비교한다.
2. 참여 전 10초 이상, GPU UUID별 VRAM을 1초 간격으로 기록한다. 중앙값을 `baselineMiB`, 최대−최소를 `baselineRangeMiB`로 저장한다. 대상 GPU에 다른 부하가 크면 원인을 기록하고 조건을 안정화한 뒤 재측정한다.
3. `setup_gui.WorkerProcess(queue.Queue())`의 `start(connection, files, 8081, 99)`로 참여를 시작한다. 토큰은 기존 구현이 stdin으로 전달한다. 컨트롤러는 끝까지 살아 있어야 한다.
4. 메시지 큐의 `log`와 `exit`, worker PID, 그 worker가 시작한 llama-server의 PID·부모 PID·실행파일 경로를 기록한다. 명령줄 기록은 토큰을 포함하지 않는지 검토한다.
5. 로드 완료를 확인하고 **작업 없는 상태로 15초** 계측한다. B가 A에 `READY_FOR_JOB`와 nodeId·runId를 전달한 후 A에서 작업을 제출한다. 준비 전 무한 대기하지 않는다.
6. 작업 중에도 동일 계측을 유지한다. 샘플마다 UTC 시각·단계·GPU UUID·VRAM used/free·utilization을 기록한다. 짧은 작업을 놓쳤으면 새 작업으로 반복하고 전체 GPU 실행 시간은 기본 15분을 넘기지 않는다.
7. `finally`에서 반드시 `worker.stop()`을 호출하고 worker 및 소유 자식이 종료될 때까지 기다린다. 기본 정리 기한 30초, VRAM 반환 관측 기한 60초다. 종료 실패도 보고한다.

계측 명령 예:

```powershell
nvidia-smi --query-gpu=timestamp,uuid,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory --format=csv,noheader,nounits
Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine
```

각 명령의 실패·`N/A`도 원본에 기록한다. Windows 드라이버에서 프로세스별 VRAM이 제공되지 않으면 OS의 해당 PID GPU 엔진/전용 메모리 계측 등으로 보완한다. 다른 프로세스와 구분할 수 없으면 GPU 연산 증거는 INCONCLUSIVE로 남긴다.

현재 제공자는 모델을 **작업 배정 전에** 적재하므로 유휴 VRAM 증가가 정상이다. `--gpu-layers 99`는 실행 옵션이며 CUDA 사용 증명이 아니다. 일반 제공자는 llama-server stdout/stderr를 버리므로 존재하지 않는 offload 로그를 증거로 요구하지 않는다. 계측이 부족해 진단 실행을 추가한다면 기존 worker를 먼저 중지하고, 같은 파일·옵션의 런타임 로그를 별도 수집하며 Relay 작업 자체의 성공 증거와 구분한다.

Windows에서 Python 부모에 `Stop-Process`만 호출하거나 모든 `llama-server`를 종료하지 않는다. `WorkerProcess`의 stop/Windows Job 정리를 사용하고, 비정상 종료 시에도 기록한 소유 PID·생성 시각을 확인한다. CLI `--once`는 작업이 없으면 계속 대기하므로 전체 타임아웃을 대신할 수 없다.

## 8. A — B에만 실제 작업 보내기와 결과 확인

B가 준비 완료를 알리면 관리자 세션에서 다음 payload를 `action: create`, `mode: live`로 보낸다. `RUN_ID`, 모델 ID, B 노드 ID는 실제 값으로 치환한다. B마다 고유한 문자열을 사용한다.

```json
{
  "title": "remote-vram-RUN_ID",
  "modelId": "실제-modelId",
  "publicData": true,
  "payer": "requester",
  "fields": ["제품명", "검수코드"],
  "documents": [{
    "title": "공개 합성 검수 문서",
    "url": "",
    "text": "제품명: Relay Remote GPU Test\n검수코드: RUN_ID"
  }],
  "budget": 10,
  "minutes": 10,
  "allowedNodes": ["실제-B-nodeId"]
}
```

합성 **입력 문서**를 실제 LLM이 추론하는 검사다. 결과를 `fixture()`로 생성하거나 직접 제출하면 실패다. `allowedNodes`를 생략하면 다른 노드가 대신 실행할 수 있으므로 반드시 B 한 개만 지정한다.

`GET /api/relay`를 약 3초 간격으로 조회하고 jobId로 해당 작업을 찾는다. 기본 대기 상한은 10분이다. 다음을 검사해 필요한 상태만 저장한다.

- `job.status == completed`, `task.status == settled`, `task.quality == passed`.
- `task.acceptedNode == B nodeId`, 해당 attempt의 nodeId·ID·epoch가 일치한다.
- 두 item의 값이 각각 `Relay Remote GPU Test`, 해당 RUN_ID이며 원문 인용과 `verified == true`가 일치한다. `quality`만 보지 말고 값도 확인한다.
- task receipt와 B의 `Settled receipt:` 로그가 일치한다. 실제 `Running assigned document` taskId도 대조한다.
- 해당 taskId의 settlement 원장은 **1건**, 해당 job의 `spent == 10`, `reserved == 0`; 제공자 9 CR·운영자 1 CR이다.

타임아웃이면 상태·attempt·B 로그를 수집한 후 **그 검수 작업만** `action: cancel, payload: {jobId}`로 정리한다. 원장에 비용이 있어도 결과가 틀리면 품질 성공으로 보지 않는다. 품질 재호출은 별도 비용이므로 자동 반복은 새 검수 작업 최대 3건·총 30 CR까지로 제한하고 모든 시도를 보고한다.

## 9. 회수·재개와 최종 판정

A의 회수 명령은 `action: pause, payload: {nodeId}`다. `recall`이라는 API는 없다. B가 계측 중인 것을 확인하고 호출 시간을 기록한다.

1. 성공 작업 뒤 유휴 모델을 pause한다. B 소유 llama-server 종료·VRAM 반환을 확인한다. 기본 기준은 30초 안에 PID 종료, 60초 안에 VRAM이 baseline 허용 범위로 복귀, 이후 15초간 자동 재적재 없음이다.
2. `action: resume` 후 재적재·새 B 전용 작업 성공을 확인한다. 연결 JSON을 다시 발급하지 않고 같은 노드로 복구되어야 한다.
3. 전체 PASS에 필요한 진행 중 회수는 A에서 실제 `leased` attempt와 B의 실행 시작을 관찰한 뒤 pause해 검사한다. 회수 전에 이미 완료됐으면 해당 검사는 NOT RUN으로 남기고 새 작업으로 재시도한다. 철회된 attempt가 이후 수락·정산되지 않아야 한다. 재배정 대기 작업은 이 검수의 jobId만 취소한다.
4. 마지막에는 B의 worker를 stop하고 대상 PID가 남지 않았는지·VRAM이 돌아왔는지 확인한다. A의 테스트 서버는 후속 연결을 위해 유지하고 B 노드는 paused로 남긴다. 노드 폐기 `revoke`는 이 테스트의 기본 종료 동작이 아니다.

실행 전에 고정할 메모리 판정 규칙: `noiseAllowanceMiB = max(128, 3 × baselineRangeMiB)`, 로드 구간 중앙값−baseline이 `max(256, 2 × noiseAllowanceMiB)` 이상이고 대상 PID 메모리와 연관되어야 점유 PASS다. 회수 후에는 `baselineMiB + noiseAllowanceMiB` 이하를 5회 연속 관측한다. 이는 기본 실험 기준이며 모델·드라이버에 따라 실행 전 조정하고 이유를 기록한다. 결과를 본 뒤 성공에 맞춰 기준을 낮추지 않는다.

| ID | 검사 | PASS에 필요한 증거 |
|---|---|---|
| T01 | 다른 물리 PC | A/B 호스트·실행 위치 구분, B GPU UUID; A의 GPU 정보는 GPU가 있을 때만 |
| T02 | 다운로드·설정 | ZIP SHA-256, 필수 파일, 실제 계약 해시·문맥 일치 |
| T03 | 원격 연결 | B Python의 검증된 HTTPS 통신, A의 B lastSeen 갱신 |
| T04 | B VRAM 점유 | baseline/load 시계열·증가량·B의 소유 런타임 PID |
| T05 | B의 GPU 연산 | 해당 PID의 GPU 엔진/활동 증거와 실제 추론 구간의 시간 연관 |
| T06 | 실제 결과·정산 | B acceptedNode, 고유 입력 결과·인용, receipt 일치·중복 없는 정산 |
| T07 | 회수·메모리 반환 | pause 시각, PID 소멸, VRAM 복귀, 재적재 없음 |
| T08 | 재개 | resume 후 새 실제 작업 성공과 같은 B 노드 |
| T09 | 진행 중 회수 | 활성 attempt 관찰 후 철회, 이후 해당 attempt 수락 없음 |
| T10 | 최종 정리 | 검수 worker·자식 없음, VRAM 복귀, 잔여 검수 작업 예약 없음 |

주 경로 종합 PASS는 T01~T10이 모두 PASS일 때만 부여한다. 단일 항목은 `PASS / FAIL / BLOCKED / NOT RUN / INCONCLUSIVE`로 기록한다. T04만 통과하면 **VRAM 점유 확인**, T05 증거가 없으면 **실제 GPU 연산 미확인**, T09를 못 잡았으면 **진행 중 회수 미검증**이라고 범위를 분리한다. 단위 테스트 통과·GUI 연결 표시·VRAM 등록 숫자는 T04~T06의 대체 증거가 아니다.

선택 장애 검사: 테스트 경로만 한정해 연결 단절·느린 응답을 주고 lease 만료 시 회수, 서버 복구 후 재참여를 측정한다. 다른 사용자의 네트워크를 차단하지 않는다. 미실행이면 NOT RUN으로 남긴다. 기본 lease 30초·시도 hard stop 180초이며, 서버 만료 시각·로컬 회수 시작·실제 VRAM 반환 시각을 구분한다. 고의 단절 중에도 이전 attempt의 중복 정산은 없어야 한다.

## 10. 보고서와 실패 처리

`remote-vram-report.md`와 `.json`에는 다음을 포함한다.

- RUN_ID, 시작/종료 UTC, A/B 식별 정보, OS·드라이버·Python·런타임 버전, ZIP 및 세 계약 해시, context·gpu-layers.
- nodeId/modelId/jobId/taskId/attemptId/epoch/receipt. **관리자 키·노드 토큰·세션 쿠키는 제외**.
- baseline·idle loaded·inference peak·released VRAM MiB, 적용 임계값, PID·GPU UUID, pause→PID 종료→VRAM 복귀 시간.
- T01~T10 각각의 판정·이유·증거 파일·시간 구간. 재시도 전부와 품질 실패도 포함.
- 최종 서버·노드·worker 상태, 남은 단계와 정확히 필요한 입력.

증거 파일 예: `gpu-samples.csv`, `gpu-processes.jsonl`, `worker.log`, `events.jsonl`, `model-contract.json`, `job-result.json`, `settlement.json`. 전체 DB·전체 환경변수·연결 파일을 덤프하지 않는다. 보고서 공유 전 비밀키가 없는지 검사한다.

| 현상 | 다음 점검 |
|---|---|
| ZIP 401 | A 관리자 세션에서 다운로드했는지 확인; B 키로 재시도하지 않음 |
| 원격 주소 거부/TLS 오류 | 실제 HTTPS origin, 인증서 체인·Python 신뢰, 프록시·DNS |
| 연결 파일 해시 불일치 | B의 실제 모델·실행파일·템플릿·context와 등록 계약 비교 |
| 연결됐지만 queued | live 모드, 모델 ID, allowedNodes, paused, VRAM·문맥 조건 |
| llama-server 시작 실패 | 필요한 DLL, GPU backend, 포트 충돌, `/props`·템플릿 계약 |
| 모델은 적재되지만 실제 작업 실패 | `/v1/chat/completions/input_tokens` 지원, context, provider 로그·attempt reason |
| 완료됐지만 GPU 증거 없음 | CPU 실행/다른 프로세스/샘플 누락 조사; 성공으로 추정하지 않음 |
| pause 후 VRAM 유지 | 소유 PID가 남는지, 다른 프로세스 증가인지 분리; 테스트 PID만 정리 |

실행 가능한 선행 회귀 검사는 A의 저장소에서 `node --test tests/setup.test.mjs tests/launcher.test.mjs`와 `python -m unittest discover -s tests -p "audit_provider_test.py" -v`다. 이는 설치·제공자 제어 회귀이며 실제 원격 VRAM 검사의 합격 근거가 아니다. 배포 코드와 테스트 코드가 다른 버전이면 그 사실을 기록한다.

## 11. 별도 검사 — 하나의 모델을 A/B VRAM에 나누기

목표가 원격 PC에서 전체 모델 실행이 아니라 **한 모델의 레이어·KV를 여러 컴퓨터에 분산**하는 것이라면 위 노드 등록만으로는 완료되지 않는다. A 저장소의 `docs/distributed-inference-ko.md`, `docs/examples/inference.config.json`, `provider/distributed_runtime.py`를 추가로 읽고 다음을 수행한다. 이 문서만 전달받아 해당 설정 파일이 없다면 A에서 함께 받는다.

1. 승인된 사설 LAN 또는 인증·암호화된 overlay에서 B의 RPC worker를 시작하고 leader만 RPC 포트에 접근하도록 제한한다.
2. 실제 RPC 지원 빌드·GPU backend·해시를 확인한다. leader가 `--rpc <B 사설 IP:포트> --list-devices`에서 B 장치를 보는지 확인한다.
3. 모델 메타데이터·장치 순서·GPU별 레이어/가중치/workspace/reserve/KV 예산을 실제 값으로 작성한다. 예제 숫자로 성공 판정하지 않는다.
4. `distributed_runtime.py server`로 leader를 실행하고 동일 `RELAY_INFERENCE_CONFIG`로 Relay를 시작한다. 기존 provider worker는 해당 GPU에서 중지한다.
5. Relay의 분산 LLM API로 실제 요청을 보내고 **각 물리 GPU의 PID·VRAM 증가, 런타임의 실제 배치 로그, 결과 응답**을 함께 보관한다. `/props`나 합산 VRAM 숫자만으로 분산 성공을 선언하지 않는다.
6. RPC 단절 시 실패·격리·미완료 응답 처리와 복구 후 새 요청, 종료 후 양쪽 GPU 메모리 반환을 검사한다.

이 별도 검사 결과는 `distributed-model-test: NOT RUN`으로 시작한다. 주 경로 PASS를 여러 GPU VRAM 결합 성공으로 바꾸어 보고하지 않는다.

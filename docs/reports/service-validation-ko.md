# Relay 서비스 심층 검증 보고서

> 이 문서는 수정 전 검증 기록입니다. 발견한 V01~V10의 후속 변경과 현재 테스트 결과는 [장애 수정·재검증 보고서](service-validation-fixes-ko.md)를 확인하세요. 아래 실패 수치와 소스 지문은 당시 상태를 보존합니다.

검증일: 2026-09-18. 대상은 이 작업 폴더의 **현재 미커밋 변경을 포함한 코드**다. Git HEAD는 `26b4e3f14232e0c9e42a8f9f82d0125c6edd8c6a`이며, HEAD만 체크아웃한 코드에 대한 결과가 아니다.

## 판정

**기본 정상 흐름은 동작하지만, 장애 상황까지 포함해 서비스가 정상이라고 승인할 수 없다.** 기존 Node 91개와 Python 114개 테스트는 모두 통과했고 타입 검사·린트·배포 빌드도 성공했다. 실제 Chrome에서 로그인 → 체험 제출 → 3개 문서 완료 → 30 CR 정산 및 demo/live 분리를 확인했다.

반면 추가 장애·경계 검증 24개 중 16개가 실패했다. 실패 사례를 원인/수정 단위로 묶으면 **확정 결함 10종**이다. 특히 응답 유실 후 작업 중복 생성, 일시적인 연결 종료 후 제공자 영구 종료, 임대 만료 뒤에도 제공자 정리가 시작되지 않는 경로가 운영상 우선 수정 대상이다. 실제 다중 GPU·원격 네트워크·장시간 운전은 이번 검사로 승인하지 않는다.

이번 작업은 검증 요청에 따라 **서비스 구현을 바꾸지 않고**, 재현 테스트와 검증 기준을 추가했다. 아래 실패 테스트는 현재 결함을 드러내기 위해 기대하는 정상 동작을 assertion한다. 실패를 skip하거나 현재의 잘못된 동작에 맞추지 않았다.

## 무엇을 실제로 실행했는가

| 검사 | 결과 | 확인 범위 |
|---|---|---|
| `npm test` | 91 통과, 실패/skip 0 | 코어·유지보수·실제 Node HTTP/SQLite·설정·실행기·분산 planner/gateway |
| 기존 Python 테스트 | 114 통과, 실패/skip 0 | 제공자·GUI·모델/연결 탐색·GGUF·분산 실행기; 실제 추론 대신 합성 응답 |
| `npm run check` | 통과 | TypeScript; `.mjs` 전체를 엄격하게 타입 검사하는 것은 아님 |
| `npm run lint` | 통과 | 설정된 app/lib/standalone/scripts/hooks 범위 |
| `npm run build` | 통과 | Vite 배포 화면 생성 |
| 추가 코어 테스트 | 2 통과 / 4 실패 | 메모리 저장소·가상 시각, 실패 격리·입력·권한 경계 |
| 추가 추론 테스트 | 1 통과 / 6 실패 | 가짜 upstream의 JSON/SSE 및 준비 단계 취소·시간 제한 |
| 추가 HTTP 테스트 | 2 통과 / 3 실패 | 실제 임시 서버의 잘못된 본문 처리와 오류 후 사용 가능 여부 |
| 추가 브라우저 테스트 | 1 통과 / 1 실패 | 실제 격리 Chrome, 정상 체험 및 저장 완료 후 응답 유실 |
| 추가 Python 테스트 | 2 통과 / 2 실패 | 실제 loopback 연결 종료·가상 갱신 timeout 및 제출 재시도·회수 대조군 |

추가 검사 숫자는 **leaf 테스트 기준**이다. Node TAP은 자식 실패를 집계하는 부모 테스트도 실패로 세므로 CLI 마지막 합계와 다를 수 있다. Python의 추가 4개 중 하나는 assertion 실패, 하나는 미처리 예외 ERROR이며 2개 대조군은 통과했다. 기존 Python 114개 결과는 `audit_provider_test.py` 추가 전 실행 결과이며, 최종 전체 discover도 실행해 총 118개 중 116개 통과, assertion 실패 1개와 미처리 예외 ERROR 1개, skip 0을 확인했다(35.269초). 추가 결함 2개 외의 기존 114개와 새 대조군 2개는 통과했다.

Node v22.17.0 / npm 10.9.2 / Python 3.13.5 (`C:\Python313\python.exe`) / Windows 환경에서 실행했다. 로컬 전용 임시 HTTP 서버·SQLite 디렉터리와 자동 생성한 테스트 인증값을 사용했다. 운영 `.relay`와 실제 연결 파일/키는 읽거나 수정하지 않았다. 전용 브라우저 도구는 Windows ACL 오류로 시작되지 않아, 설치되어 있던 Playwright와 격리 headless Chrome으로 UI 동작을 검증했다. GPU 추론을 수행하지 않았으며 화면 캡처에 대한 별도 시각 품질 판정은 포함하지 않는다.

## 확정 결함과 수정 완료 기준

우선순위 P1은 운영 전 우선 해결할 문제, P2는 해당 입력/장애 조건을 지원하려면 해결해야 하는 문제로 사용한다. 보안 침해나 실제 금전 손실을 관측했다는 의미는 아니다. CR은 현재 서비스의 내부 크레딧이다.

### V01 · P1 · 저장 후 응답 유실 시 화면 재시도가 작업을 중복 생성

- 위치: [app/page.tsx:389](../../app/page.tsx#L389), 작업 제출 [app/page.tsx:539](../../app/page.tsx#L539).
- 재현: Chrome에서 예제 작업을 제출한다. 요청을 실제 서버에 전달해 HTTP 200과 DB 반영까지 받은 뒤, 브라우저로 가는 응답만 `connectionreset`으로 끊는다. 열린 동일한 폼에서 작업 실행을 다시 누른다.
- 관측: 요청 2회, 서로 다른 requestId 2개, 실제 생성된 job 2개. 정상 흐름 대조군에서는 동일 예제 1건이 완료되고 30 CR만 정산됐다.
- 영향: 서버의 멱등성 구현이 있어도 UI가 재시도마다 ID를 새로 만들어 동일 작업에 별도 예약·실행·정산이 발생한다. 실측은 demo의 중복 생성이며 live 영향은 같은 UI/서버 생성 경로에 근거한 추론이다. 각 job 내 이중 정산을 발견한 것은 아니다. 노드 등록에도 새 requestId/키를 만드는 유사 코드가 있지만 그 화면의 응답 유실은 별도로 실증하지 않았다.
- 통과 기준: 같은 제출 시도의 내용과 requestId를 결과가 확정될 때까지 유지한다. 응답 유실 후 재전송은 job 1개·예약 1개·문서별 지급 1회여야 한다. 사용자가 명시적으로 새 작업을 생성하거나 내용을 변경한 경우는 별도 요청으로 처리한다.
- 증거: [audit-browser.test.mjs](../../tests/audit-browser.test.mjs), `work/validation-browser/` 캡처. 브라우저 결과 로그: `{"scenario":"committed-response-loss","requests":2,"distinctRequestIds":2,"createdJobs":2}`.

### V02 · P2 · 일시적인 연결 종료가 제공자 worker를 영구 종료

- 위치: [provider/provider.py:168](../../provider/provider.py#L168), 동일 배포 사본 `public/provider.py`.
- 재현: 실제 loopback HTTP 서버가 첫 상태 요청에서 응답 없이 연결을 닫고, 다음 요청부터 정상 응답하도록 한다.
- 관측: `http.client.RemoteDisconnected`가 run의 복구 예외 목록에 없어 밖으로 전파된다. 자동 재요청 없이 worker가 종료된다. 정리 finally는 실행된다.
- 영향: 서버/프록시의 일시적인 연결 종료가 제공자 수동 재시작을 요구하는 가용성 장애가 된다. 모든 네트워크 오류가 누락된 것은 아니며 URLError/TimeoutError 등은 기존 복구가 있다.
- 통과 기준: 연결 종료·reset·읽기 단절을 구분해 한정된 backoff로 복구하고, 활성 작업은 남은 lease 안에서만 유지한다. 인증 폐기/계약 오류는 계속 중단해야 한다. 실제 연결 종료 후 다음 정상 상태 요청을 받아야 한다.
- 증거: [audit_provider_test.py](../../tests/audit_provider_test.py), [제공자 상세 기록](validation-provider-notes.md).

### V03 · P2 · 갱신 요청 대기 중 lease가 만료돼도 정리 시작이 늦음

- 위치: [provider/provider.py:43](../../provider/provider.py#L43), [provider/provider.py:143](../../provider/provider.py#L143), [provider/provider.py:172](../../provider/provider.py#L172).
- 재현: 서버의 최초 lease 30초, 제공자의 안전 시한 25초 조건에서 갱신 네트워크 실패를 5초 → 12초 → 12초 지연으로 주입한다.
- 관측: **가상 단조 시계 36초에서 처음 stop_runtime이 호출**된다. 서버 lease 만료보다 6초 늦다. 물리 GPU 메모리 반환을 측정한 결과가 아니다.
- 원인/영향: 요청 시작 전에만 시한을 확인하고, 남은 시한이 1초여도 고정 12초 네트워크 timeout을 사용한다. 서버가 다른 제공자에게 재배정하는 동안 이전 제공자 계산이 지속될 수 있다. 오래된 결과의 서버 수락/중복 지급은 기존 fencing이 막는다.
- 통과 기준: 각 요청·재시도·sleep을 남은 단조 시계 예산으로 제한하거나 독립 watchdog으로 정리를 시작한다. 미확인 갱신 때문에 만료 후까지 GPU 계산을 계속하지 않아야 한다. 프로세스 종료와 물리 VRAM 반환 상한은 실제 장비에서 따로 측정한다.
- 증거: [audit_provider_test.py](../../tests/audit_provider_test.py).

### V04 · P2 · 허용 길이의 체험 문서 하나가 다른 정상 작업까지 실패시킴

- 위치: [engine.mjs:78](../../lib/relay/engine.mjs#L78), `:83`, `:128`; [service.mjs:23](../../lib/relay/service.mjs#L23).
- 재현: `license: ` + `가`.repeat(3991), 총 4,000 UTF-16 문자 문서와 짧은 정상 문서를 같은 demo 풀에 제출한다.
- 관측: 입력은 허용되지만 fixture가 값/인용에 긴 줄을 중복해 결과 12,000바이트 제한을 넘는다. tick 전체 저장이 취소된다. 90초 가상 진행 후 정상 문서까지 attempts=3, task=`failed`, job=`partial`로 종료됐다.
- 통과 기준: 허용된 체험 입력을 결과 상한 안에서 처리하거나 해당 task만 명시적으로 실패시킨다. 무관한 정상 문서는 완료되고 재시도 횟수를 잃지 않아야 한다. 이 재현은 demo 경로이며 실제 GPU 경로가 동일하게 실패한다고 판정한 것은 아니다.
- 증거: [audit-core.test.mjs](../../tests/audit-core.test.mjs), [코어 상세 기록](validation-core-notes.md).

### V05 · P2 · 잘못된 allowlist 형식이 제한 없는 배정으로 바뀜

- 위치: [engine.mjs:153](../../lib/relay/engine.mjs#L153).
- 관측: `allowedNodes:"demo-2"`를 받으면 400 대신 `[]`로 저장하고 실제 `demo-0`에 배정한다. 정상 UI의 배열 입력에서는 재현되지 않는다.
- 통과 기준: 속성 생략/빈 배열과 잘못된 타입을 구별하고, 명시한 값이 배열이 아니면 상태 변경 없이 400으로 거절한다.
- 증거: [audit-core.test.mjs](../../tests/audit-core.test.mjs).

### V06 · P2 · 잘못된 heartbeat가 새 lease를 발급받음

- 위치: [engine.mjs:114](../../lib/relay/engine.mjs#L114).
- 관측: 만료된 `epoch:1`과 `attemptId:""`를 전달하면 갱신 거절 대신 신규 배정으로 해석되어 epoch 2/attempt 2를 받는다.
- 통과 기준: attemptId 또는 epoch가 존재하면 두 값의 형식/일치/유효 시각을 모두 검사한다. 잘못된 갱신은 400/409로 거절하고 신규 claim을 수행하지 않는다. 동일 인증 제공자의 잘못된 프로토콜 문제이며 타인 권한 획득으로 확인된 것은 아니다.
- 증거: [audit-core.test.mjs](../../tests/audit-core.test.mjs).

### V07 · P2 · 입력 null이 저장소 장애 503으로 잘못 분류

- 위치: [engine.mjs:145](../../lib/relay/engine.mjs#L145), [server.mjs:62](../../standalone/server.mjs#L62), 로그인/제공자 분기와 [service.mjs:37](../../lib/relay/service.mjs#L37).
- 관측: `documents:[null]` 및 `/api/login`, `/api/provider`, `/api/launch-login`의 본문 `null`에서 TypeError를 발생시켜 “저장소에 연결하지 못했습니다” 503을 반환한다. 실제 DB 장애가 아니다. launch-login 재현은 로컬 자동로그인 기능이 활성화된 격리 서버에서 수행했다.
- 통과 기준: 최상위 JSON 객체와 중첩 원소 타입을 검사하고 400을 반환한다. 실제 저장소 장애만 503으로 처리한다. 정상 로그인/조회가 이후 가능한지와 저장 상태 불변을 함께 검사한다.
- 대조군: 문법이 틀린 JSON은 400, 90KB 초과는 413, 오류 요청 후 정상 로그인/조회는 200이었다.
- 증거: [audit-http.test.mjs](../../tests/audit-http.test.mjs), [audit-core.test.mjs](../../tests/audit-core.test.mjs).

### V08 · P2 · SSE 오류/잘못된 본문을 성공으로 집계

- 위치: [inference.mjs:224](../../lib/relay/inference.mjs#L224).
- 관측: 오류 객체, JSON이 아닌 문자열, finish_reason이 null인 미완료 delta 각각에 `[DONE]`를 붙이면 응답 읽기가 정상 종료되고 requests=1/failures=0이 된다. 완료 판정이 DONE 존재 여부에만 의존한다.
- 통과 기준: 청크 경계를 고려한 SSE 프레임과 지원 응답 계약을 검사한다. 오류/깨진 JSON/미완료 종료는 실패 집계 및 KV 정리로 처리한다. 이미 전송한 HTTP 200을 바꿀 수 없으므로 스트림의 오류 종료/오류 신호를 기준으로 검증한다.
- 증거: [audit-inference.test.mjs](../../tests/audit-inference.test.mjs), [추론 상세 기록](validation-inference-notes.md).

### V09 · P2 · JSON의 빈 message가 정상 완료·캐시로 처리

- 위치: [inference.mjs:209](../../lib/relay/inference.mjs#L209).
- 관측: `choices:[{message:{},finish_reason:"stop"}]`도 HTTP 200/성공으로 처리한다. 화면은 이후 별도 오류로 표시하므로 서버 성공 상태와 사용자 결과가 다르다.
- 통과 기준: 역할, 텍스트/reasoning/유효 tool_calls 중 지원 형태, 완료 사유의 일관성을 검사한다. 빈 message는 503/실패이며 성공 영수증으로 보관하지 않는다. reasoning-only/tool-call 정상 응답을 막지 않아야 한다.
- 증거: [audit-inference.test.mjs](../../tests/audit-inference.test.mjs).

### V10 · P2 · 추론 준비 단계에서 취소/요청 timeout이 대기에 적용되지 않음

- 위치: [inference.mjs:116](../../lib/relay/inference.mjs#L116), `:187`.
- 관측: 최초 `/health` 응답을 대기시킨 뒤 취소하거나 requestTimeoutMs=1000을 설정해 1.2초를 기다려도 health 신호는 중단되지 않고 active=1이 유지된다. 준비 단계는 별도의 최대 10초 health timeout 등을 따른다.
- 통과 기준: 취소/timeout 이후 요청별 대기를 끝내고 불필요한 점유를 해소한다. 공유 준비 작업을 다른 정상 요청이 쓰고 있다면 그것까지 취소하지 않는다. 이미 사용한 KV를 erase ACK 전에 재배정하지 않는 안전 계약은 유지하며, 별도 cleanup 시간 상한을 문서화한다.
- 증거: [audit-inference.test.mjs](../../tests/audit-inference.test.mjs). 현재 테스트는 최초 1개 요청의 준비 지연에서 해당 요청의 종료와 예약 반환을 검사한다. 공유 upstream fetch 자체의 취소를 강제하지 않는다.

## 앞으로 사용할 정상 동작 기준

| 영역 | 승인 기준 | 이번 판정 |
|---|---|---|
| 시작/배포 | 빌드 후 서버·화면 기동, 인증 후 주요 기능 접근, 실제 소스와 배포 ZIP 계약 일치 | 기존 테스트/로컬 브라우저 통과; 새 PC의 완전한 설치는 미검증 |
| 인증/격리 | 관리자·제공자·tenant 분리, 폐기 키 거절, demo/live 분리, 타인 결과 제출·모델 접근 금지 | 기존 합성/HTTP 검사 통과 |
| 입력 | 모든 타입/길이/상호 의존 필드가 명시적으로 검증되고 오류 시 제한을 완화하지 않음 | **실패 V05~V07** |
| 정산 | 계정합=발행량, 잔액/예약 음수 없음, task당 1회 지급, 결과/지급/예약 해제 원자적 저장 | 기존 및 추가 정산 대조군 통과 |
| 사용자 재시도 | 저장 후 응답 유실·중복 클릭·동시 재전송에도 하나의 사용자 제출은 하나의 효과 | **실패 V01**; 서버에 동일 ID를 보낸 경우는 기존 검사 통과 |
| lease | 서버 30초 lease/180초 hard stop, 오래된 결과 거절, 제공자는 미확인 시한까지 정리 시작 | 서버 경계 통과, **제공자 실패 V03**, 갱신 형식 **V06** |
| 장애 복구 | 연결 단절 후 bounded retry, 폐기/회수 시 종료, 한 task 오류가 다른 task를 실패시키지 않음 | **실패 V02/V04** |
| 추론 응답 | 문맥 초과는 생성 전 거절, 완전한 JSON/SSE만 성공, 오류는 실패 집계·캐시 정리 | 문맥 검사 통과, **실패 V08/V09** |
| 취소/자원 | 취소·timeout은 준비/실행 대기에도 적용; KV 삭제 ACK 전 슬롯 반환 금지 | 실행 중 ACK/격리 기존 검사 통과, 준비 단계 **V10** |
| 재시작/저장 | 완료 정산/영수증 보존, 기한 만료 정리 재개, 백업 복구 시 동일 불변식 | 정상 SQLite 재시작 통과; 전원 단절/디스크 가득 참/복원 실험 미검증 |
| 실제 GPU/원격 | 승인 모델로 결과 생성, 취소·OOM·RPC 중단 시 복구와 VRAM 반환 확인 | **이번에는 미검증** |
| 성능/운영 | 대상 GPU·동시성·문서/토큰 규모별 지연/실패율/메모리 측정, 합의한 SLO 충족 | **기준 합의 및 실측 필요** |

“인용 검증 통과”는 인용이 원문에 존재한다는 뜻이다. 추출 값의 의미적 정확성·추론 품질·사용자 의도 충족을 모두 보장하지 않는다. 대표 문서와 사람이 판정한 정답셋은 별도 검증 기준으로 필요하다. README의 과거 로컬 GPU 1건 기록은 이번 실행 결과로 합산하지 않았다.

## 재현 명령

```powershell
# 기존 Node 회귀, 정적 검사와 빌드
npm test
npm run check
npm run lint
npm run build

# 추가 발견사항: 수정 전에는 비정상 종료 코드가 예상된다.
node --test tests/audit-core.test.mjs tests/audit-http.test.mjs tests/audit-inference.test.mjs
python -m unittest discover -s tests -p "audit_provider_test.py" -v

# Python 전체: 현재는 기존 114개 + 추가 4개를 포함한다.
python -m unittest discover -s tests -p "*_test.py" -v

# Chrome + Playwright가 설치된 환경에서 실제 UI 재현
node --test tests/audit-browser.test.mjs
```

브라우저 테스트는 프로젝트의 런타임 의존성에 Playwright를 추가하지 않았다. 현재 환경에서는 `RELAY_AUDIT_PLAYWRIGHT`를 번들 `playwright/index.mjs`의 절대 경로로 설정하여 실행했다. 다른 설치의 브라우저는 `RELAY_AUDIT_BROWSER`에 실행 파일 경로를 지정할 수 있다. 테스트 서버는 `tests/audit-server-helper.mjs`가 loopback의 임의 포트와 `work/validation-*` SQLite 디렉터리를 사용해 만들고 종료한다. `work/`에는 시험용 상태가 남을 수 있으며 배포 대상이 아니다.

최종 일괄 실행 로그는 `work/validation-audit-node-output.txt`와 `work/validation-audit-python-output.txt`에 저장했다. Node 추가 검사는 부모 테스트 2개를 포함한 TAP 합계 22개/통과 6개/실패 16개이며, leaf 기준 20개/통과 6개/실패 14개다.

현재 환경의 재현 설정:

```powershell
$env:RELAY_AUDIT_PLAYWRIGHT = 'C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright\index.mjs'
node --test tests/audit-browser.test.mjs
```

## 운영 승인 전에 남은 실험

1. V01~V10의 실패 재현을 모두 통과시키고, 기존 정산·권한·취소 보호 테스트도 유지한다.
2. 실제 제공자에서 서버 재시작, 응답 유실, RST/정상 연결 종료, 느린 응답, 키 폐기, 작업 회수를 주입한다. 서버 승인 시각·제공자 정리 시작/종료·VRAM 반환 시각을 함께 기록한다.
3. 목표 다중 GPU 그룹의 최대 슬롯·최대 문맥에서 OOM/RPC peer 종료/네트워크 분리를 재현한다. stale 출력 거절, KV 격리, 준비 재시도와 정상 요청 복귀를 확인한다.
4. 격리 운영 사본에서 디스크 가득 참, 쓰기 권한 오류, 프로세스 강제 종료, 백업 복원을 검사한다. 현재의 정상 종료 후 SQLite 재열기만으로 이 항목을 통과시킬 수 없다.
5. 실제 사용 규모와 목표 p95 지연·성공률·복구 시간·테스트 지속 시간을 합의하고 측정한다. 작은 파일럿의 기능 통과를 다중 장비 성능/상시 서비스 보장으로 확대 해석하지 않는다.

## 소스 지문

| 파일 | SHA-256 |
|---|---|
| `lib/relay/engine.mjs` | `3DB21A19CA6B3CEBADF391778B90E1746C0579534AC32A2D2C95C47E5A562CDF` |
| `lib/relay/service.mjs` | `46384494503C9F8161B6EAB7F89B45A31AE0CF7BF986AD9415F986C5311B42AD` |
| `lib/relay/inference.mjs` | `CDB6C7D5CBD1865064E44E95D38D3471531C34E4647937967D966CCCC22D03BE` |
| `provider/provider.py` | `538CD17A488E6A9FFCBB59A48D2AA11F43C93D5B037F92104B3C7CBCACFAE91D` |
| `standalone/server.mjs` | `F2C3A2A2F3ED31CE6FE8247C104CF7139A6920C5167417C3903B000A0C4A90C9` |
| `app/page.tsx` | `E1571395D8B2CCA5A7D96F5B35293ADF4ACA81EDE34157E90444DB858C983C73` |

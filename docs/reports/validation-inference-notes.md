# 분산 추론 심층 검증 기록

> 수정 전 발견 기록입니다. 후속 수정과 현재 상태는 [수정·재검증 결과](service-validation-fixes-ko.md)를 참고하세요.

검증일: 2026-09-18. 범위: `inference-plan.mjs`, `inference.mjs`, `standalone/server.mjs`의 추론 HTTP 경계와 관련 기존 테스트. 서비스 구현은 변경하지 않았다. 실제 `.relay` 상태, 키, 모델, GPU에는 접근하지 않았다.

## 새 검증 실행 결과

```text
node --test tests/audit-inference.test.mjs
7 tests / 1 pass / 6 fail / 0 skipped
```

새 파일은 바람직한 수용 기준을 검사하는 회귀 테스트다. 실패 6건은 아래 3종의 결함을 재현한다. 기존 `npm test` 목록에는 포함하지 않았으며 결함을 감추려고 skip/TODO 처리하지 않았다. 정상 JSON 대조군은 성공했다. 가짜 fetch/Response만 사용하여 네트워크, 실제 모델, 실제 서비스 데이터에 의존하지 않는다.

## 확정 결함

### INF-01 / P2: SSE의 오류·잘못된 응답을 정상 완료로 인정

- 위치: `lib/relay/inference.mjs:224`~`233`, 성공 처리 `183`.
- 재현: HTTP 200, `Content-Type: text/event-stream`으로 아래 각각을 전송하고 `data: [DONE]` 이벤트 뒤 연결을 종료한다.
  - `data: {"error":{"message":"GPU execution failed","type":"server_error"}}`
  - `data: this is not JSON`
  - `data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}`
- 실제: 응답 읽기가 정상 종료되며 `requests=1`, `failures=0`이다. `finish(true)`가 호출되어 세션 캐시를 성공 캐시로 남긴다.
- 원인: SSE 본문에는 JSON 구조/오류 객체/선택지 수/완료 사유 검사가 없고 `[DONE]` 문자열만 찾는다.
- 영향: 엔진 오류나 불완전한 결과가 정상 완료 통계에 포함된다. API 소비자는 완료된 응답과 실패·불완전한 응답을 게이트웨이의 종료 판정으로 구분할 수 없다. 중간 도구 호출이 포함된 클라이언트는 별도 완료 검증이 필요하다.
- 수용 기준: 청크 경계를 넘는 SSE 프레임을 검증하고, 오류 이벤트 또는 잘못된 JSON/선택지를 실패 처리하며 정상 `finish_reason` 이후의 DONE만 정상 완료로 인정한다. 이미 헤더를 보낸 스트림은 HTTP 상태를 뒤늦게 바꾸는 대신 스트림 오류로 종료하고 KV 정리/실패 통계를 적용한다.
- 기존 공백: `tests/inference.test.mjs:294`의 정상 SSE 예제도 `choices:[]` + DONE을 사용한다. EOF에 DONE이 없는 경우만 기존 실패 테스트가 검사한다.

### INF-02 / P2: JSON 응답의 빈 message를 성공으로 반환

- 위치: `lib/relay/inference.mjs:209`~`212`.
- 재현: 엔진이 `{"choices":[{"message":{},"finish_reason":"stop"}]}`를 반환한다.
- 실제: HTTP 200, `requests=1`, `failures=0`으로 처리한다.
- 영향: `/v1/chat/completions`가 성공이라고 반환한 결과를 클라이언트가 사용할 수 없다. 관리자 화면은 `app/inference-panel.tsx:135`에서 별도로 오류를 발견하지만 서버에는 성공으로 남는다. Idempotency-Key가 있으면 이 잘못된 결과가 성공 영수증으로 재전송될 수 있다.
- 수용 기준: assistant 역할과 실제 텍스트·reasoning·유효한 도구 호출 중 지원하는 응답 형태를 검사하고, 완료 사유와 응답 형태가 서로 일치해야 한다. `message:{}`는 503/실패 처리하되 기존 reasoning-only/tool-call 정상 응답은 계속 허용한다.

### INF-03 / P2: 준비 단계에 요청 취소·설정 시간 제한이 전달되지 않음

- 위치: `lib/relay/inference.mjs:116`~`139`, `187`~`191`. `verify`는 독립 10초 신호, `/slots`는 독립 10초 신호, `erase`는 독립 5초 신호를 사용한다.
- 재현 A: 한 슬롯의 최초 요청을 `/health` 응답 대기 상태로 둔 뒤 클라이언트를 취소한다. health fetch의 신호는 여전히 `aborted=false`, 요청 Promise는 끝나지 않고 예약은 `active=1`이다.
- 재현 B: `requestTimeoutMs=1000`으로 같은 요청을 시작한다. 1.2초 뒤에도 health fetch 신호는 `aborted=false`, 요청 Promise는 끝나지 않고 예약은 `active=1`이다.
- 원인: `complete`의 타이머/클라이언트 신호는 요청 controller만 abort한다. 준비 함수에는 이 신호가 전달되지 않고 `await prepare(group)`가 끝난 뒤에야 검사한다. 따라서 health 하나만 멈춰도 독립 10초 시간 제한까지 대기할 수 있다. 초기 슬롯 정리가 차례로 늦어지면 추가 대기가 발생한다.
- 영향: 중지/시간 제한 이후 필요 없는 준비 작업이 계속되며 예약이 유지된다. 단일 슬롯 그룹은 그동안 다른 요청에 429를 반환한다. 이는 GPU 정리 확인을 위한 의도적인 erase 대기와 구별해야 한다.
- 수용 기준: 요청별 대기가 취소/시간 제한에 반응해야 한다. 공유 prepare가 다른 정상 요청에도 쓰이는 경우 한 요청의 취소로 모두 중단하지 않도록 참조/대기자를 분리한다. KV erase 확인 전 예약을 반환하지 않는 기존 안전 계약은 유지한다. cleanup은 요청 종료와 구분되는 별도의 상한을 문서화한다. 교차 검토 후 테스트는 요청 종료와 예약 반환을 검사하도록 정리했으며, 공유 준비 fetch 자체가 반드시 abort되어야 한다고 강제하지 않는다.

## 코드/기존 테스트에서 확인한 보호 장치

아래는 소스와 기존 테스트를 검토한 결과이며, 이 문서의 7개 실행만으로 전부 새로 검증했다고 주장하지 않는다. 전체 기존 테스트 실행 결과는 상위 검증 보고서를 따른다.

- tenant Bearer 키와 관리자 쿠키가 별도이며 모델 권한·동시 한도와 세션 충돌을 upstream 실행 전에 확인한다.
- 슬롯을 첫 await 전에 예약하고 tenant/session을 함께 캐시 소유자로 사용한다.
- 전체 기록의 정확한 input token + 출력 예약 문맥 경계를 검사한다.
- 소유자 교체·실패·취소에서 erase ACK를 검사하고 실패 시 그룹 epoch 변경/격리를 적용한다.
- 가짜 엔진을 통한 실제 HTTP 테스트가 인증 분리, 429, JSON/SSE 전송, 클라이언트 연결 종료를 검사한다.
- loopback endpoint만 허용하고 upstream redirect를 거부한다. 입력에서 native generation 옵션과 외부 멀티모달 주소를 거부한다.
- SSE 최대 응답 크기, backpressure, DONE 없는 EOF, 읽지 않는 소비자의 취소/timeout 테스트가 있다.
- GPU별 KV 용량은 BigInt로 계산하고 레이어 합계, GPU 중복, 슬롯·문맥·엔진 계약 불일치를 거부한다.

## 별도 실측/정책 한계

- `outputTokens`는 비스트리밍 출력만 센다. 화면에도 “비스트리밍 출력”으로 명시하므로 이번 검토에서는 결함으로 분류하지 않는다. 전체 트래픽의 출력량·비용 측정 기준으로 사용할 수는 없다.
- 모델 파일 해시는 Python 실행기가 검증한다. 게이트웨이의 `/props`/모델 alias 검사는 실제 모델 파일 해시나 GPU별 물리 메모리를 증명하지 않는다.
- 실제 다중 GPU, LAN/WAN 지연, OOM, RPC peer 손실, 드라이버 오류, 강제 종료 후 물리 VRAM 반환, 최대 동시 슬롯의 메모리·응답 지연은 이번 가짜 엔진 검증으로 통과 판정할 수 없다.
- 단일 Relay 프로세스/전용 엔진 계약이고 프로세스 간 GPU 잠금, 유료 임대 정산, 재시작을 넘는 idempotency 보장은 현재 범위 밖이다.
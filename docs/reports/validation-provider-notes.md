# 제공자 및 Python 경로 검증 기록

> 수정 전 발견 기록입니다. 후속 수정과 현재 상태는 [수정·재검증 결과](service-validation-fixes-ko.md)를 참고하세요.

검증일: 2026-09-18. Windows, Python 3.13.5, 실행 파일 `C:\Python313\python.exe`.

## 결과

- 기존 Python 테스트: `python -m unittest discover -s tests -p "*_test.py" -v` → **114 PASS, 0 FAIL, 0 SKIP**, 17.794초. 아래 audit 파일을 추가하기 전 결과다.
- 독립적으로 추가한 수용 기준 4개: `python -m unittest discover -s tests -p "audit_provider_test.py" -v` → **2 PASS, 1 FAIL, 1 ERROR**. 출력은 [validation-provider-output.txt](validation-provider-output.txt).
- 실제 서비스 데이터, 관리자/노드 키, `.relay` 디렉터리를 읽거나 수정하지 않았다. 기존 제품 코드와 기존 테스트도 수정하지 않았다.
- `provider/provider.py`와 배포 사본 `public/provider.py`의 SHA-256은 일치한다.
- 새 테스트는 요구되는 정상 동작을 assert하며 현재 결함 때문에 실패하도록 남겼다. 따라서 새 파일을 포함한 전체 Python discover도 현재 실패한다.

## 확인된 결함

### P2: 응답 전 연결 종료가 worker의 영구 종료로 이어짐

- 위치: `provider/provider.py:168` 예외 분류, `provider/provider.py:29` 실제 HTTP 요청.
- 기준: 인증 폐기나 계약 위반과 구분되는 일시적인 전송 장애에는 자동 복구가 가능해야 한다.
- 재현: 별도의 loopback HTTP 서버가 첫 POST를 읽은 뒤 HTTP 응답 없이 연결을 닫고, 다음 요청에는 정상 응답하도록 구성했다. GPU와 실제 coordinator는 사용하지 않았다.
- 실제 결과: Python urllib가 `http.client.RemoteDisconnected`를 발생시켰다. `Provider.run`의 catch가 해당 예외를 포함하지 않아 두 번째 요청을 보내지 못하고 run이 종료됐다. finally에서는 소유한 runtime 정리 경로를 호출한다.
- 사용자 영향: coordinator 또는 프록시의 일시적인 연결 종료만으로 제공자 참여가 종료되며 수동 재시작이 필요하다. GPU가 고아 프로세스로 남는다는 의미는 아니다.
- 재현 테스트: `tests/audit_provider_test.py:101`.
- 완료 기준: 이 실제 HTTP 재현을 통과하고, 유사한 연결 reset/불완전 응답을 전송 오류로 분류하며, 401/403 및 계약 오류의 중단 규칙은 유지한다.

### P2: lease 갱신 요청 대기가 만료 이후까지 회수를 지연시킴

- 위치: `provider/provider.py:143` 만료 검사와 `:145` 동기 갱신 요청, `:24` 고정 12초 HTTP timeout, `:43` API 래퍼.
- 기준: 마지막으로 확인된 실행 권한이 만료되기 전에 소유한 추론 프로세스의 회수를 시작해야 한다. 서버의 lease는 `lib/relay/engine.mjs:5`에서 30초다.
- 재현: 실제 `Provider.run/api` 제어 흐름, 완료되지 않은 Future, fake monotonic clock, 순서대로 5/12/12초가 걸리고 실패하는 갱신 요청을 사용했다. 초기 작업 배정은 t=0, 로컬 lease 마감은 t=25다.
- 흐름: t=3 첫 요청 → t=8 실패 → t=10 두 번째 요청 → t=22 실패 → t=24 세 번째 요청 → t=36 실패 후 회수 시작. 서버의 초기 실행 권한은 t=30에 끝난다.
- 실제 결과: `stop_runtime` 첫 호출이 **가상 시간 t=36초**에 발생했다. 실제 GPU 중단이나 VRAM 반환 시간을 실측한 결과가 아니다.
- 사용자 영향: 권한이 끝난 작업이 계속 계산될 수 있고 서버가 다른 제공자에게 재배정한 작업과 중복 계산이 발생할 수 있다. 서버의 결과 fencing이 별도로 있으므로 이 재현만으로 중복 정산을 주장하지 않는다.
- 재현 테스트: `tests/audit_provider_test.py:142`.
- 완료 기준: 네트워크 요청과 재시도 대기를 남은 실행 권한 안으로 제한하거나 별도 마감 감시로 회수를 시작한다. socket read timeout은 전체 요청의 절대 마감과 다를 수 있으므로 느린 분할 응답도 검증해야 한다.

## 정상 동작이 확인된 범위

| 기준 | 근거 |
|---|---|
| 결과 저장 후 응답 유실 시 원 결과 payload로 재시도 | 새 audit 테스트 통과. 같은 객체/내용을 2회 제출하며 새 추론을 시작하지 않음 |
| 갱신 중 운영자가 일시정지하면 원 attempt/epoch로 해제 | 새 audit 테스트 통과. status → 신규 poll → fenced renewal → release, submit 없음 |
| 모델/실행파일/템플릿 계약 불일치 및 문맥 초과 차단 | 기존 provider 테스트 통과 |
| HTTP redirect로 제공자 키가 전달되지 않음 | 기존 실제 loopback HTTP 테스트 통과 |
| 비밀키를 자식 추론 프로세스 환경에 전달하지 않음 | 기존 provider 및 분산 launcher 테스트 통과 |
| worker와 자식 프로세스 소유 및 Windows Job 정리 | 기존 실제 자식 프로세스 테스트 통과 |
| 설정 파일 크기/스키마/주소/자격증명, 모델/연결 파일 탐색 제한 | 기존 setup/discovery 테스트 통과 |
| GGUF 메타데이터 크기/형식/중복/배열 및 손상 데이터 거절 | 기존 metadata 테스트 통과 |
| 분산 그룹 해시, 아키텍처/KV 차원, 슬롯/문맥, device/RPC 입력 검사 | 기존 distributed runtime 테스트 통과 |
| 분산 실행 시작 실패/포트 점유/계약 불일치/child 종료 정리 | 기존 launcher mock/socket 테스트 통과 |

## 남은 검증 경계

- 실제 llama.cpp b10964 실행, GPU offload, 텐서 배치, VRAM/KV 사용량, 장시간 추론 및 다중 장비 RPC를 이번 검증에서 실행하지 않았다.
- 분산 launcher 검증의 runtime 응답은 mock이며, GGUF는 메타데이터만 있는 합성 fixture다. 실제 모델 호환성이나 추론 품질을 증명하지 않는다.
- Tkinter GUI 테스트는 이 Windows 환경에서 skip 없이 실행됐다. 실제 사용자의 다운로드 폴더나 연결 JSON을 이용한 검증은 아니다.
- 위 결함 2개 수정 후 audit 4개와 Python 전체를 재실행하고, 네트워크 단절/느린 응답/프로세스 종료를 포함한 실제 GPU 통합 시나리오를 별도로 수행해야 한다.
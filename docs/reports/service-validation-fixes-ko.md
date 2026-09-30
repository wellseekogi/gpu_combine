# 검증된 장애 수정 및 재검증

수정일: 2026-09-18. [수정 전 심층 검증](service-validation-ko.md)의 V01~V10을 대상으로 한다. 기존 미커밋 작업 위에 필요한 변경을 적용했으며 운영 `.relay`, 관리자 키, 실제 제공자 연결 파일은 사용하지 않았다.

## 최종 결과

**V01~V10을 수정했고, 원래 실패했던 회귀와 확장 경계 검사를 포함해 전체 실행이 통과했다.** 실패 assertion을 약화하거나 skip하지 않았다. 기존 정상 SSE 테스트의 `choices:[]`/`data:{}` 합성 응답은 실제 정상 assistant delta/완료 이벤트로 교정했으며, 명시적인 빈 문자열·reasoning-only·도구 호출 응답은 정상 지원을 유지한다.

| 실행 | 결과 |
|---|---|
| `npm test` | **139/139 통과**, 실패·skip 0 |
| `python -m unittest discover -s tests -p "*_test.py" -v` | **128/128 통과**, 실패·skip 0, 20.906초 |
| 빌드 후 `node --test tests/audit-browser.test.mjs` | **5개 실제 Chrome 시나리오 전부 통과**; 부모 포함 TAP 6/6 |
| `npm run check` | 통과 |
| `npm run lint` | 통과 |
| `npm run build` | 통과; `standalone-dist` 갱신 |
| 제공자 배포 사본 | source/public/standalone-dist 세 파일의 SHA-256 동일 |
| `git -c core.whitespace=cr-at-eol diff --check` | 통과 |

브라우저의 응답 유실 시나리오는 `requests:2, distinctRequestIds:1, createdJobs:1`을 확인했다. 해당 3문서 작업의 완료 후 `spent:30`, 정산 영수증 3개도 확인했다. 새 폼은 새 작업을 만들고, 입력을 수정하면 새 ID를 사용하며, PC 등록 응답 유실은 동일 키로 복구 후 실제 제공자 인증까지 통과했다.

실행 원문: [Node 전체](../../work/validation-fix-node-output.txt), [Python 전체](../../work/validation-fix-python-output.txt), [브라우저](../../work/validation-fix-browser-output.txt). 작업 폴더의 `work/`는 Git 배포 대상이 아닌 로컬 검증 산출물이다.

제공자 최종 SHA-256: `7E1B47784C0FB2DE3B1084AA9764C3C78A25D0D69BA7248028CD1F451B74DDCA`.

## 수정 내용

| 발견사항 | 변경 | 회귀에서 확인하는 동작 |
|---|---|---|
| V01 · 응답 유실 후 중복 생성 | 작업·모델·PC 등록 폼에서 동일 mode/action/payload의 requestId 유지. PC 등록 키도 성공 확인까지 유지 | 같은 폼 재시도는 job 1개와 문서별 지급 1회. 명시적으로 새 폼을 열거나 내용을 바꾸면 새 요청. PC 등록 재시도는 node 1개, 복구한 키로 인증 가능 |
| V02 · 연결 종료로 제공자 중단 | connection close/reset, Content-Length 읽기 단절, chunked 응답 단절을 복구 가능한 전송 오류로 처리 | 실제 loopback 장애 뒤 정상 요청 재개. 401/403 키 폐기는 재시도하지 않고 종료 |
| V03 · lease 만료 뒤 정리 지연 | 남은 단조 시각 예산으로 네트워크 timeout·sleep 제한, HTTP 읽기와 독립된 watchdog으로 소유 runtime 정리 | 기존 가상 36초 지연 재현 해소. 느린 분할 응답 중에도 마감 감시가 동작하고 늦은 갱신이 만료 권한을 되살리지 않음 |
| V04 · 긴 체험 문서가 다른 작업 실패 유발 | fixture를 필드당 500자·전체 12,000바이트 안에서 생성. 완전하게 반환할 수 없는 필드는 null 처리 | 긴 한글·제어문자·여러 필드에도 결과 상한 유지. 해당 문서는 partial로 정산하고 다른 정상 문서는 한 번에 완료 |
| V05 · 잘못된 allowlist의 제한 해제 | 배열이 아닌 명시적 allowedNodes를 400으로 거절 | 생략/빈 배열은 기존대로 허용, 잘못된 형식에서는 저장 상태 불변 |
| V06 · malformed heartbeat의 신규 배정 | attemptId 또는 epoch가 있으면 두 값의 형식과 기존 실행 권한을 검사 | 만료 전/후 잘못된 갱신은 400/409이며 새 attempt를 만들지 않음 |
| V07 · 입력 오류의 저장소 장애 오분류 | 최상위 본문·payload·문서 원소가 JSON 객체인지 검사 | null/배열/문자열/숫자/boolean을 400으로 거절. 오류 이후 정상 로그인/조회 가능 |
| V08 · SSE 실패를 성공 처리 | UTF-8/CRLF/프레임 경계를 보존하는 증분 파싱, 오류 이벤트·JSON·choice·finish_reason·DONE 순서 검사 | 손상/미완료 SSE는 실패 집계와 KV 정리. 정상 텍스트·reasoning·분할 tool_calls·usage 이벤트는 통과 |
| V09 · 빈 message 객체를 성공 처리 | assistant 역할과 명시적 텍스트/reasoning 또는 유효한 tool_calls, 완료 사유의 일관성 검사 | message:{}·role-only는 거절하고 성공 영수증으로 저장하지 않음. 명시적인 빈 문자열 응답은 정상 형식으로 유지 |
| V10 · 준비 중 취소/timeout 지연 | 공유 준비에서 요청별 대기를 분리. KV를 사용하기 전 취소된 요청만 예약 반환 | 취소/1초 deadline에 요청이 종료됨. 다른 tenant는 계속 완료. KV 사용 이후에는 erase ACK 전 예약 반환 금지 |

추론 정리는 한 번만 수행하고 모든 종료 경로가 같은 정리 완료를 기다린다. KV 삭제 확인에 별도로 최대 5초를 허용하며 확인 실패 시 그룹 격리를 유지한다. 출력 토큰 통계는 기존의 **비스트리밍 출력만 집계**하는 정책을 유지한다.

제공자 수정의 교차 검토에서 이전 inference가 늦게 끝날 때 대기 중인 작업이 해제 후 시작할 수 있는 경합과, 남은 시간이 짧은 기존 lease를 신규 배정처럼 받아들이는 경계도 확인했다. 이전 Future를 취소하고 종료를 기다린 뒤에만 다음 runtime/배정을 허용한다. 최초 task도 attemptId/epoch가 일치하는 갱신 ACK와 leaseRemainingMs를 확인한 뒤 추론을 시작하도록 보강했고, 두 경계의 회귀도 통과했다. 소스와 배포 사본 `provider/provider.py`, `public/provider.py`는 같은 내용으로 유지한다.

## 실행 방법

```powershell
npm test
npm run test:python
npm run check
npm run lint
npm run build

# Playwright와 Chrome이 준비된 환경
npm run test:browser
```

`npm test`는 기존 8개 Node 테스트 파일에 `audit-core`, `audit-http`, `audit-inference`를 포함한다. 따라서 재현했던 결함이 기본 테스트에서 빠지지 않는다. Python 감사 회귀는 기존 전체 discover에 포함되며 `npm run test:python`으로도 실행할 수 있다.

브라우저 검증은 자동으로 빌드한 다음 별도 Chrome 프로필과 loopback 임의 포트의 임시 서버를 사용한다. 프로젝트에 Playwright 의존성을 새로 설치하지 않았다. 이번 환경에서는 다음 번들 경로를 사용했다.

```powershell
$env:RELAY_AUDIT_PLAYWRIGHT = 'C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright\index.mjs'
npm run test:browser
```

## 보장 범위

- UI의 재시도 ID·노드 키는 열린 페이지의 메모리에 보존한다. 페이지 새로고침/로그아웃을 넘는 복구를 보장하지 않으며, 키를 브라우저 영속 저장소에 추가로 저장하지 않는다.
- 크기가 큰 체험 필드를 임의로 잘라 의미가 달라진 값을 성공으로 반환하지 않는다. 표현할 수 없는 필드는 null/partial로 표시하고 정액 정산과 품질 판정을 구분한다.
- 네트워크 요청 자체가 천천히 계속 응답하더라도 watchdog은 실행 권한의 시한에 runtime 정리를 시작한다. 실제 GPU·드라이버의 물리 VRAM 반환 시간은 이 합성 프로세스 검사로 측정한 것이 아니다.
- 실제 다중 GPU, OOM/RPC peer 장애, 원격 WAN, 장시간 부하, 디스크 고갈/전원 단절과 백업 복원 검증은 이번 수정의 통과 범위에 포함하지 않는다.

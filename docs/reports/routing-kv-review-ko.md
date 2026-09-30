# Petals 라우팅·KV 코드 검토와 Relay 반영

2026-09-24. [이전 아키텍처 결정](../petals-architecture-decision-ko.md)에 이어 실제 라우팅·세션·메모리 코드를 비교했다. EC2 웹·인증·정산·SQLite와 llama.cpp/GGUF 실행기를 유지하며 요청 배정과 기존 KV 보존을 개선한다. Petals 수치나 알고리즘을 그대로 적용한 성능 주장은 하지 않는다.

## Petals 코드에서 확인한 것

| 코드 | 실제 동작 | Relay에 적용할 경계 |
|---|---|---|
| `RemoteSequenceManager` | `min_latency`는 RTT/2·직렬화·블록 처리시간·KV 부족 비용을 합산한 Dijkstra 경로. `max_throughput`은 긴 span에 가중치를 주는 무작위 선택 | 현재 Relay는 완성된 그룹을 선택하므로 가용 슬롯과 캐시 상태를 활용하고 블록 경로 그래프는 추가하지 않음 |
| `InferenceSession` | 서버별 입력 activation history를 보관하고 실패 구간을 교체해 그 구간의 KV를 재계산 | llama.cpp HTTP가 중간 activation을 노출하지 않으므로 선택 예비의 전체 기록 재생성을 유지 |
| `TransformerConnectionHandler` | 세션 `max_length`를 검사한 뒤 cache를 예약하고 session/step timeout과 종료로 해제. `step_id`로 중복 단계를 구분 | 기존 요청 시간 제한·epoch·완료 검증·삭제 확인을 유지 |
| `MemoryCache` | 최대 길이 예약, 제한된 할당 대기, 취소 중 할당 정리. 논리 예약 반환과 runtime의 tensor 삭제는 별도 시점 | 고정 f16 슬롯 예산과 erase ACK 전 슬롯 재배정 금지를 유지 |

`min_latency`에는 미측정 값의 기본 추정치와 KV 부족 penalty가 있다. `max_throughput`은 실제 처리량의 전역 최적해가 아니며 도달 불가 peer도 작은 epsilon 가중치를 받는다. 실패 peer는 임시 blacklist·backoff로 회피하되 해당 블록의 모든 후보가 차단되면 blacklist를 무시하는 예외가 있다. 이번 변경에는 backoff를 추가하지 않았다. [라우팅 원본](https://github.com/bigscience-workshop/petals/blob/main/src/petals/client/routing/sequence_manager.py)

Petals의 복구는 **activation replay이며 KV tensor 이주가 아니다.** 성공 구간까지 전체 모델을 다시 시작하는 대신 실패한 span을 교체한다. 이 동작은 해당 runtime의 입력 history·위치·세션 프로토콜에 의존한다. [세션 원본](https://github.com/bigscience-workshop/petals/blob/main/src/petals/client/inference_session.py)

서버는 `max_length` 전체에 대한 descriptor를 예약한다. `MemoryCache._free()`는 삭제 메시지를 보내고 논리 사용량을 줄이며 실제 tensor 삭제는 runtime이 pipe를 처리할 때 수행한다. 따라서 이를 즉시 물리 VRAM 반환 확인으로 해석하지 않는다. [handler 원본](https://github.com/bigscience-workshop/petals/blob/main/src/petals/server/handler.py), [메모리 캐시 원본](https://github.com/bigscience-workshop/petals/blob/main/src/petals/server/memory_cache.py)

Petals 링크는 검토일의 `main` 기준이며 이후 바뀔 수 있다. 아래 llama.cpp 근거는 Relay 실행 계약의 고정 태그 `b10964`다.

## Relay에 반영한 변경

| 변경 | 해결하는 문제 |
|---|---|
| 소유자를 `tenant + ":" + JSON.stringify([model, workspace, session])`로 식별 | 같은 세션 문자열을 서로 다른 모델에 사용했을 때 불필요한 409 방지, 임차자·공간 격리 유지 |
| 그룹: 같은 세션의 유효 KV → `ready/unchecked/unavailable` → 빈/만료 캐시 슬롯 존재 → 낮은 슬롯 점유율 → 오래된 배정 순서 | 아직 재사용 가능한 다른 세션의 KV를 불필요하게 지우는 배정 감소 |
| 슬롯: 같은 세션 → 빈/만료 캐시 → LRU | 최근 취소로 비워진 슬롯이 있어도 오래된 유효 캐시를 먼저 지우던 문제 방지 |
| 입력 토큰 검사·문맥 확인 후 필요한 KV 삭제 | 잘못된 입력·문맥 초과·토큰 검사 중 취소가 기존 세션 KV를 지우지 않도록 함 |
| erase ACK로 확인한 `cacheEmpty` 추적 | 이미 비운 슬롯을 다시 지우는 중복 요청 제거; 캐시 소유자가 없다는 이유만으로 비었다고 추정하지 않음 |
| 동시 ready 검사는 `group.preparing`으로 공유, 검사 당시 epoch가 같을 때만 실패 무효화 | 중복 health/props/models 호출과 오래된 검사 실패가 새 실행을 중단하는 경합 방지 |

일반 요청은 미예약·제공 가능·빈 슬롯 그룹만 사용한다. 정리 중인 `unavailable` 그룹에 활성 슬롯이 있으면 제외한다. 직접 요청 실패를 다른 그룹에 자동 재전송하지 않으며, 선택 예비가 있는 공간만 기존 전체 기록 재생성 계약을 따른다.

`b10964`의 `handle_count_tokens`는 채팅 입력을 파싱·템플릿 처리·토큰화해 길이를 반환하며 생성 task나 슬롯 KV 변경을 요청하지 않는다. 따라서 입력 수와 출력 예약이 문맥 안에 들어가는지 **슬롯 KV를 지우기 전에** 검사한다. [고정 버전의 입력 토큰 처리](https://github.com/ggml-org/llama.cpp/blob/b10964/tools/server/server-context.cpp#L4993-L5037)

정상 준비된 그룹에서 입력 검사 오류·문맥 초과·토큰 검사 또는 공유 준비 확인을 기다리던 요청의 취소는 이전 `cacheOwner`와 캐시 시각을 보존한다. 초기 준비·복구에서 오래된 엔진 KV를 비우는 절차는 별개다. 요청별 생성 실패 정리의 시작 표시는 실제 생성 호출 직전에 설정한다. 슬롯을 넘기기 위한 erase가 이미 시작됐다면 취소되어도 ACK를 기다리고 기존 KV는 삭제된다. 삭제 실패는 그룹을 격리한다. [고정 버전의 슬롯 erase 처리](https://github.com/ggml-org/llama.cpp/blob/b10964/tools/server/server-context.cpp#L2431-L2453)

`cacheEmpty`는 초기 상태·그룹 무효화·생성 호출 직전에 `false`, 유효한 erase ACK 뒤에만 `true`다. 이미 비었음을 확인한 슬롯에는 중복 erase를 보내지 않는다. 취소된 생성의 cleanup ACK 전에는 busy 예약을 유지한다.

`session_id` 없는 요청은 완료 후 `cacheOwner:null`, `cacheEmpty:false`로 남긴다. 다음 요청이 재사용할 수 없는 익명 세션에 친화성을 부여하지 않는 정책이며 즉시 물리 VRAM 해제를 뜻하지 않는다. 다음 사용자가 재배정받을 때는 필요한 erase를 수행한다. 5분은 캐시 재사용 판단 기준이고 주기적 삭제 보장은 아니다.

## 유지하는 한계

GPU별 최대 f16 KV 예산, 삭제 ACK 전 busy 슬롯 유지, 사용자 동시 한도, 세션 격리, 선택 예비의 전체 기록 재생성은 유지한다. 동적 allocator·부분 activation replay·server-to-server 전송을 Node 계층에 복제하지 않는다. EC2 배포 파일과 서비스 경계도 유지한다.

이번 검토는 GPU/WAN 성능 측정이 아니다. 개선의 직접 근거는 불필요한 KV 삭제·검증 호출·세션 충돌을 줄이는 실행 계약이며, tokens/s나 실제 VRAM 절감률을 제시하지 않는다.

## 검증

2026-09-24: 전체 `npm test` **224개 통과**, `npm run lint`·`npm run check` 통과. 이번 실행 코드 수정은 `lib/relay/inference.mjs`이며 회귀 검사 8개를 추가했다. 입력 검사 실패의 KV·시각 보존, 중복 erase 방지, 익명 세션 정리, 동시 검사 공유, epoch 경합, 모델별 동일 세션 동시 실행, 그룹·슬롯의 캐시 보존 배정을 확인한다.

배포용 파일은 `outputs/routing-kv-20260924/relay-server.zip`이다. 이번 변경에는 Python·화면 코드 수정이 없으며 실제 GPU/WAN 측정과 운영 EC2 배포는 수행하지 않았다.

# 분산 GPU 임대로 큰 LLM을 실행하기 위한 KV 캐시·스케줄링 연구

작성일: 2026-09-18 · 대상: C:\gpu_togeter 현재 작업 트리  
기준 HEAD: 26b4e3f14232e0c9e42a8f9f82d0125c6edd8c6a  
범위: 코드 감사, 1차 논문·공식 문서 조사, 용량·통신량 계산, 설계 제안. 운영 추론 코드는 변경하지 않았다.

> 이 문서는 분산 LLM 구현 **이전**의 조사·판단 기록을 보존한다. 본문의 “현재 코드”와 소스 줄 번호는 당시 작업 트리 기준이다. 이후 반영한 구조·인증·KV 관리·검증 범위는 [전체 구성 아키텍처](architecture-review-ko.md), 실행 방법은 [분산 LLM 운영](distributed-inference-ko.md)을 따른다.

## 1. 결론과 확정된 목표

사용자의 목표는 **부족한 VRAM을 다른 GPU에서 임대해, 원래 한 GPU에서는 실행할 수 없는 모델을 에이전트·챗봇에서 사용**하는 것이다. 동일 장소의 LAN과 인터넷으로 연결된 다른 사람의 PC를 모두 지원한다.

**현재 Relay는 이 목표를 구현하지 않는다.** 문서별 독립 작업을 각각 완전한 모델을 실행하는 제공자에게 배정한다. 이것은 작업 병렬화이며, 여러 제공자의 VRAM으로 하나의 모델을 실행하는 모델 병렬화가 아니다. 캐시 정책이나 동시 요청 수만 바꿔서는 이 차이를 해결할 수 없다.

**KV 캐시가 여러 GPU에 있다는 이유로 문맥이 깨지지는 않는다.** 한 모델을 레이어 단위로 정확히 분할하면 각 GPU는 자신이 담당하는 레이어의 모든 필요한 과거 토큰 KV를 보관한다. 같은 세션·모델·토큰 위치를 유지하고 중간 결과를 순서대로 전달하면 하나의 모델 계산이 성립한다. 서로 독립적으로 계산한 문서의 KV를 임의로 이어 붙이는 것은 다른 문제다.

현재 정보에서 가장 합리적인 방향은 다음과 같다.

1. **한 모델의 분산 실행 그룹을 기본 자원 단위로 도입한다.** 필요한 레이어와 KV 용량을 가진 여러 제공자를 한 번에 예약한다.
2. **빠른 연결 안에서는 TP/PP를 실측 비교하고, 느린 연결 사이에서는 연속 레이어 단위 PP를 기본 후보로 둔다.** LAN이라는 이름만으로 빠른 연결이라고 가정하지 않는다.
3. **활성 KV는 담당 레이어가 계산되는 장치에 유지한다.** 중앙 서버는 위치·버전·용량을 관리하고, 매 토큰의 KV 본문을 중계하지 않는다.
4. **동일 모델·호환 실행 설정의 가중치는 공유하고 사용자별 KV는 분리한다.** 분산 실행 그룹 안에서 continuous batching과 KV 용량 기반 입장 제어를 적용한다.
5. **초기에는 승인된 제공자와 지원 모델을 제한한다.** LAN에서 정확성과 복구를 먼저 검증한 뒤 WAN의 지연·비용 조건을 별도로 검증한다.

이것은 현 조건에 대한 설계 판단이다. GPU 구성·모델·네트워크 실측이 없으므로 특정 구현이 전역 최적이거나 몇 배 빠르다고 결론 내릴 수는 없다.

## 2. KV 캐시에 대한 정확한 이해

여기서 캐시는 GPU의 L1/L2 하드웨어 캐시가 아니라, 보통 VRAM에 저장하는 Transformer attention의 Key/Value 텐서를 뜻한다. 배치 크기, 문맥 길이, 모델 구조, KV dtype에 따라 용량이 달라진다. CPU offload 설정에서는 일부가 시스템 RAM에 존재할 수도 있다.

일반적인 causal Transformer의 레이어 ℓ는 현재 토큰 표현과 **그 레이어에서 계산한 이전 토큰들의 K/V**를 이용한다. 레이어 20의 attention 계산에 레이어 3의 KV를 직접 합쳐 넣지 않는다. 따라서 다음과 같은 분할이 가능하다.

~~~mermaid
flowchart LR
    U["클라이언트 / 세션 제어\n정확한 입력·출력 토큰 기록"] --> A
    A["GPU A\n레이어 0~15\n세션별 해당 레이어 KV"] -->|"중간 activation"| B
    B["GPU B\n레이어 16~39\n세션별 해당 레이어 KV"] -->|"중간 activation"| C
    C["GPU C\n레이어 40~63\n세션별 해당 레이어 KV"] --> O
    O["출력 head / sampler\n다음 토큰 결정"] -->|"다음 토큰"| U
~~~

레이어 범위는 설명용이다. 실제 배치에서는 embedding·출력 head·workspace의 비대칭도 계산해야 한다. 물리 GPU마다 문서 조각을 읽는 구조가 아니라 **각 단계가 같은 토큰 시퀀스에 대해 서로 다른 레이어를 계산하는 구조**다. WAN에서 이와 유사한 방식을 구현한 직접적인 선행 사례가 [Petals의 분산 추론 논문](https://arxiv.org/html/2312.08361v1)이다.

| 구분 | 무엇을 분산하는가 | 문맥 유지 조건 | 부족한 모델 VRAM 해결 |
|---|---|---|---|
| 현재 Relay의 작업 병렬화 | 서로 다른 문서·요청 | 각 요청에 필요한 원문을 제공 | 제공자 사이에서는 해결하지 못함 |
| Pipeline parallelism, PP | 연속된 모델 레이어 | 단계별 KV, 동일 토큰 순서·위치, 올바른 activation 전달 | 가능 |
| Tensor parallelism, TP | 같은 레이어의 텐서 연산 | attention head/텐서 분할과 collective 연산을 엔진이 관리 | 가능 |
| Context/KV parallelism | 문맥·attention 상태 | 분산 attention 및 정확한 softmax 결합 등 전용 알고리즘 | 주로 긴 문맥 KV에 도움; 가중치 문제는 별도 |
| Prefill/decode 분리 | 프롬프트 처리 단계와 생성 단계 | 호환 KV 전송·복구 | 단독으로 모델 가중치를 쪼개는 해결책은 아님 |

**실제로 문맥이 깨지는 조건**은 세션을 다른 GPU로 옮기면서 이전 상태도 재생 입력도 전달하지 않는 경우, 다른 모델/LoRA/위치 설정의 KV를 재사용하는 경우, 일부 레이어의 KV만 이전 토큰 위치에 머문 경우, 문맥 초과를 알리지 않고 잘라내는 경우다.

전체 입력 토큰이 보존되어 있다면 KV를 잃어도 다시 prefill하여 같은 문맥을 구성할 수 있다. 이는 비용이 드는 복구 방법이며, 장치·배치·수치 연산 차이 때문에 생성 결과의 비트 단위 동일성까지 자동 보장하지는 않는다. 모델을 양자화하거나 토큰을 제거하는 최적화는 별도 품질 검증 대상이다.

다른 사용자들의 대화를 합칠 필요는 없다. 동일 모델 가중치는 공유할 수 있지만 각 사용자의 대화 상태는 독립적이어야 한다. 동일한 허용 범위의 정확한 토큰 prefix만 조건부 공유할 수 있다.

여러 문서를 독립 처리한 뒤 종합 추론을 원한다면 문서·근거를 포함한 후속 추론 단계가 필요하다. 현재의 문서별 결과 병합에는 교차 문서 LLM 추론이 없다. 일반 KV를 단순 연결하는 대신 일부 상태를 재계산하는 연구도 있지만, 이는 전용 알고리즘과 품질 검증을 요구한다. [CacheBlend](https://arxiv.org/abs/2405.16444)

## 3. 현재 코드의 객관적 평가

아래 위치는 조사 시점의 작업 트리 기준이다. 기존에 수정 중인 파일들이 있으므로 HEAD만으로 완전히 같은 상태가 재현되는 것은 아니다.

| 확인한 사실 | 코드 근거 | 목표에 대한 의미 |
|---|---|---|
| 제공자는 전체 GGUF를 llama-server에 넘긴다. 제공자 간 RPC·레이어 배치 프로토콜이 없다 | [provider 실행](C:/gpu_togeter/provider/provider.py:60) | 서로 다른 PC의 VRAM을 합쳐 모델을 실행하지 않는다 |
| 실행 옵션은 --parallel 1이고 /props의 total_slots=1을 강제한다 | [실행 옵션·검사](C:/gpu_togeter/provider/provider.py:69) | 사용자 요청 사이의 동적 배칭 기회를 제한한다 |
| Python executor도 max_workers=1이다 | [실행 루프](C:/gpu_togeter/provider/provider.py:124) | 엔진 옵션 하나만 늘려도 병렬 요청이 생기지 않는다 |
| 매 요청에 system prompt와 문서 전체를 보낸다 | [입력 구성](C:/gpu_togeter/provider/provider.py:96) | 현재 독립 작업은 이전 노드의 KV 없이 재시도 가능하다 |
| 원문 입력 토큰+최대 출력이 문맥을 넘으면 거절한다 | [문맥 검사](C:/gpu_togeter/provider/provider.py:111) | 조용한 문맥 잘림을 막는 좋은 설계다 |
| cache_prompt·KV dtype·캐시 격리·내보내기를 명시하지 않는다 | [요청 본문](C:/gpu_togeter/provider/provider.py:108) | KV는 엔진에 위임된다. 앱에 명시적 분산 캐시 관리가 없다 |
| 정상 완료 후 모델 프로세스는 살아 있다 | [프로세스 재사용](C:/gpu_togeter/provider/provider.py:60) | 요청마다 모델을 재적재하는 구조는 아니다 |
| 중앙 스케줄러는 노드당 활성 lease 하나만 허용한다 | [claim](C:/gpu_togeter/lib/relay/engine.mjs:51), [불변식](C:/gpu_togeter/lib/relay/engine.mjs:205) | 분산 실행 그룹, 여러 세션·슬롯을 표현하지 못한다 |
| lastAssigned와 createdAt로 job 순환 배정한다 | [후보 정렬](C:/gpu_togeter/lib/relay/engine.mjs:55) | 사용자별 계산 비용·KV 점유·노드 속도·네트워크 최적화가 아니다 |
| context와 등록 VRAM의 정적 조건을 검사한다 | [적합성 검사](C:/gpu_togeter/lib/relay/engine.mjs:56) | 실행 중 여유 KV, 출력 성장, 다른 로컬 작업의 메모리를 반영하지 않는다 |
| live는 provider pull 방식이며 demo의 latency 정렬은 체험용이다 | [poll](C:/gpu_togeter/lib/relay/engine.mjs:109) | 체험 노드의 빠른 순서 배정을 실GPU 최적화로 해석하면 안 된다 |
| lease 30초, 시도 hard stop 180초, 출력 상한 1024토큰이다 | [grant](C:/gpu_togeter/lib/relay/engine.mjs:45) | 장시간 대화·긴 reasoning·여러 단계 agent를 위한 세션 계약이 아니다 |
| stream=false이고 매 루프 sleep(3)을 수행한다 | [추론](C:/gpu_togeter/provider/provider.py:108), [대기](C:/gpu_togeter/provider/provider.py:167) | 토큰 스트리밍과 낮은 지연의 요청 간 전환을 지원하지 않는다 |
| 오류·회수 시 자신이 시작한 llama-server 전체를 종료한다 | [복구](C:/gpu_togeter/provider/provider.py:168) | 단일 작업에는 단순하지만 공유 엔진에서는 다른 사용자까지 중단시킨다 |
| 풀 전체 상태를 JSON으로 직렬화해 revision CAS로 저장한다 | [서비스 상태 저장](C:/gpu_togeter/lib/relay/service.mjs:23) | 파일럿 정합성에는 유용하지만 토큰마다 적용할 경로는 아니다 |
| 단일 운영자·단일 풀이고 임차자별 로그인·권한은 없다 | [현재 권한 범위](C:/gpu_togeter/README.md:112) | 결제 계정과 진짜 다중 사용자 인증을 구분해야 한다 |

llama.cpp 자체가 KV 캐시나 배칭을 지원하지 않는다는 뜻은 아니다. 검증 기록에 적힌 b10964 공식 문서는 prefix 재사용, continuous batching, 슬롯, KV dtype·host cache 설정을 설명한다. 현재 어댑터가 이러한 기능을 제한적으로 사용하고 있을 뿐이다. 기본값에 의존하는 캐시는 존재할 수 있으므로 “현재 KV 캐시가 전혀 없다”는 진단도 틀리다. [b10964 서버 문서](https://github.com/ggml-org/llama.cpp/blob/b10964/tools/server/README.md)

현재의 강점은 task/attempt/epoch 분리, 오래된 결과 거절, 예약·정산 원자성, 한 번만 지급하는 영수증, 노드 회수, 원문 재전송이다. 이 제어 구조는 새 아키텍처에서도 재사용할 가치가 있다. 다만 **완료된 문서 하나를 정산하는 모델에서, 여러 제공자가 협력하는 하나의 실행 그룹을 예약·계측·정산하는 모델로 확장**해야 한다.

### 확인한 검증 수준

이번 조사에서 기존 테스트를 다시 실행했다.

- Node 실행 코어·유지보수: 39/39 통과.
- Python provider: 8/8 통과.
- 이는 기능·복구 불변식의 확인이며 KV 분산, 모델 병렬화, WAN 속도, 다중 사용자 성능의 검증이 아니다.

[README의 실GPU 기록](C:/gpu_togeter/README.md:190)은 RTX 3050 Ti 4GB, Qwen3-4B Instruct Q3_K_M, context 8192의 단일 로컬 작업 성공을 보고한다. 이번 조사에서 해당 실험을 재실행하지 않았다. 이전 아키텍처 문서의 “실GPU 미실시”보다 최신 README 기록을 우선하되, 한 건 성공을 스케줄러 성능 입증으로 확대하지 않았다.

## 4. 선행연구와 이 프로젝트에 적용되는 범위

논문 성능 수치는 모델·장비·부하·baseline에 종속된다. 아래에서는 논문의 핵심 메커니즘과 적용 한계를 우선한다. 모든 배수를 프로젝트의 예상 성능으로 사용하지 않았다.

| 연구·공식 자료 | 해결하는 문제 | 이 프로젝트에 가져올 점 | 한계·trade-off |
|---|---|---|---|
| [Petals / NeurIPS 2023](https://arxiv.org/html/2312.08361v1) | 인터넷의 불안정한 GPU들에 모델 레이어를 배치 | 단계별 KV 소유, 연속 레이어 배치, 장애 단계의 입력 재생 | WAN 지연·중간 상태 저장·노드 신뢰가 필요. 단일 GPU보다 빠르다는 일반 보장은 없음 |
| [Helix / ASPLOS 2025](https://arxiv.org/html/2406.01566v2) | 이기종 GPU·연결에서 모델 배치와 요청 경로 공동 최적화 | GPU 및 링크 용량을 함께 보는 그래프, 요청별 경로, KV 여유 반영 | MILP·프로파일링 비용. 24~42노드 연구 결과를 소규모 가정용 GPU에 그대로 대입 불가 |
| [HexGen / ICML 2024](https://arxiv.org/html/2311.11514v3) | 이기종·분산 환경의 비대칭 TP/PP | 빠른 기기 내부 TP와 기기 사이 PP 조합 | 연구의 좋은 배치는 느린 지역 간 통신을 피하기도 한다. “모든 WAN 연결이 효율적”이라는 근거가 아님 |
| [llama.cpp b10964 RPC](https://github.com/ggml-org/llama.cpp/blob/b10964/tools/rpc/README.md) | 원격 장치에 모델 계산·가중치·KV 배치 | 기존 GGUF 경로와 가까운 폐쇄 실험 후보 | 공식 문서가 proof-of-concept·취약성을 경고. 공개 임대 서버의 완성된 안전한 기반으로 간주 불가 |
| [vLLM 분산 실행 문서](https://docs.vllm.ai/en/latest/serving/parallelism_scaling/) | 하나의 모델 replica에 TP/PP 적용 | 통제된 고속 클러스터의 분산 serving 후보 | 통일된 실행 환경과 신뢰 네트워크 필요. 임의 소비자 PC를 자동 지원하지 않음 |
| [PagedAttention / SOSP 2023](https://arxiv.org/abs/2309.06180) | KV 메모리 단편화·중복 복사 | 단계별 엔진에서 블록 관리, 공유 가능한 prefix·분기 참조 | 물리 KV 배치 효율화이며 네트워크를 빠르게 하거나 모델 레이어 배치를 대신하지 않음 |
| [SGLang / RadixAttention](https://arxiv.org/abs/2312.07104) | agent·구조화 생성·반복 prefix 재사용 | 동일 모델 실행 그룹에서 대화·agent 공통 prefix 재사용 | prefix hit 우선만 쓰면 다른 사용자가 밀릴 수 있음 |
| [Sarathi-Serve / OSDI 2024](https://arxiv.org/abs/2403.02310) | 긴 prefill이 decode를 지연시키는 문제 | chunked prefill, 단계 간 배치 편차·pipeline bubble 완화 | chunk가 너무 작으면 실행·통신 횟수가 늘어 WAN에 불리 |
| [VTC / OSDI 2024](https://arxiv.org/abs/2401.00588) | 요청 길이가 다른 사용자들의 공정성 | 요청 개수가 아닌 입력·출력 서비스 비용의 누적 반영 | 이기종 분산 경로·KV 점유 비용까지 포함한 보장은 별도 설계 필요 |
| [DLPM / D²LPM, 2025](https://arxiv.org/abs/2501.14312) | prefix locality와 공정성의 충돌 | 제한된 locality 우선권과 deficit 기반 공정성 | 분산 replica 배정 연구를 레이어 단계별 독립 스케줄링과 혼동하면 안 됨 |
| [DistServe / OSDI 2024](https://arxiv.org/abs/2401.09670) | prefill/decode 간섭 | 충분한 GPU·대역폭 확보 후 SLO 중심 분리 검토 | 두 단계가 모델에 접근해야 하고 KV도 이동. 메모리가 부족한 초기 WAN 구성의 기본 해법으로 부적합 |
| [Mooncake](https://arxiv.org/abs/2407.00079) | 큰 serving 환경의 KV 저장·배치·과부하 | KV 중심 입장 제어, 계층형 캐시, 과부하 조기 거절 | 관리되는 클러스터의 조건. 데이터센터 성과가 저속 WAN에서 재현된다는 근거 없음 |
| [LMCache 공식 문서](https://docs.lmcache.ai/) | CPU·디스크·원격 저장을 통한 KV 재사용 | 긴 대화가 반복되는 단계에 선택적인 offload/restore | 엔진·형식 호환성과 전송 시간 확인 필요. 가중치 샤딩 엔진을 대신하지 않음 |
| [CacheBlend](https://arxiv.org/abs/2405.16444) | 비-prefix RAG KV의 결합 | 추후 반복 RAG의 선택적 재계산 후보 | 임의 KV 연결은 정확한 전체 prefill과 다름. 초기 correctness 경로에 도입하지 않음 |

Petals 논문은 서버별 레이어 KV와 클라이언트 측 단계 입력 기록을 구분하며, 장애가 난 단계의 상태를 대체 서버에서 복구한다. 실제 인터넷상의 소비자·연구실 GPU 실험도 있어 목표와 가장 직접적으로 닮았다. 단, 현재 지원 모델·실행 환경은 [Petals 공식 저장소](https://github.com/bigscience-workshop/petals)를 확인해야 하며, 이 저장소의 GGUF/Qwen 실행기를 교체 없이 연결할 수 있다고 확인한 것은 아니다.

Helix는 단순 VRAM 비례 분할보다 GPU 연산량·네트워크·KV 수용량을 함께 보는 설계 근거다. 문헌의 높은 최대 개선율만 채택하지 않았다. 예를 들어 원문 일부 비교에서는 처리량 향상과 동시에 decode 지연 증가도 보고한다. 따라서 목표 지표는 **전체 tokens/s뿐 아니라 사용자별 지연 조건을 만족한 처리량**이어야 한다. [Helix 실험과 KV 추정](https://arxiv.org/html/2406.01566v2)

## 5. LAN과 WAN을 모두 지원하는 권장 구조

### 5.1 한 제품, 서로 다른 실행 프로파일

| 조건 | 우선 후보 | 이유 | 피해야 할 가정 |
|---|---|---|---|
| 원하는 모델+KV가 임대한 한 GPU에 들어감 | 해당 GPU에서 전체 실행 | 가장 적은 분산 상태와 토큰별 통신 | 로컬 GPU를 반드시 참여시켜야 더 빠르다는 가정 |
| 같은 호스트·고속 GPU 연결 | TP 또는 TP+PP | 큰 모델을 담으면서 연산 병렬화 가능 | GPU 수만 늘리면 선형 가속한다는 가정 |
| 동일 LAN, 이기종 GPU 또는 제한된 GPU 간 대역폭 | PP 우선 비교, 적합하면 TP | 연속 레이어 묶음으로 통신 경계를 줄임 | 1GbE와 NVLink를 같은 고속망으로 취급 |
| WAN의 소수 승인 PC | 적은 단계의 PP, 세션 경로 고정 | 반복 collective를 피하고 단계 KV를 현지 유지 | 한 모델을 가능한 한 많은 PC로 잘게 나누기 |
| 서로 다른 지역에 고속 GPU 묶음이 존재 | 묶음 내부 TP/PP, 묶음 사이 PP | 네트워크 계층에 맞는 병렬화 | 대륙 간 TP를 기본값으로 채택 |
| 매우 느리거나 불안정한 WAN | 다른 경로·충분한 원격 GPU·로컬 RAM offload와 비교 | “실행 가능”과 “사용 가능한 속도”가 다름 | 합산 VRAM이 크면 무조건 판매 가능한 서비스라는 가정 |

이 계층적 선택은 [HexGen의 비대칭 병렬화 결과](https://arxiv.org/html/2311.11514v3)와 [vLLM의 TP/PP 지침](https://docs.vllm.ai/en/latest/serving/parallelism_scaling/)을 바탕으로 한 제안이다. 모든 이기종 구성을 한 엔진이 지원한다는 의미는 아니다.

LAN/WAN 모두 **동일한 외부 대화 API·인증·세션·예약 모델**을 사용하되, backend capability와 실행 계획은 구분한다. 하나의 분산 실행 그룹 안에서는 호환성이 검증된 동일 실행 프로토콜을 사용한다. vLLM의 중간 stage와 Petals의 중간 stage를 표준 API만으로 연결할 수 있다는 뜻이 아니며, GGUF KV와 다른 엔진의 KV를 그대로 교환할 수 있다고 가정하지 않는다. LAN 모델을 WAN 엔진이 지원하지 않으면 별도 backend 검증을 요구한다. 다른 모델이나 양자화로 바꾸는 것을 투명한 failover로 처리하지 않는다.

### 5.2 제어 경로와 추론 데이터 경로

~~~mermaid
flowchart TB
    U["사용자 / Agent / Chatbot"] --> G["추론 Gateway\n인증·세션·토큰 스트림·재생 기록"]
    G --> R["Relay 제어 서버\n배치 계획·그룹 예약·회계·상태"]
    R -.-> A["Stage A\n가중치 일부 + 사용자별 KV"]
    R -.-> B["Stage B\n가중치 일부 + 사용자별 KV"]
    R -.-> C["Stage C\n가중치 일부 + 사용자별 KV"]
    G --> A
    A -->|"인증된 activation 전송"| B
    B -->|"인증된 activation 전송"| C
    C --> G
~~~

Gateway와 Relay는 초기에는 같은 호스트에 배치할 수 있지만 논리 역할을 나눈다. 기존 SQLite CAS는 예약·lease·정산에 사용한다. 토큰별 activation과 KV를 전체 풀 JSON에 기록하지 않는다. 제공자 NAT 환경에는 인증된 지속 연결·사설 overlay·필요 시 relay transport가 필요하며, relay를 경유한 실제 지연도 배치 비용에 포함한다.

**임대 대상은 단순 빈 VRAM 바이트가 아니라 “지정 모델 shard의 상주 공간+연산+KV 용량+연결”이다.** 원격 VRAM에서 매 토큰 큰 데이터를 읽어오는 가상 메모리 방식보다, 가중치와 KV가 있는 원격 GPU가 그 레이어를 계산하고 작은 중간 표현을 전달하는 방식을 우선한다.

모델별 실행 그룹을 여러 사용자가 공유할 수 있다. 임차자마다 동일 가중치를 중복 적재하는 방식은 VRAM을 낭비한다. 반대로 전용 격리·다른 모델·다른 adapter가 필요하면 별도 그룹 또는 호환 엔진의 명시적 다중 adapter 기능을 사용한다.


## 6. 필요한 스케줄러: 배치·입장·실행을 나눠 관리

### 6.1 모델 배치 계획: 어떤 GPU가 어떤 레이어를 맡는가

지금의 “노드가 poll하면 문서 하나를 준다”에서 다음 계획 단위로 바꿔야 한다.

- 모델 revision·가중치 양자화·tokenizer·template·RoPE·KV 형식·adapter를 고정한다.
- 각 GPU의 가용 VRAM, 모델 shard 적재 여부, 레이어별 prefill/decode 속도, KV 수용량, 안정성을 측정한다.
- GPU 사이의 실제 RTT/대역폭/경유지·장애율을 확인한다. 같은 공인 IP나 지역명만으로 링크를 추정하지 않는다.
- 모든 레이어를 정확하게 덮는 연속 구간을 배치한다. 중간 레이어 누락과 순서 변경을 허용하지 않는다.
- 합산 메모리가 충분한 후보 중 단계 수·느린 링크·병목 단계·cold load를 함께 줄인다.

배치 기준의 간단한 형태는 다음과 같다.

~~~text
각 노드 i:
  shard_weights_i + runtime_workspace_i + KV_reserved_i + safety_margin_i
    <= permitted_VRAM_i

각 요청 r:
  모든 필요한 레이어가 존재
  모든 단계에서 context 및 출력 성장 예산 확보
  모델/실행/데이터 접근 계약 충족
  예상 TTFT와 token latency가 해당 서비스 조건 충족
~~~

작은 풀에서는 측정값으로 소수 후보를 열거하고 평가하는 휴리스틱부터 시작한다. Helix의 max-flow/MILP를 그대로 이식하기보다, 규모가 커지고 단순 계획의 손실이 측정될 때 도입하는 편이 합리적이다. 비용 함수에는 초기 다운로드와 warm 가중치 재사용도 포함한다.

단일 세션 decode는 앞 단계 결과가 있어야 다음 단계가 진행하므로 **단계 지연의 합**이 중요하다. 여러 세션을 pipeline으로 겹치면 **가장 느린 단계의 처리 용량**이 전체 처리량을 제한한다. 레이어 수를 GPU 개수로 균등하게 나누는 것과 좋은 부하 분산은 다르다.

로컬 GPU도 의무적으로 참여시키지 않는다. 작은 로컬 GPU를 끼워 넣으면서 통신 경계가 늘거나 느린 단계를 만들면, 원격 묶음만 실행하는 편이 더 빠를 수 있다. 로컬 참여를 사용자의 별도 제약으로 지정할 수는 있다.

### 6.2 실행 그룹 예약과 세션 입장 제어

여러 GPU를 하나의 그룹으로 확보하는 **gang allocation**이 필요하다. 한 단계만 예약되고 다른 단계는 대기하면 이미 잡은 GPU·KV가 유휴 점유될 수 있다.

~~~text
PLAN
  -> PREPARE: 모든 stage에 용량 예약과 모델 준비 요청
  -> READY: 각 stage의 모델 계약·메모리·연결 준비 확인
  -> COMMIT: 단일 allocation epoch로 실행 허용
  -> ACTIVE
  -> DRAIN / RECOVER / RELEASE
~~~

PREPARE의 일부가 실패하면 임시 예약 전체를 기한 내 반환한다. COMMIT 전에는 사용자에게 실행 가능하다고 표시하지 않는다. 노드의 실제 용량 예약과 중앙 DB 기록은 원격 트랜잭션이므로, 단순 DB CAS 한 번만으로 완료되지 않는다. 토큰·시간 제한의 예약 핸드셰이크가 필요하다.

실행 그룹이 준비된 다음에도 각 대화는 **모든 단계의 KV 여유를 확인한 뒤** 입장한다. 초기 버전은 입력 토큰+사용자에게 약정한 최대 출력에 대한 보수적 예약을 권장한다. 이는 안전하지만 짧게 끝나는 요청에서 메모리를 과예약한다. 출력 길이 예측과 동적 추가 할당은 후속 최적화로 두고, 예측 실패 시 대기·명시적 거절·유휴 캐시 회수·복구 가능한 preemption 중 하나를 정의해야 한다.

그룹 임대 기간, 개별 추론 deadline, heartbeat 만료, KV idle TTL은 각각 분리한다. 현재의 문서 시도 hard stop 180초를 장시간 대화 세션 전체에 그대로 적용하지 않는다. heartbeat는 토큰 실행과 독립적으로 갱신하고 네트워크 지연을 반영한 안전 여유를 둔다.

KV 여유가 없는 단계가 하나라도 있으면 다른 GPU의 여유 VRAM만으로 그 요청을 수용할 수 없다. 레이어 재배치나 전용 분산 attention 없이 “남는 곳에 아무 KV나 저장”하면 계산·통신 구조가 달라진다.

### 6.3 여러 사용자 실행: 공유 가중치·별도 KV·연속 배칭

분산 그룹 안에서는 여러 세션의 decode와 작은 prefill chunk를 스케줄링한다. 단계가 각자 요청 순서를 임의로 바꾸면 큐가 불균형해질 수 있으므로 세션·microbatch ID와 backpressure를 그룹 전체에서 일관되게 관리한다.

공정성 기준은 job 수가 아니라 인증된 tenant의 서비스 사용량이다. 요청을 여러 job으로 쪼개서 배정 몫을 늘리지 못하게 한다. 서로 다른 모델·하드웨어는 실측으로 보정한 서비스 비용을 사용한다.

~~~text
초기 서비스 비용 예:
  calibrated_prefill_cost(input_tokens, cached_tokens)
  + calibrated_decode_cost(output_tokens, context_length)
  + KV_occupancy_penalty(bytes × held_time)
~~~

이 식은 제안이며 기존 VTC 논문의 보장을 그대로 갖지 않는다. 토큰 비용에 KV 점유 비용을 추가하는 것은 긴 문맥과 agent의 대기 상태를 고려하기 위한 확장이다. 초기에는 사용자별 weighted deficit, 최대 동시 세션, KV quota, 대기 시간 상한을 함께 적용한다. 짧은 요청만 계속 우대하여 긴 요청이 굶지 않게 aging을 둔다.

prefix 캐시가 있다는 이유만으로 특정 사용자를 무한 우대하지 않는다. 사용자 공정성 한도 안에서 캐시가 있는 **전체 실행 그룹**에 우선 배정한다. 같은 대화의 진행 중 decode를 토큰마다 다른 그룹으로 돌리지 않는다. 공정성과 locality를 같이 고려할 근거는 [VTC](https://arxiv.org/abs/2401.00588)와 [DLPM/D²LPM](https://arxiv.org/abs/2501.14312)이다.

긴 agent tool 실행 중에는 GPU를 계속 예약할지, CPU로 KV를 옮길지, TTL 뒤 지울지를 명시한다. **세션 논리 상태의 수명, KV 보존 수명, 실행 그룹 임대 수명은 서로 다른 개념**이다. 그룹이 여러 사용자를 처리하는 경우 한 세션이 idle이라고 공유 가중치 전체를 내리지 않는다.

## 7. 분산 KV의 정합성과 복구 계약

### 7.1 최소 식별 정보

다음 정보가 함께 일치해야 캐시를 재사용할 수 있다. 아래는 제안 스키마이며 구현되어 있지 않다.

~~~text
ModelExecutionContract:
  model_revision / weight_digest / shard_manifest_digest
  tokenizer_digest / template_digest / adapter_digest
  runtime_compatibility / attention_layout / rope_configuration
  weight_quantization / kv_dtype / cache_format_version

DistributedSession:
  tenant_id / session_id / branch_id
  allocation_id / allocation_epoch / session_generation
  canonical_input_tokens / committed_output_tokens
  sampler_state_or_replay_policy
  processed_position_by_stage
  stage_assignment / cache_handles / expiry
~~~

생성된 마지막 토큰과 모든 단계가 이미 처리한 마지막 토큰은 같지 않을 수 있으므로 별도 기록한다. KV 핸들을 다른 세션에 재사용하지 않는다. 데이터 경로도 epoch·sequence position을 검사해야 하며, 중앙 결과 제출 시에만 확인하는 것으로는 부족하다.

같은 위치의 입력이 재전송되면 중복 append하지 않도록 요청 ID와 위치를 검사한다. 같은 ID·다른 입력은 거절한다. 실행 단계가 더 앞서 진행한 상태를 rollback할 수 없으면 그 branch의 suffix KV를 버리고 확정 지점에서 재생한다.

### 7.2 정상 실행

1. prefill에서 정확한 token IDs와 위치 정의를 확정한다.
2. 각 stage는 자신이 맡은 레이어의 KV를 해당 세션에 생성한다.
3. stage 간에는 필요한 activation을 보낸다. 정상 decode마다 전체 KV를 이동하지 않는다.
4. sampler가 다음 토큰을 정하고, 스트림에는 세션·출력 sequence 번호를 붙인다.
5. 종료하면 active 참조를 해제한다. 재사용할 cache는 별도 TTL·quota·접근 제어 아래 둔다.

에이전트의 분기에는 공통 prefix의 읽기 전용 공유와 copy-on-write가 유용하다. 분기 이후 KV는 독립적이다. 대화 중 이전 메시지·system prompt·tool 결과를 수정하면 처음 달라지는 토큰 이후 KV를 재계산한다.

### 7.3 노드 회수·장애

**1차 구현의 권장 복구는 정확한 토큰 기록을 이용한 재-prefill이다.** 복잡한 이기종 KV 이동보다 구현과 검증이 단순하다.

- 문제 세션의 진행을 중지하고 이전 epoch를 더 이상 수락하지 않는다.
- 동일 모델 계약을 실행할 대체 단계/그룹을 확보한다.
- 확정된 입력과 출력 토큰을 재생한다. 문자열을 임의로 재구성해 토큰 경계를 바꾸지 않는다.
- 필요한 모든 단계의 처리 위치가 맞은 뒤 새 epoch로 재개한다.
- 이미 전달한 출력·영수증의 중복을 막는다.

이 방법은 prefill 비용이 크고, 변경된 실행 계획에서 샘플링 결과가 완전히 동일하지 않을 수 있다. 이미 사용자에게 확정 전달한 토큰을 기준으로 이어갈 정책과 실패를 명시적으로 반환할 정책을 구분한다.

두 번째 단계에서는 **실패한 stage의 입력 activation 기록으로 그 stage의 KV만 복구**하는 방식을 검토한다. 더 적은 재계산 대신 activation 저장·보존·전송 비용이 생긴다. Petals가 제공하는 중요한 설계 선례다. [Petals 복구 알고리즘](https://arxiv.org/html/2312.08361v1)

살아 있는 노드 사이의 계획된 이동은 다음 조건에서만 KV 전송을 우선한다.

~~~text
transfer_time =
    bytes_to_move / measured_effective_bandwidth
    + serialize + GPU_to_host + host_to_GPU
    + protocol_latency + queue_delay + compatibility_conversion

선택:
  transfer_time < measured_recompute_time
  AND cache_format_compatible
  AND source_state_available
  AND target_capacity_reserved
~~~

갑작스러운 호스트 장애에서 해당 호스트에만 있던 KV는 가져올 수 없다. 항상 복구하려면 외부 checkpoint·복제 또는 입력 재생이 필요하다. 모든 KV를 항상 복제하면 메모리와 대역폭이 크게 늘므로 초기 기본값으로 권장하지 않는다.

하나의 사용자 요청 취소는 그 세션만 중지해야 한다. 제공자 소유자의 GPU 회수는 해당 노드 전체를 중지하되 영향을 받는 세션들을 복구 경로로 넘겨야 한다. 현재처럼 모든 오류를 공유 프로세스 종료로 처리하는 방식은 수정해야 한다.

에이전트가 호출하는 외부 도구는 사용자 측 실행 계층에서 처리하고, tool 호출 ID·결과를 보존한다. 모델 재시도 때문에 결제·파일 변경 등 도구 부작용이 중복 실행되지 않도록 별도의 멱등 계약이 필요하다. GPU lease가 도구 실행의 exactly-once를 보장하지 않는다.

## 8. 용량과 통신량: 재현 가능한 계산

이 절은 **분석 모델**이다. 실GPU 측정값이나 특정 GGUF 파일의 실제 점유량이 아니다. 재현 스크립트는 [kv_capacity_model.py](C:/gpu_togeter/docs/research/kv_capacity_model.py)이며 외부 패키지·네트워크·GPU를 사용하지 않는다.

### 8.1 KV 용량

일반적인 full-attention GQA 모델, 단일 시퀀스의 근사식:

~~~text
KV bytes = 2 × layers × kv_heads × head_dim × tokens × bytes_per_element
           ↑ K와 V

PP의 stage i:
KV_i = 2 × layers_on_i × kv_heads × head_dim × live_tokens × bytes_per_element
~~~

여기에는 alignment, scale metadata, block fragmentation, workspace가 없다. 공유 prefix는 물리 블록을 한 번만 세야 한다. TP는 KV head 수와 엔진 구현에 따라 shard 또는 복제하므로 GPU 수로 무조건 나누지 않는다. MLA·sliding window·hybrid/recurrent 모델에는 이 식을 그대로 적용하지 않는다.

[Qwen3-32B 공식 구성](https://huggingface.co/Qwen/Qwen3-32B/blob/main/config.json)은 64 layers, 8 KV heads, head dimension 128이다. FP16/BF16 KV를 가정하면 토큰당 **256KiB**다.

| 상태 | 전체 모델 KV | 32레이어씩 동일하게 나눈 PP의 각 stage KV |
|---|---:|---:|
| 1세션 × 총 8,192토큰 | 2GiB | 1GiB |
| 4세션 × 각각 총 8,192토큰 | 8GiB | 4GiB |
| 1세션 × 총 32,768토큰 | 8GiB | 4GiB |

총 토큰은 입력과 이미 생성된 출력, 그리고 입장 제어에서는 약정된 성장 예산을 포함한다. 가중치가 4bit라고 KV도 자동 4bit가 되는 것은 아니다.

**가상 예:** 실제 GPU 상주 가중치가 총 18GiB인 모델을 12GiB GPU 두 장에 9GiB씩 균등 배치하고, 각 GPU에 workspace+여유 1.5GiB가 필요하다고 가정한다. 위의 64레이어 KV 구성이면 8k 세션 하나에 각 GPU 11.5GiB, 두 세션이면 12.5GiB가 된다. 모델을 한 번 띄웠다고 두 사용자 동시 실행까지 가능한 것은 아니다. 이 18GiB는 설명용 가정이며 Qwen GGUF 실측 크기가 아니다.

현재 파일럿과 가까운 [Qwen3-4B-Instruct-2507 구성](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/main/config.json)을 예로 들면 36 layers, 8 KV heads, head dimension 128로 FP16 KV가 144KiB/token, 8k에서 1.125GiB다. 로컬 GGUF의 정확한 원본 revision은 이번 조사에서 확인하지 않았으므로 직접 등치하지 않았다. 4GB GPU에서 동시성을 무작정 늘리는 것이 적절하지 않은 이유를 보여 주는 예다.

### 8.2 정상 PP 통신과 KV 이동은 크기가 다르다

Qwen3-32B의 hidden size 5,120, activation 2바이트를 가정한 순수 텐서 크기:

- decode 1토큰의 경계 activation: 약 **10KiB**.
- 8,192토큰 prefill의 한 경계 activation: 약 **80MiB**.
- 같은 길이 전체 모델 KV: **2GiB**.
- 2분할 PP의 stage 하나 KV: **1GiB**.

1Gbps를 완전히 사용한다고 가정하면 80MiB 전송 하한은 약 0.67초, 전체 KV는 17.18초, stage 하나 KV는 8.59초다. 100Mbps면 각각 10배가 된다. 프로토콜·복사·추가 텐서·경유 트래픽·혼잡 비용은 제외했다.

따라서 WAN에서 **KV를 담당 레이어 옆에 두고 activation을 보내는 것**과 **매 단계마다 거대한 KV를 원격 메모리에서 읽는 것**은 전혀 다른 비용 구조다. 실제 RPC 엔진이 위 최소 텐서만 교환한다고 가정해서도 안 된다. 실제 trace를 측정해야 한다.

### 8.3 WAN decode는 대역폭보다 왕복 지연이 먼저 문제가 될 수 있다

단일 비투기적 순차 decode의 단순 하한:

~~~text
token_latency >= sum(stage_compute_times)
                 + sum(sequential_network_transfer_times)
                 + queueing_and_synchronization
~~~

가상의 전체 계산 시간 60ms, 토큰마다 순차 네트워크 통과 4회라는 조건:

| 통과 1회의 단방향 지연 | 계산+고정 통신 지연 하한 | 이상적 생성 속도 상한 |
|---|---:|---:|
| 1ms | 64ms/token | 15.63 token/s |
| 20ms | 140ms/token | 7.14 token/s |
| 50ms | 260ms/token | 3.85 token/s |

모든 수치는 가정이다. RTT와 단방향 지연을 중복 계산하지 않아야 하며, gateway 왕복 방식과 stage 직접 전송 방식의 경계 수는 다르다. speculative decoding이나 통신 중첩은 별도 모델을 요구한다. 배칭으로 여러 사용자의 합산 처리량이 늘어도 단일 사용자 지연이 같은 비율로 줄지는 않는다.

### 8.4 현재 poll 대기의 영향

현 코드에서는 추론 완료를 다음 루프에서 발견할 때까지 대기한 후, submit 성공 뒤에도 다시 3초를 기다리고 다음 작업을 claim한다. 오류 없는 조건에서 완료 감지 대기는 약 0~3초이고, 완료 후 고정 대기 3초가 추가된다. HTTP 시간은 별도다.

완료 시점이 poll 주기에 균등하게 분포한다고 가정하면 평균 공백은 약 4.5초다. 추론이 2초면 유효 추론 시간 비율은 약 31%, 10초면 약 69%, 60초면 약 93%다. 이는 GPU utilization 측정이 아니라 제어 루프의 분석이다.

완료 이벤트 기반 즉시 submit/claim, heartbeat 분리, idle 때 long-poll 또는 지속 연결이 개선 후보다. 그러나 이 수정만으로 큰 모델의 분산 실행이 구현되지는 않는다.

## 9. KV 관리 기법별 적용 순서와 trade-off

| 방법 | 장점 | 비용·위험 | 권장 순서 |
|---|---|---|---|
| 담당 레이어와 KV 동시 배치 | 정상 decode에서 KV 원격 전송 최소화 | layer 이동 시 KV 복구도 필요 | 기본 설계 |
| 정확한 입력·출력 토큰 재생 | backend 간 복구 경로가 단순 | 긴 문맥의 재-prefill 지연 | 첫 구현 |
| 단계별 paged KV 및 continuous batching | 단편화 완화·공유 가중치 활용 | 지원 엔진 및 distributed integration 필요 | LAN 다중 사용자 단계 |
| 동일 세션의 실행 그룹 affinity | prefill 재사용·이동 최소화 | 그룹 부하 집중 가능 | 기본값, 부하 초과 시 재계획 |
| prefix 공유·분기 copy-on-write | agent 공통 문맥의 계산·메모리 절감 | 격리·무효화·참조 관리 | 기본 정합성 후 |
| idle KV의 CPU RAM offload | tool 대기 중 VRAM 반환 | 복사 시간·RAM 상한·호스트 장애 | 긴 대화 실측 후 |
| 디스크·원격 KV 계층 | 큰 반복 context 재사용 | IO 지연, 형식·개인정보 보존 | hit/recompute 손익 확인 후 |
| KV 양자화 | 동일 VRAM에서 더 긴 문맥·많은 세션 | 품질·지원 kernel·변환 비용 | 별도 품질 인수 조건으로 검증 |
| 활성 KV의 WAN 이동 | 특정 장애 예고·재배치에서 유용 | 전송이 재계산보다 느릴 수 있음 | 비용 비교를 통과한 경우 |
| P/D 분리 | 높은 부하에서 단계 간섭 감소 | 모델 배치·KV 전송·추가 GPU 복잡성 | 고속망의 충분한 규모 이후 |
| 토큰 제거·window 축소·요약 | 큰 메모리 절감 가능 | 원래 문맥과 의미가 달라짐 | 사용자 동의 없는 투명 최적화로 사용하지 않음 |

prefix 적중은 stage별로 확인해야 한다. 초기 구현은 모든 단계에서 확인된 공통 길이의 최솟값을 사용하면 단순하다. 더 긴 부분 적중을 살리려면 중간 activation 재사용까지 포함한 별도 실행 계획이 필요하다. 한 stage에 캐시가 있다는 이유로 전체 pipeline이 prefill을 건너뛰면 안 된다.

재사용 캐시를 회수하는 것과 실행 중인 세션의 문맥을 버리는 것을 구분한다. active 참조가 없는 블록을 먼저 회수하고, 활성 상태를 회수하려면 복구 지점·재계산 비용을 명시한다. 엔진이 KV 풀을 선할당하면 GPU free memory만으로 실제 토큰 여유를 판단하지 말고 엔진 내부 allocator 정보를 사용한다.

## 10. 다중 임차자와 제공자의 신뢰 경계

tenant는 GPU를 사용하는 임차자이고 provider는 GPU를 제공하는 사람이다. 현재 payer 계정은 인증된 tenant 경계가 아니다. 인증, 모델·세션 접근 권한, 예약 quota, cache namespace를 분리해야 한다.

prefix 재사용 범위는 기본적으로 tenant 또는 명시적으로 허용한 공유 그룹으로 제한한다. 호환 실행 계약과 정확한 token prefix를 키에 포함한다. 예측 가능한 tenant ID만으로 비밀 salt를 대신하지 않는다. vLLM의 공식 보안 문서는 cache_salt를 통한 prefix timing side-channel 완화를 설명한다. gateway가 고정 길이의 비밀 salt를 생성·주입하고 임의 사용자 값으로 다른 namespace를 선택하지 못하게 하는 구성을 권장한다. [vLLM cache isolation](https://docs.vllm.ai/en/latest/usage/security/)

공유 슬롯 번호나 프로세스만으로 강한 보안 격리가 생기지는 않는다. 다른 사용자의 cache handle을 읽거나 복구·삭제할 권한을 주지 않는다. 원격 cache에 저장된 KV·activation도 민감한 데이터로 취급한다. 내용을 텍스트로 표시하지 않는다고 입력 기밀성이 자동 보장되는 것은 아니다.

특히 **타인의 PC는 그 호스트 소유자가 제어한다.** TLS·VPN·모델 해시는 제3자의 도청이나 잘못된 모델 식별에 도움이 되지만, 제공자 자신에게 계산 내용이 보이지 않게 하거나 계산을 정직하게 했음을 증명하지 않는다. 현재 공개·비민감 데이터 신뢰 모델을 유지하거나, 별도로 검증된 기밀 실행 기술과 운영 조건을 갖춰야 한다.

llama.cpp RPC는 원격 계산의 실험 후보지만 공식 문서가 공개망·민감한 환경에서의 사용을 경고한다. 단순히 --rpc를 추가해 공개 임대 포트를 여는 것을 권장하지 않는다. 사설 연결도 악의적 참여자를 신뢰할 수 있게 만들지는 않는다. 초기에는 통제된 호스트에서만 검증하며, 공개 임대 서비스에는 제한된 프로토콜·허용 모델·인증된 peer·프로세스 격리·자원 제한을 별도 설계해야 한다. [llama.cpp RPC 주의 사항](https://github.com/ggml-org/llama.cpp/blob/b10964/tools/rpc/README.md)

## 11. 현재 구조에서 재사용할 것과 새로 만들 것

| 구성 | 처리 방향 | 이유 |
|---|---|---|
| 운영자 UI·제공자 등록·키·모델 승인 | 유지·확장 | 운영 제어의 기반 |
| 모델·template·runtime hash | shard manifest·cache format·tokenizer·adapter 계약 추가 | 부분 모델과 상태 호환성 식별 |
| task/attempt/epoch | group allocation·session generation·token position으로 확장 | 단계 이동·늦은 응답·중복 토큰 처리 |
| SQLite 예약·정산 CAS | 저빈도 제어 경로에 유지 | 원자적 예약·회계의 장점 유지 |
| document-v1 고정 요금 | 별도 상품으로 유지, 분산 추론 과금과 분리 | 여러 제공자의 시간·VRAM·통신이 들어가는 비용과 다름 |
| provider 전체 모델 프로세스 | backend adapter로 추상화 | 전체 모델 실행과 stage worker가 다른 기능 |
| claim()의 노드 1개 선택 | placement planner + group allocator + session admission | 큰 모델에는 여러 자원이 동시에 필요 |
| 프로세스 전체 kill | 세션 cancel과 노드 revoke를 분리 | 공유 사용자 장애 전파 방지 |
| stream=false 결과 전달 | 순서·epoch를 가진 token stream | 챗봇·agent 응답과 재접속 지원 |
| 문서별 결정적 병합 | 기존 작업 모드에 유지 | 모델 병렬 추론의 대체물이 아님 |

정산은 예를 들어 그룹 예약 시간, 약정된 VRAM/KV 용량, 실제 완료 서비스, 복구·통신 비용을 구분해 설계할 수 있다. 임차자의 서비스 요금과 여러 제공자에 대한 배분은 별도 기록이 필요하다. 제공자의 자가보고 토큰·GPU 사용량만으로 신뢰 없는 실화폐 정산을 보장하지 않는다. 기존 고정 크레딧 계약은 자동으로 바꾸지 않는다.

## 12. 실행 가능한 검증·개발 순서

### 단계 A — 한 모델을 두 GPU로 실행하는 수직 검증

승인된 두 대 또는 같은 호스트의 두 GPU, 지원되는 dense 모델 하나, 고정 양자화·문맥 길이를 정한다. 선택한 모델+약정 KV가 각 단일 GPU의 허용 용량에는 들어가지 않고, 계획한 분산 구성에는 들어가는 조건을 확인한다.

GGUF·Windows 호환 실험은 통제된 llama.cpp RPC 후보를 평가하고, 관리되는 Linux 클러스터는 vLLM TP/PP 후보를 평가한다. WAN 지향은 Petals의 지원 모델에 맞춘 private swarm 실험을 별도 평가한다. 같은 모델을 두 backend가 지원하지 않으면 성능 비교와 기능 검증을 구분한다.

인수 기준:

- 계획된 가중치·레이어·KV가 실제 GPU들에 배치됨을 telemetry로 확인.
- 이전 대화 정보를 요구하는 다중 턴 입력과 긴 문맥 조회가 유지됨.
- 같은 모델·정밀도의 충분한 메모리 기준 실행과 logits/출력 품질을 비교.
- 기대한 입력+출력 길이에서 OOM·조용한 context truncation이 없음.
- 모델 적재 시간, TTFT, token latency, 각 stage VRAM을 분리 기록.

여기서는 사용자·결제·대규모 최적화보다 “하나의 모델이 실제로 나뉘어 실행되는가”를 먼저 입증한다.

### 단계 B — 그룹 예약·세션 복구

예약 핸드셰이크, allocation epoch, 정확한 토큰 재생, token stream sequence, 부분 실패 정리를 구현한다. 각 stage의 종료·네트워크 단절·지연 응답을 주입하여 중복 토큰·오래된 KV 재사용·자원 누수가 없는지 확인한다.

모든 구현은 기존 task 모드와 구분되는 protocol version으로 도입한다. 기존 제공자와 서버가 잘못된 새 요청을 묵인하지 않게 한다.

### 단계 C — LAN 다중 사용자

동일 모델 1·2·4·8세션, 짧은/긴 prompt 혼합, agent 대기·분기, prefix hit/miss를 테스트한다. continuous batching, KV quota, chunked prefill을 한 단계씩 추가해 기여를 분리 측정한다. 저메모리 GPU는 동시성을 1로 유지하는 것이 최선일 수 있다.

### 단계 D — WAN 프로파일

실제 승인 PC들과, 재현 가능한 지연·대역폭·jitter·손실 제약 아래 비교한다. 예시 실험 축은 100Mbps/1Gbps/10Gbps와 RTT 1/20/80/150ms다. 이것은 장비가 해당 조건을 낸다는 주장이 아니라 테스트 조건의 제안이다.

단계 수·stage 직접 연결/relay 경유·local GPU 참여 유무·KV 재생/전송을 비교한다. 지속적인 상호 연결을 요구하는 엔진의 장애 동작과 NAT 환경도 확인한다. WAN은 LAN과 다른 응답 속도 등급을 허용하되 실제 측정값을 제시한다.

### 단계 E — 관측된 병목에만 추가 최적화

prefix hit가 높으면 Radix/prefix sharing, agent idle KV가 크면 CPU offload, 긴 입력 간섭이 크면 chunked prefill 조정, stage 병목이 명확하면 레이어 재분배나 stage replica를 검토한다. 충분한 GPU와 고속망이 있을 때만 P/D 분리와 공유 KV 계층을 평가한다.

## 13. “효율적이다”를 판단할 벤치마크 계약

비교 대상은 같은 모델·양자화·context·출력 상한·샘플링·품질 조건으로 맞춘다. CPU offload 기준 실행도 “느리지만 가능한 기존 방법”으로 포함하고, 충분한 단일 원격 GPU가 있으면 비용 대비 기준점으로 포함한다. 현재 문서 task 실행은 목표 기능이 달라 큰 모델 분산 실행의 동등 성능 baseline으로 사용할 수 없다.

필수 기록:

| 영역 | 지표 |
|---|---|
| 사용자 체감 | queue time, cold/warm TTFT, token 간 지연 p50/p95/p99, 전체 완료 시간 |
| 처리량 | 총 output tokens/s와 SLO를 만족한 요청·토큰 처리량 |
| 메모리 | stage별 가중치·workspace·활성/유휴 KV·예약량·peak VRAM·OOM |
| 통신 | boundary별 전송량·유효 대역폭·RTT·jitter·relay 경유·재전송 |
| 캐시 | 토큰 기준 hit, 재-prefill 토큰 수, offload/restore 시간, eviction |
| 공정성 | tenant별 서비스 비용·대기 시간·긴 요청 starvation·KV 점유 |
| 신뢰성 | provider 회수·연결 단절·중앙 재시작 후 복구 시간, 중복 토큰·정산 |
| 경제성 | GPU 예약 시간, 유휴 stage 시간, cold load, egress, 재시도 포함 완료 비용 |
| 정확성 | 긴 문맥 retrieval, 다중 턴 상태, agent tool 결과 유지, tenant 간 혼입 |

closed-loop 동시 사용자 실험만 하면 느려질수록 입력 부하도 줄어 성능이 좋아 보일 수 있다. 일정 도착률과 burst를 주는 open-loop 실험을 함께 사용한다. warm/cold cache를 분리하고 반복 실행의 분산과 tail 표본 수를 기록한다. 충분한 p99 표본이 없으면 p99를 확정 결론으로 쓰지 않는다.

실험 전에 목표 TTFT·token latency·최대 비용·최소 완료율을 정한다. 근거 없는 “20% 개선”을 성공 기준이나 달성 수치로 만들지 않는다. 안정성·품질을 유지하며 해당 목표를 만족한 비용 대비 처리량으로 선택한다.

현재 미확정인 값은 목표 모델·양자화, 참여 GPU 종류·대수, NIC와 네트워크, 동시 사용자 수, 허용 latency, 가격·제공자 신뢰 수준이다. 이 값이 없는 상태에서도 아키텍처의 부적합과 KV 정합성 조건은 판단할 수 있지만, 최적 분할 수와 경제성은 결정할 수 없다.

## 14. 의사결정 기록

요청한 판단 근거를 **확인된 사실 → 설계 영향 → 선택 → 포기하는 이점 → 재검토 조건**으로 기록한다.

| 확인된 사실·근거 | 선택 | 얻는 것 | 포기하는 것·재검토 조건 |
|---|---|---|---|
| 목표 모델이 단일 GPU에 안 들어가며 현 코드는 작업 병렬화 | 모델 shard와 실행 그룹을 새 기본 단위로 도입 | 실제 VRAM 결합 가능 | 구현 범위가 커짐. 슬롯 증가만으로 해결하지 않음 |
| KV는 레이어별 상태이고 일반 PP는 activation을 전달 | KV를 담당 stage에 유지 | 문맥 유지와 통신량 절감 | stage 이동 시 복구 비용. 측정 후 선택적 KV 이동 |
| LAN과 WAN의 연결 특성이 다름 | 네트워크 계층별 TP/PP 선택 | 둘 다 지원하면서 부적합 배치 방지 | 단일 만능 설정을 제공하지 못함 |
| 적은 요청의 PP는 순차 지연과 bubble 존재 | 최소 단계 후보와 충분한 단일 원격 GPU도 비교 | 사용자 속도와 비용을 객관적으로 평가 | 많은 작은 GPU를 항상 활용하지 않음 |
| 여러 사용자의 상태가 계속 성장 | 그룹 전체 KV 입장 제어 | OOM·중간 실패 감소 | 초기 최대 출력 예약은 보수적 |
| cache locality와 공정성이 충돌 | tenant deficit·quota 안에서 affinity 사용 | 재사용과 사용자 보호의 균형 | 캐시 hit만 극대화한 처리량보다 낮을 수 있음 |
| WAN KV 전송은 클 수 있고 장애 원본은 사라질 수 있음 | 토큰 재생을 기본 복구 경로로 채택 | 단순하고 일반적인 복구 | 긴 문맥 failover가 느림. activation checkpoint는 이후 |
| 사용자마다 같은 가중치 복제는 낭비 | 호환 사용자끼리 같은 실행 그룹 공유 | VRAM·배칭 효율 | 강한 전용 격리 요구는 별도 그룹으로 처리 |
| RPC와 임의 제공자에는 명확한 신뢰 제약 | 승인 제공자·지원 모델 제한부터 시작 | 검증 가능한 초기 서비스 | 공개 무신뢰 GPU 시장을 즉시 제공하지 않음 |
| 현 성능 자료는 단일 로컬 작업 기록과 기능 테스트 | 성능 우위를 미확정으로 유지 | 과장 없는 개발·투자 판단 | 실제 다중 GPU 실험이 추가로 필요 |

**우선 개발해야 하는 것은 전역 KV 저장소가 아니라, 정확한 모델 분할 실행과 세션 단위 자원 예약이다.** 그 위에 단계별 KV 관리·continuous batching·공정성·복구를 올리고, 실측으로 이득이 있는 경우에만 KV 이동과 더 복잡한 캐시 계층을 추가하는 것이 현재 근거에 가장 부합한다.

## 15. 재현 기록과 자료 해석의 한계

기존 검증 실행:

~~~powershell
node --test tests/engine.test.mjs tests/maintenance.test.mjs
python -m unittest discover -s tests -p provider_test.py -v
python docs/research/kv_capacity_model.py
~~~

앞의 두 명령은 각각 39개·8개 테스트 통과. 마지막 명령은 이 문서의 산술 계산이며 GPU 벤치마크가 아니다. 런타임·서비스를 새로 띄우거나 모델을 다운로드하지 않았다.

자료는 논문 원문·저자 저장소·프로젝트 공식 문서를 사용했다. Petals·Helix·HexGen은 본문의 배치/복구/실험 조건까지 확인했고, 캐시·serving 부가 기법은 원문 초록 또는 공식 기능 문서 수준에서 관련 메커니즘을 검토했다. 모든 연구 구현을 설치해 재현한 것은 아니다. 최신 문서의 기능을 현재 pin된 runtime의 기능으로 자동 간주하지 않았다.

현재 파일은 연구 결과와 권장 설계이고, 제안한 분산 모델 실행·멀티테넌트 KV 관리 기능의 구현 완료 보고서가 아니다.




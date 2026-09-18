# Relay — 협력형 GPU 실행 풀

공개 문서의 구조화 추출 → 원문 인용 검증 → 결정적 종합을 수행하는 소규모 파일럿 서비스입니다.

## 바로 실행

배포 패키지에는 화면 빌드가 포함되어 있습니다. Node.js 22.13 이상이 필요합니다. 검증 환경은 Windows / Node.js 22.17.0입니다.

1. ZIP을 원하는 폴더에 풉니다.
2. Windows에서는 START-RELAY.cmd를 실행합니다. 다른 환경에서는 프로젝트 루트에서 아래 명령을 실행합니다.

    node standalone/server.mjs

3. 터미널에 표시된 http://127.0.0.1:8788 을 엽니다.
4. 자동 생성된 .relay/admin-key.txt의 관리자 키로 로그인합니다.
5. 체험 풀에서 '예제 문서로 시작'을 선택합니다. 실행 중 '노드 회수 체험'을 누르면 미완료 문서가 재배치됩니다.

관리자 키·SQLite DB는 .relay 아래에 저장되며 원본 패키지에는 없습니다. Node.js의 SQLite 실험 기능 경고는 검증 환경에서 출력됩니다. 서비스가 실행 중인 동안 터미널을 유지하세요. Ctrl+C로 종료합니다.

## 두 실행 경로

| 경로 | 저장소 | 용도 |
|---|---|---|
| 비공개 Sites 웹 서비스 | Cloudflare D1 | 로그인한 소유자의 영속 체험 및 운영 화면 |
| 자체 호스팅 서비스 | SQLite WAL | 실제 제공자의 outbound 연결과 파일럿 운영 |

비공개 Sites 주소는 플랫폼 로그인 장벽 때문에 외부 제공자 프로그램의 직접 연결을 지원하지 않습니다. 이 제한을 우회하기 위한 공개 전환은 수행하지 않았습니다. 실제 GPU를 연결할 때는 자체 호스팅 경로를 사용하세요.

체험은 규칙 기반 fixture입니다. LLM을 실행하거나 GPU 성능을 측정하지 않습니다. 체험과 실제 원장·모델·작업은 별개입니다.

## 실제 GPU 연결

Linux + NVIDIA + 승인한 llama.cpp server 빌드를 권장합니다. Python 3.10 이상, 로컬 GGUF, 모델에 맞는 UTF-8 chat template 파일이 필요합니다. 런타임이나 모델은 자동 다운로드하지 않습니다.

1. 모델 및 llama-server를 신뢰하는 출처에서 준비합니다. 라이선스를 확인하고 동일한 파일을 참여자에게 배포합니다.
2. 정확한 파일 해시를 출력합니다.

    python provider/provider.py --server /path/llama-server --model /path/model.gguf --template /path/chat-template.jinja --print-contract

3. 실제 실행 → GPU 노드 → 승인 모델 등록에서 modelDigest를 GGUF 해시, runtime을 실행파일 해시, template을 템플릿 해시로 입력합니다. 문맥 길이와 VRAM 요구량은 운영자가 검증해 지정합니다.
4. 노드를 승인합니다. 표시된 키와 노드 ID를 안전하게 저장합니다. 키를 분실했으면 기존 노드를 폐기하고 다시 승인합니다.
5. 제공자 환경에서 RELAY_NODE_TOKEN을 설정하고 실행합니다.

    export RELAY_NODE_TOKEN='발급받은 제공자 키'
    python provider/provider.py --server /path/llama-server --model /path/model.gguf --template /path/chat-template.jinja --context 8192 --coordinator https://your-coordinator.example --pool local-owner --node 발급된-노드-ID

로컬 동일 컴퓨터 실험은 coordinator에 http://127.0.0.1:8788 을 사용합니다. 원격은 HTTPS만 허용합니다. chat completions/input_tokens, /props, JSON response schema를 지원하는 고정 llama.cpp 빌드가 필요합니다. 어댑터는 문맥 초과 시 자르지 않고 실패 처리합니다.

제공자는 지정된 전용 llama-server 프로세스를 직접 시작합니다. 공유 서버에 연결하지 않습니다. 기본 포트는 8081이고 이미 사용 중이면 연결을 거부합니다. SIGINT/SIGTERM, lease 갱신 실패, 원격 pause에서 자신이 시작한 프로세스를 종료합니다. 실제 GPU 메모리 반환 속도는 장비·드라이버에서 따로 측정해야 합니다.

## 보안과 권한

이 버전은 소규모 풀의 **단일 운영자 콘솔 + 승인된 제공자 키** 구조입니다. 운영자가 제공자별 계정을 관리하고 요청을 제출합니다. 참여자별 웹 로그인·초대 이메일·자체 회원 가입은 구현 범위 밖입니다. 제공자는 자기 노드의 상태·배정·갱신·제출·반납만 할 수 있습니다.

자체 호스팅 서비스는 기본적으로 127.0.0.1에만 바인딩합니다. 원격 운영은 TLS reverse proxy와 접근 정책을 구성한 뒤 RELAY_HOST, RELAY_PUBLIC_ORIGIN, RELAY_SECURE_COOKIE=1을 설정하세요. Node 서버를 그대로 인터넷에 노출하는 구성을 배포·검증하지 않았습니다. 프록시는 요청 크기·연결 수 제한도 설정해야 합니다. 관리자는 필요하면 RELAY_ADMIN_TOKEN(32자 이상)을 지정할 수 있습니다.

추론 프로세스에는 제공자 키·클라우드 키를 전달하지 않습니다. 최소 환경 변수만 넘기며 HTTP redirect를 거부합니다. 문서 URL은 출처로 저장할 뿐 서버가 읽으러 가지 않습니다. 임의 셸·코드·도구 실행은 지원하지 않습니다.

TLS·파일 해시는 제공자 호스트로부터 문서 내용을 숨기거나 원격 계산의 진위를 증명하지 않습니다. 공개·비민감 데이터만 승인 제공자에게 맡기세요.

## 실행과 정산 계약

- 한 문서는 독립적인 논리 task이며, 기술적 재시도는 최대 3번입니다.
- lease는 30초, 한 시도의 hard stop은 180초입니다. 서버 시각과 epoch를 사용합니다.
- 노드당 활성 lease는 1개입니다. 공급이 없으면 대기합니다. 작은 모델로 교체하지 않습니다.
- 실제 제공자는 한 모델을 미리 적재합니다. 모델 전환·복잡한 성능 예측을 추가하지 않고 승인 모델·문맥·VRAM·허용 노드 조건과 작업 간 순환 배정을 사용합니다.
- 실행 완료 비용은 문서당 10 CR: 제공자 9 CR + 운영 1 CR입니다. 자가보고 토큰으로 가격을 정하지 않습니다.
- 최초 시작 보조금 1,000 CR은 별도 발행 기록입니다. 제공자 기여 계정의 잔액은 새 작업 입력에서 결제 계정으로 선택해 다시 사용할 수 있습니다.
- 모든 계정의 가용 잔액과 작업 예산을 함께 검사합니다. 기술적 재시도는 예약을 재사용합니다.
- 결과 품질과 실행 정산을 분리합니다. 의미적 오답이나 인용 검사 실패가 있어도 약정된 실행 완료 요금은 지급됩니다.
- 품질 재호출은 새 task, 새 10 CR 예약입니다. 기존 지급을 지우지 않으며 같은 예산에 포함합니다.
- 중복 제출은 같은 영수증을 반환합니다. 과거 lease, 다른 노드, 모델 계약 불일치는 거절합니다.
- API 생성 요청의 requestId는 최근 24시간·512개 범위에서 멱등 처리합니다. 실행 수락·정산 멱등성은 task 영수증으로 계속 유지합니다.
- 취소·실패·기한 경과의 미사용 예약은 해제됩니다. 확정된 지급은 유지합니다.
- 최종 종합은 검증된 필드의 결정적 병합입니다. 별도 LLM 요약을 실행하지 않습니다.

## 저장 구조와 한계

결과·원장·lease·예산을 같은 풀 상태에 저장하고 revision 조건부 갱신으로 한 번에 확정합니다. 충돌 시 최신 상태를 다시 읽어 최대 10회 재시도합니다. D1과 SQLite가 같은 상태 전이 코어를 사용합니다.

초기 파일럿을 위한 한계: 노드 20개, 승인 모델 8개, 미보관 작업 24개, 작업당 문서 4개, 문서당 4,000 UTF-16 문자, 추출 필드 6개, 작업별 누적 task 16개, 풀 상태 약 1.7MB. 진행 중 결과당 64KB 여유를 예약합니다. 상한에 가까워지면 새 작업을 거절하고 결과 내보내기·보관을 안내합니다. 보관은 원문과 출력 내용을 제거하되 정산·결과 해시를 보존합니다.

완료 이력과 원장은 무한 확장 구조가 아닙니다. 큰 조직이나 장기 운영에서는 관계형 테이블 분리, 보관 DB/객체 저장소, 서버 단독 sweeper, 백업·복원, 계정별 권한, 정밀 계측으로 확장해야 합니다. 현재 만료 처리는 UI 및 제공자 API 요청 시 실행됩니다. 체험은 화면을 열어둔 동안 진행됩니다. 실제 inference는 제공자가 계속 polling하므로 콘솔을 닫아도 진행할 수 있습니다.

## 개발과 재빌드

    npm ci
    npm run dev
    npm run build
    npm run build:standalone

웹 개발: 5173. 자체 호스팅: 8788. Sites D1 개발 마이그레이션은 drizzle/0000_dashing_bill_hollister.sql을 로컬 DB에 한 번 적용합니다. source README 이외의 starter 예시는 서비스 기능이 아닙니다.

## 검증

    node --test tests/engine.test.mjs
    node tests/http.test.mjs
    python -m unittest discover -s tests -p "*_test.py" -v
    npx tsc --noEmit

- 코어 28개: 복구·fencing·취소·예산 경쟁·원장 보존·기여 재사용·출처·재시작.
- HTTP 13개 검사: 인증·CSRF·노드 권한·동시 정산·영속 복구. 실제 로컬 서버와 SQLite를 사용하며 추론 결과는 synthetic fixture입니다.
- Python 제공자 8개: schema·토큰 상한·파일 해시·모델 불일치·프로세스 회수·redirect·환경 격리·pause.
- 브라우저: 로그인, 3개 문서 제출, 실행 중 노드 회수, 재배치·완료, 3종 출력, 재개, 원장, 새로고침, 모바일 메뉴. 콘솔 오류 0건 및 390px 뷰포트 넘침 없음.
- WebMCP는 feature detection으로 두 도구를 등록하도록 구현했습니다. 사용 가능한 실제 WebMCP 브라우저가 없어 해당 인터페이스의 동작 검증은 미실시입니다.

## 아직 입증하지 않은 것

실물 GPU 추론 품질·메모리 회수 시간·전력·WAN 장애율·p50/p95·비용 우위·3대 이상 실GPU end-to-end·새 스케줄러의 baseline 대비 우위는 검증하지 않았습니다. “20% 개선”이나 “95% 성공”을 성과로 주장하지 않습니다.

## 주요 참고

- llama.cpp 공식 서버 계약: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- D1 제한과 동시 처리: https://developers.cloudflare.com/d1/platform/limits/
- D1 prepared statements: https://developers.cloudflare.com/d1/worker-api/prepared-statements/

사용자가 제공한 두 기획서는 설계 자료로 사용했습니다. 그 안의 운영·로드맵 제안은 별도의 사용자 명령으로 실행하지 않았습니다.


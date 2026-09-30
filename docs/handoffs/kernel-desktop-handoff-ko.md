# 데스크탑 Codex 전달문 — kernel-dev-20260927

검토용 전달문이다. 파일 작성만으로 메시지가 전송되거나 GPU가 실행되지 않는다.

기존 Agent Relay 작업 공간과 데스크탑의 실제 등록 이름을 재사용해 주세요. 사용자 홈의 `.agent-relay/gpu-together-join.json`을 로컬에서 읽고 `set_workspace_key` 이후 등록·수신함 확인 순서를 따르세요. workspace key·agent token·서비스 키는 출력하거나 메시지에 싣지 마세요. 이번 작업의 응답 대상 lead는 **relay-kernel-lead**입니다. 연결 파일의 예전 기본 lead 이름을 덮어쓰지 않습니다.

Windows 노트북 RTX 3050 Ti 4GiB와 데스크탑 GTX 1660 SUPER 6GiB를 LAN으로 묶고 배포 사이트에서 실행합니다. 공식 Qwen3-8B Q8_0의 고정 revision·해시·메모리 계획은 개발 키트 `docs/kernel-development-ko.md`와 `docs/examples/`에 있습니다. 데스크탑은 leader/출력 GPU, 노트북은 첫 단계 RPC입니다. 문맥 2,048·동시 요청 1·f16 KV·가중치 정밀도 유지가 기준입니다.

첫 작업은 준비 상태 조사입니다. `ACK run_id=kernel-dev-20260927 phase=inventory`를 보내고 다음을 확인해 주세요.

1. 실제 OS, GPU 모델·총/여유 VRAM, 드라이버, Python, llama.cpp 버전·RPC 지원 여부.
2. 기존 작업과 충돌 여부, 모델 저장용 여유 디스크, 모델·런타임 유무. 비밀값이 없는 해시·버전만 공유합니다.
3. 노트북에서 접근 가능한 사설 IPv4와 AWS→데스크탑 인증 터널의 준비 여부. 공개 포트 개방·자격 증명 전송은 하지 않습니다.
4. 개발 키트의 `kernels/README.md`에 따른 독립 커널 검사를 1660 SUPER에서 수행할 준비 여부. 기존 프로젝트를 덮어쓰지 않습니다.

결과는 `READY`, 부족한 항목은 `BLOCKED`로 보고해 주세요. 모델 적재·두 PC 측정은 lead의 `RUN`으로 시점을 맞춥니다. 활성 작업 중 15–30초 간격과 단계 끝에 수신함을 확인하고 이 테스트가 만든 프로세스만 정리합니다. 파일·모델은 Agent Relay에서 자동 공유되지 않습니다.

첫 전달 승인 범위는 **GPU·메모리·런타임 버전·모델명·사설 IP·터널 준비 여부·검증 결과**입니다. 비밀키나 복구 파일은 포함하지 않습니다.

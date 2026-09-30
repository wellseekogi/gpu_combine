# 문서 안내

설치와 실행은 [프로젝트 README](../README.md), 코드 수정 지점은 [프로젝트 구조 지도](../PROJECT_MAP.md)에서 시작합니다. 운영·설계 문서는 이 폴더에, 다른 PC에 전달할 지침은 `handoffs/`, 과거 검증·측정 기록은 `reports/`에 둡니다. 기록의 날짜와 검증 한계를 확인하고 현재 동작은 운영 문서와 소스를 기준으로 판단합니다.

## 설치·운영

- [개인 GPU 제공·이용](participant-onboarding-ko.md)
- [분산 LLM 설정·운영](distributed-inference-ko.md)
- [AWS 중앙 서버 배포](aws-deployment-ko.md)
- [참여자 프로그램 자동 업데이트](provider-auto-update-ko.md)
- [Chrome 다운로드 차단 점검](chrome-download-block-ko.md)
- [초기 설정 경험](setup-experience-ko.md)

## 구조·설계·커널 개발

- [전체 구성·상태·신뢰 경계](architecture-review-ko.md)
- [분산 실행 공간과 네 계층 계약](distributed-workspace-design-ko.md)
- [Petals 비교와 아키텍처 결정](petals-architecture-decision-ko.md)
- [KV 캐시·스케줄링 연구](kv-cache-scheduling-research-ko.md)
- [분산 실행 코어·커널 개발](kernel-development-ko.md) · [커널 구현·검사](../kernels/README.md)

## 다른 PC에 전달할 지침

- [두 PC의 Codex로 성능 검증](handoffs/AGENT-RELAY-TWO-PC.md)
- [AWS 실제 GPU 실행·검증](handoffs/AWS-REMOTE-GPU-CODEX.md)
- [커널 개발 데스크탑 전달문](handoffs/kernel-desktop-handoff-ko.md)

## 검증·측정 기록

- [서비스 심층 검증](reports/service-validation-ko.md) · [후속 수정·재검증](reports/service-validation-fixes-ko.md)
- [코어 상세](reports/validation-core-notes.md) · [분산 추론 상세](reports/validation-inference-notes.md) · [제공자 상세](reports/validation-provider-notes.md) · [제공자 실행 원문](reports/validation-provider-output.txt)
- [임차인 모델 업로드 검증](reports/renter-model-validation-ko.md)
- [라우팅·KV 코드 검토](reports/routing-kv-review-ko.md)
- [디자인 검토](reports/design-review-ko.md) · [사용자 화면 점검](reports/ux-audit-2026-09-22-ko.md)
- [통신·메모리 성능 1차](reports/performance-refactor-2026-09-29-ko.md) · [2차](reports/performance-refactor-round2-2026-09-29-ko.md)
- [CUDA 커널 성능 1차](reports/kernel-performance-2026-09-29-ko.md) · [2차](reports/kernel-round2-2026-09-29-ko.md)
- [이전 임시 터널 방식의 두 PC 검수](reports/remote-vram-test-ko.md)
- [2026-09-27 KV·추론 코드 분석](analysis/kv-inference-2026-09-27/analysis-ko.md) · [당시 분석·소스 묶음](analysis/kv-inference-2026-09-27/analysis-and-sources.zip)

## 설정 예제·원시 연구 자료

- [그룹 설정](examples/inference.config.json) · [Qwen3 두 GPU 설정](examples/qwen3-8b-two-gpu.config.json)
- [Qwen3 가중치 정보](examples/qwen3-8b-q8_0.weights.json) · [채팅 템플릿](examples/qwen3-8b.jinja)
- [KV 용량 계산](research/kv_capacity_model.py)
- [커널 1차 측정 JSON](research/kernel-performance-20260929.json) · [2차 측정 JSON](research/kernel-round2-20260929.json)

`work/`의 로컬 로그·화면 캡처와 `outputs/`의 배포·전달 자료는 Git에서 제외합니다. 보고서가 참조하는 증거와 별도 작성한 문서는 보존하고, 이 두 폴더 전체를 임시 파일로 취급해 지우지 않습니다.

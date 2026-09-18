# 참여자 프로그램 자동 업데이트

`START-PROVIDER.cmd`를 실행하면 GitHub의 정식 참여자 릴리스와 설치된 버전을 비교합니다. GitHub 저장소는 `wellseekogi/gpu_combine`이며 참여자 릴리스 태그는 `provider-v0.3.0` 형식입니다. 미리보기 릴리스와 draft는 업데이트 대상으로 사용하지 않습니다.

## 사용자 실행

처음 한 번 자동 업데이트가 포함된 ZIP을 모두 압축 해제한 뒤 `START-PROVIDER.cmd`를 실행합니다. 이후에는 같은 파일을 실행하면 됩니다. 예전 자동 업데이트 기능이 없는 CMD는 처음 한 번 교체해야 합니다.

실행 순서는 최신 릴리스 조회 → 버전 비교 → ZIP 다운로드 → SHA-256과 포함 파일 검증 → 사용할 버전 전환 → PC 설정 창 실행입니다. 공개 릴리스는 GitHub 로그인이나 Git 설치 없이 받을 수 있습니다. Python 3.10 이상과 Tkinter는 필요합니다.

설정 창을 이미 열었다면 닫고 다시 실행해야 새 버전이 적용됩니다. 실행 중인 참여자 파일을 덮어쓰거나 GPU 작업을 강제로 중지하지 않습니다.

## 업데이트 파일과 사용자 데이터

Windows의 설치 캐시는 `%LOCALAPPDATA%/Relay/provider-app`입니다. 버전별 파일과 현재 버전 포인터만 저장합니다. 기존 `%LOCALAPPDATA%/Relay/provider-setup.json`, 연결 JSON, GGUF 모델, llama-server 및 템플릿은 배포 ZIP에 포함하거나 덮어쓰지 않습니다.

네트워크가 끊기거나 배포 검증에 실패하면 메시지를 표시하고 무결성이 확인된 기존 버전 또는 최초 ZIP 버전을 실행합니다. 확인 가능한 버전이 하나도 없으면 실행하지 않고 오류를 표시합니다. 파일 해시는 손상·불완전 다운로드를 검출하며, 배포의 신뢰 기준은 HTTPS로 연결한 지정 GitHub 저장소입니다.

## 새 버전 배포

1. 참여자 코드를 수정하고 테스트합니다.
2. `provider/version.json`의 버전을 이전 배포보다 높입니다. 예: `0.3.0` → `0.3.1`.
3. 필요한 소스 변경과 버전 파일을 GitHub에 커밋·push합니다.
4. 해당 커밋에 `provider-v0.3.1` 태그를 만들어 push합니다.
5. `Publish provider update` GitHub Actions가 테스트와 패키징을 수행하고 정식 릴리스를 게시합니다. 참여자는 다음 실행 때 업데이트합니다.

같은 버전의 파일을 덮어 배포하지 않습니다. 수정이 필요하면 버전을 다시 올립니다. 배포 ZIP과 해시 manifest가 함께 준비되기 전에는 draft 상태를 유지합니다.

로컬 패키지를 만들 때는 `node scripts/package-provider.mjs`를 사용합니다. 결과는 `outputs/provider-release`에 생성됩니다. `--out`으로 출력 폴더를 지정할 수 있습니다. ZIP에는 명시적으로 지정한 참여자 프로그램 파일만 들어갑니다.

개발 저장소에서 `START-PROVIDER.cmd`를 실행하면 편집 중인 소스를 사용합니다. 배포 업데이트를 검증할 때는 생성한 ZIP을 별도 폴더에 풀고 `python provider/update_launcher.py --check-only`로 확인합니다. 이 명령은 업데이트만 확인·설치하고 설정 창이나 GPU를 실행하지 않습니다.

# Chrome의 위험한 다운로드 차단 점검

## 현재 상태 (2026-09-19)

다른 PC의 Chrome에서 PC 설정 도우미 ZIP에 빨간 느낌표와 **위험한 다운로드**가 표시된다고 보고되었습니다. 이는 사용 빈도 경고나 HTTP 다운로드 경고와 구분해서 확인해야 합니다. 이 문서 작성 시 Google의 상세 판정 근거, 배포 서버의 실제 ZIP과 로컬 파일의 일치 여부, 수정 후 Chrome 차단 해제는 확인하지 않았습니다.

서비스: https://gpu-together.3.38.50.72.sslip.io

공개 다운로드: https://gpu-together.3.38.50.72.sslip.io/api/participation/provider.zip

운영자 다운로드: `/api/setup/provider.zip` (운영자 세션 필요)

점검 시작 시 배포 기록은 0.3.2입니다. 작업 중 같은 폴더의 병행 변경으로 로컬 버전이 0.4.0으로 갱신되어 해당 변경을 유지했습니다. 로컬 수정·패키징은 AWS 반영이나 GitHub 릴리스 게시를 의미하지 않습니다. 배포할 때 현재 버전과 전체 변경 내용을 다시 확인해야 합니다.

## 확인한 내용과 수정

- 패키지는 허용 목록에 지정된 CMD·Python·JSON만 포함합니다. Python 자체, EXE, DLL, 모델, 계정 복구 파일, PC 연결 키는 포함하지 않습니다.
- 사이트에서 생성하는 ZIP에는 서비스 주소와 해당 파일의 SHA-256이 포함됩니다. 서비스 주소가 없는 GitHub 릴리스 ZIP과 해시가 다르므로 서로 비교해서 변조로 단정하면 안 됩니다.
- 기존 업데이트 코드는 익명 요청이 HTTP 401/403/404로 실패하면 `GH_TOKEN`·`GITHUB_TOKEN` 또는 `gh auth token`으로 사용자 GitHub 인증 정보를 자동 탐색했습니다. 공개 도우미에 불필요한 동작이므로 이번 로컬 수정에서 제거했습니다. 이 동작이 Chrome 판정의 원인이라는 증거는 없습니다.
- 이제 기본 업데이트는 익명 요청을 사용합니다. 실패하면 검증된 기존 버전을 사용합니다. TLS 검증, 저장소 제한, ZIP 및 파일 해시 검증은 유지합니다.
- 로컬 Windows Defender 조회 결과 백신 서비스가 비활성 상태여서 백신 검사는 완료하지 못했습니다. 패키지·업데이트 테스트 통과는 악성 코드 검사 통과나 Google의 안전 판정을 의미하지 않습니다.

확장자 변경, 암호화 압축, Chrome 보호 기능 해제는 이 문제의 배포 해결책으로 사용하지 않습니다. Google은 코드 서명을 권장하지만 서명이 없다는 사실만으로 원치 않는 소프트웨어로 분류하지는 않는다고 명시합니다. 서명된 설치 프로그램도 차단 해제를 보장하지 않습니다.

## 배포 및 재검토 순서

1. 수정된 패키지·업데이트 테스트를 통과시킨 뒤, 실제 배포할 ZIP을 최신 백신이 작동하는 환경에서 검사합니다. 검사 엔진·정의 버전·시간·결과와 ZIP의 SHA-256을 기록합니다. 탐지되면 해당 파일과 동작을 먼저 해결합니다.
2. 기존 릴리스 파일을 덮어쓰지 않고 검증한 현재 버전을 새 릴리스로 배포합니다. AWS의 사이트 다운로드도 검증된 소스로 갱신하고, 실제 내려받은 파일의 구성·버전·해시를 확인합니다. 계정·DB·GPU 연결 설정은 배포 파일에 포함하지 않습니다.
3. 사이트 소유자의 [Google Search Console](https://search.google.com/search-console)에 로그인하여 해당 HTTPS 주소의 속성을 선택하고 **보안 문제** 보고서를 확인합니다. 아직 속성을 등록하지 않았다면 해당 주소를 관리하는 계정으로 소유권을 확인해야 합니다.
4. 다운로드 관련 문제가 표시되면 영향받은 URL과 Google이 제시한 내용을 확인하고, 문제를 해결한 뒤 **검토 요청**을 제출합니다. ZIP 주소, 버전, 검사 결과, 변경한 동작을 정확하게 적습니다. 이 문서만으로 무해함이 입증됐다고 기재하지 않습니다.
5. 문제가 없거나 검토 요청 버튼이 없는데 차단이 계속되면 Google의 [멀웨어·원치 않는 소프트웨어 안내](https://developers.google.com/search/docs/monitor-debug/security/malware)에 있는 보안 문제 신고 경로를 확인합니다. 재검토 완료와 다른 PC의 Chrome 다운로드 성공을 모두 확인한 뒤 해결로 기록합니다.

Google 안내상 재검토에는 며칠에서 몇 주가 걸릴 수 있습니다. 파일명·URL·도메인을 바꿔 Google 검사를 피하는 방식으로 완료 처리하지 않습니다.

## 재검토 요청용 초안

아래 내용은 배포 및 검사가 끝난 뒤 실제 결과를 채워서 제출합니다. 미완료 항목은 완료했다고 쓰지 않습니다.

> Our Relay PC setup download is reported as a dangerous download in Chrome.
> Download URL: https://gpu-together.3.38.50.72.sslip.io/api/participation/provider.zip
> Verified deployed version: [fill after deployment]
> SHA-256 of the deployed ZIP: [fill after verifying the actual download]
> Antivirus engine, definitions, scan time and result: [fill after scanning]
> The program prepares a user-selected local model and connects a participant PC to the Relay service. GPU work starts when the user explicitly starts participation.
> In the verified deployed version above, we removed automatic discovery of GitHub credentials from environment variables and the GitHub CLI after failed anonymous update requests. Public updates now use anonymous requests and fall back to a verified existing version on failure. We have not established whether this behavior caused the Chrome classification.
> Please review the indicated download and provide details of any remaining issue.

## Google 공식 자료

- [Chrome에서 일부 다운로드를 차단함](https://support.google.com/chrome/answer/6261569?hl=ko)
- [멀웨어 및 원치 않는 소프트웨어 가이드라인](https://developers.google.com/search/docs/monitor-debug/security/malware)
- [Search Console 보안 문제 보고서](https://support.google.com/webmasters/answer/9044101?hl=ko)

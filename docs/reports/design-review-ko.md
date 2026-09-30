# Relay 0.2 — 디자인 적용 및 검증

## 요약

평가: **Good**. 목적은 운영자가 작업과 참여 PC 상태를 확인하고 제출·회수·결과 확인까지 진행하는 것입니다. 웹 앱에 Apple HIG의 정보 계층·가독성·일관성·접근성 원칙을 적용했습니다. 네이티브 macOS 메뉴나 창 장식을 모방하지 않았습니다.

사용자가 지정한 [Apple Design Skill](https://github.com/dickwu/apple-design-skill)의 `SKILL.md`와 11개 HIG 참조 문서를 읽었습니다. 적용 기준 커밋은 `da2da6dd03aacf06da3fecf205347601d38bb141`입니다. 스킬의 제안 중 현재 웹 앱과 관계없는 OS 전용 동작은 제외했습니다.

## 검토와 수정

| 수준 | 이전 화면의 문제 | 반영한 변경과 근거 |
|---|---|---|
| High | 큰 홍보 문구와 짙은 배너가 운영 정보보다 먼저 보임 | 제목을 ‘나의 워크스페이스’로 바꾸고 작업·참여 컴퓨터를 중심에 배치. `layout.md › Best practices`: “Make essential information easy to find by giving it sufficient space.” |
| High | 색상이 개별 클래스에 고정되어 다크 모드 부재 | 역할별 CSS 변수와 시스템 `prefers-color-scheme` 적용. `dark-mode.md › Best practices`: “Ensure that your app looks good in both appearance modes.” |
| Critical | 실행 환경 탭이 존재하지 않는 패널을 참조 | 단일 선택 상태를 표시하는 버튼 그룹과 `aria-pressed`로 변경. Axe 자동 점검의 잘못된 ARIA 참조 오류 해소. 웹 접근성 구현 판단. |
| Medium | 작은 화면에서 표의 상태·크레딧을 가로로 스크롤해야 확인 | 작업 목록을 제목·상태·진행·비용을 담은 행으로 전환. `lists-and-tables.md › Content`: “Consider ways to preserve readability of text that might otherwise get clipped or truncated.” |
| Medium | 플랫폼 로그인·호스팅 제약과 실제 제공자 구조가 혼재 | 내 서버의 관리자 인증만 제공. 문서 제출→중앙 스케줄러→참여자 컴퓨터→결과 보존의 실행 흐름을 표시. 제품의 실제 책임 경계를 시각화한 디자인 판단. |

현재 자동 점검에서 Critical·High 오류가 남아 있지 않습니다. 실제 스크린리더 사용자 시험, 여러 OS 실기기 시험은 수행하지 않았으므로 접근성 전체 준수를 보증하지 않습니다.

## 토큰과 레이아웃

기본 팔레트는 배경·표면·주 콘텐츠·보조 콘텐츠·동작·구분선의 여섯 역할로 구성했습니다. 밝은 배경 `#f5f5f7`, 표면 `#ffffff`; 어두운 배경 `#1b1b1d`, 표면 `#252527`입니다. 상태 색은 성공·부분 완료·오류 의미로만 사용하고 반드시 텍스트를 함께 표시합니다.

아래 값은 실제 CSS의 sRGB 색으로 계산한 WCAG 상대 휘도 대비입니다.

| 역할 | 밝은 전경 / 배경 | 대비 | 어두운 전경 / 배경 | 대비 |
|---|---|---|---|---|
| 주 콘텐츠 | `#1d1d1f` / `#ffffff` | 16.83:1 | `#f0f0f3` / `#252527` | 13.45:1 |
| 보조 콘텐츠 | `#61616a` / `#ffffff` | 6.13:1 | `#b5b5bf` / `#252527` | 7.52:1 |
| 주요 동작 | `#ffffff` / `#0067c5` | 5.61:1 | `#102d52` / `#82b8ff` | 6.75:1 |
| 링크 | `#0067c5` / `#ffffff` | 5.61:1 | `#82b8ff` / `#252527` | 7.47:1 |
| 완료 상태 | `#24683f` / `#e8f2ec` | 5.87:1 | `#94d9ad` / `#283e31` | 7.01:1 |
| 부분 완료 | `#795315` / `#faf0dc` | 6.06:1 | `#efcc87` / `#443a26` | 7.27:1 |

글꼴은 `-apple-system, BlinkMacSystemFont, Segoe UI, Malgun Gothic, sans-serif`이며 외부 폰트를 내려받지 않습니다. 제목 32px, 섹션 17px, 본문 15px, 보조 12~14px를 rem 단위로 적용했습니다. 숫자와 영수증에는 일정 폭 숫자/시스템 고정폭 글꼴을 사용합니다. 모바일 입력은 16px, 주요 조작은 최소 44px입니다. 작은 텍스트에 얇은 글꼴을 쓰지 않았습니다.

일반 화면에서는 사이드바와 본문을 구분하고, 좁거나 글자가 커지는 환경에서는 내용을 수직으로 재배치합니다.

```text
일반 화면
┌───────────┬────────────────────────────────┐
│ 풀 · 메뉴 │ 현재 위치 / 로그인 상태         │
│           ├────────────────────────────────┤
│           │ 제목 · 실행 환경 · 새 작업       │
│           │ 진행 / 연결된 PC / 크레딧        │
│           │ 최근 작업       │ 참여 컴퓨터    │
│           │ 제출 → 스케줄러 → PC → 결과      │
│           │ 최근 활동       │ 복구 안내      │
└───────────┴────────────────────────────────┘

좁은 화면
┌─────────────────────┐
│ 메뉴 / 현재 위치     │
│ 실행 환경 · 제목     │
│ 요약 정보            │
│ 작업 행 · 상태·비용  │
│ 참여 컴퓨터          │
│ 실행 흐름 2열        │
│ 최근 활동            │
└─────────────────────┘
```

이 서비스의 특징은 ‘컴퓨터가 협력하는 실제 실행 경로’가 보이는 것입니다. 중앙 서버와 참여 PC를 구분하는 흐름을 하나의 강조 요소로 두었습니다. 장식용 홍보 카드를 제거하고 나머지 표면은 중립색으로 유지했습니다. 이는 일반 관리 대시보드에도 붙일 수 있는 구호보다 Relay의 실행 책임을 설명한다는 점에서 적합하다고 판단했습니다.

커스텀 반복 애니메이션은 사용하지 않습니다. 로딩과 기본 대화상자 전환은 `prefers-reduced-motion`에서 끄며, 흐름과 상태는 움직임 없이 읽을 수 있습니다. 콘텐츠는 불투명 표면이며 투명도 감소·대비 증가·강제 색상 설정에 대한 CSS 대응을 포함합니다.

## 최종 검증

- 코어 28개, 서버 유지보수 11개, HTTP 13개 검사, Python 제공자 8개 통과. Node TAP에서는 HTTP 묶음을 하나로 세어 40개 테스트로 출력됩니다.
- TypeScript·ESLint·Vite 배포 빌드 통과.
- 로그인 → 문서 3개 제출 → 노드 회수 → 재배정 → 완료·정산 → JSONL/CSV/Markdown 다운로드 → 재개 → 원장 → 새로고침 → 로그아웃 통과.
- 1440px 데스크톱, 320·390·768px 뷰포트의 페이지 가로 넘침 없음. 200% 글자 확대와 720px 축소 창에서 재배치 확인.
- 밝은/어두운 대시보드, 작업 입력, 모바일 대시보드·노드, 밝은/어두운 모델 입력, 로그인 등 8개 상태를 Axe의 WCAG 2 A/AA·2.1 AA 규칙으로 검사: 위반 0건.
- Escape로 모달 닫기, 모바일 메뉴 선택 후 닫힘, 포커스 표시 스타일 확인. 브라우저 pageerror 0건.
- 지연 조회 응답→로그아웃·노드 회수, 잘못된 로그인, 조회/변경 인증 만료 등 UI 경쟁 조건 회귀 검사 5개 통과. 이전 응답이 새 상태나 로그아웃을 되돌리지 못하도록 요청 세대와 취소를 적용했습니다.
- 대화상자 전환 도중 측정한 색 대비는 중간 애니메이션 값이므로 최종 검증은 전환 완료 뒤 다시 수행했습니다.

실물 GPU 추론과 원격 네트워크 배포는 미검증입니다. 체험 화면은 가상 노드와 규칙 기반 결과이며 실제 GPU 성능을 표시하지 않습니다.

## 참조

- [스킬 원문](https://github.com/dickwu/apple-design-skill/blob/da2da6dd03aacf06da3fecf205347601d38bb141/SKILL.md)
- [Apple: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Apple: Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Apple: Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [Apple: Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [Apple: Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)

나머지 읽은 참조: Designing for macOS, Sidebars, Toolbars, Lists and tables, Entering data, Design principles. 인용은 저장소에 포함된 HIG 사본의 해당 제목을 기준으로 했습니다.

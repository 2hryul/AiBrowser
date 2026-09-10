# goals/ — 마일스톤별 GOAL 파일 사용법

Claude Code는 저장소 루트의 `GOAL.md` 하나를 이번 세션의 목표로 읽는다. 마일스톤을 넘길 때마다 이 폴더의 해당 파일을 루트 `GOAL.md`로 복사(또는 심볼릭 링크)하고 세션을 시작한다. `CLAUDE.md`는 규칙(불변), `GOAL.md`는 목표(세션마다 교체)로 역할이 갈린다.

## 실행 순서와 선행 조건

| 순서 | 파일 | 목표 한 줄 | 세션 전 사람이 할 일 | 예상 세션 |
|---|---|---|---|---|
| 1 | GOAL-M0.md | 뜨는 빈 브라우저 골격 | npm 미러·Node 20, Claude Code 권한 설정 | 1 |
| 2 | GOAL-M1.md | 크롬 완성도(히스토리·북마크·다운로드·읽기 모드·확장) | `config/extensions.json`(사내 필수 확장 unpacked 경로, 없으면 `[]`) | 1 |
| 3 | GOAL-M2.md | ToolSurface + 오버레이/Handoff + MCP, 모의 포털 A·B·C | 없음(모의 포털은 세션이 만듦) | 1~2 |
| 4 | GOAL-M3.md | 승인 3단계·거부·되돌리기·감사 로그, 모의 포털 D·F | 없음 | 1 |
| 5 | GOAL-M4.md (M4a) | 스레드·세션·체크포인트·받은편지함·메모·북마크 메타·변경 이력, 모의 포털 E·G | 없음 | 1~2 |
| 6 | GOAL-M4.md (M4b) | 로컬 LLM 내장 에이전트 + MacroCache | **Ollama 설치 + qwen3.6:27b pull** | 1~2 |
| 7 | GOAL-M4c.md | 로그인 획득 경로 3종 + 임포트 마법사 | **`policy.json`에 `allowPasswordImport`, `externalLoginHosts` 결정 기록**(정보보호 협의) | 1 |
| 8 | GOAL-M5.md | 워크플로우 승격·오라클·골든셋(대사, 오탐 0) | 없음(20일치 fixture는 세션이 만듦) | 1~2 |
| 9 | GOAL-M6.md | 서명 인스톨러·정책 잠금·폐쇄망 검증·파일럿 계측·운영 문서 | **서명 인증서 env, `config/pilot.json`** | 1 |

M4a/M4b는 한 파일에 두 절로 있으며 세션을 나눠 실행해도 된다. M4b는 로컬 LLM이 필요해 순서를 M4c 뒤로 미룰 수 있다(둘은 독립).

## 각 세션 시작 절차

1. 이전 마일스톤 `artifacts/<m>/REPORT.md`가 전부 PASS인지 사람이 1분 확인
2. 위 표의 "세션 전 사람이 할 일"을 처리(대부분 파일 하나에 값 기록)
3. `cp goals/GOAL-M<n>.md GOAL.md`
4. Claude Code 시작(자동 수락 모드) → 첫 메시지: `GOAL.md와 CLAUDE.md를 읽고 GOAL.md의 OBJECTIVE를 SUCCESS CRITERIA가 전부 PASS일 때까지 개입 없이 수행하라.`
5. 세션 종료 후 `artifacts/<m>/REPORT.md` 확인 → 다음 마일스톤

## 공통 규약 (모든 GOAL 파일이 따르는 것)

- 한 세션의 목표는 하나. OUT OF SCOPE는 만들지 않고, 필요해지면 스코프 오류로 REPORT에 기록
- FIXED DECISIONS는 되묻지 않는다. 사람의 결정이 필요한 값은 PRECONDITIONS에 파일·키 이름으로 명시되어 있고, 없으면 시작 즉시 STOP
- SUCCESS CRITERIA는 전부 기계 판정(테스트·스크린샷·파일 존재). "됐다"를 말로 판단하지 않음
- STOP CONDITIONS: 같은 근본 원인 5회 실패, 환경 문제, 스코프 오류. 억지 진행 금지
- 사내 포털에 접근할 수 없으므로 M2~M5의 검증은 **모의 포털 fixture**(`fixtures/portals/`)로 한다. 시나리오 문서의 A~H 기술 패턴을 각각 재현한다. 실제 포털 검증은 파일럿(M6 이후) 단계에서 사람이 수행
- 보안 불변 조건(CLAUDE.md 1~9)은 모든 GOAL에 적용. 특히 인증 토큰 이관·복호화·봇 탐지 우회 코드는 어느 마일스톤에서도 작성하지 않는다

## 모의 포털 ↔ 시나리오 ↔ 마일스톤

| 모의 포털 | 재현하는 기술 패턴 | 시나리오 | 만들어지는 GOAL |
|---|---|---|---|
| portal-a 그룹웨어형 | 서버 렌더링 테이블·리로드 페이지네이션·세션 만료 | A | M2 |
| portal-b ITSM형 SPA | 필터 폼·XHR JSON·무한 스크롤 | B | M2 |
| portal-c 규정 포털형 | iframe 중첩·팝업·PDF·EUC-KR | C | M2 |
| portal-d 인사 포털형 | PII 노출·정책 ask | D | M3 |
| portal-f 전자결재형 | POST 폼·contenteditable·쓰기 버튼 | F | M3 |
| portal-e 위키형 | 지연 로딩 트리 400p·깨진 링크 | E | M4a |
| portal-g 메신저형 | 가상 스크롤·스레드·세션 공유 | G | M4b |
| idp-form / idp-oauth | 폼 로그인·임베디드 거부 OAuth | — | M4c |
| portal-h 정산·회계 | JSON 그리드·xlsx 다운로드·20일치 불일치 | H | M5 |

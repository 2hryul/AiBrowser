# GOAL.md — Helm(가칭) M3 제어 (승인 3단계 · 거부 · 되돌리기 · 감사 로그)

이 파일은 Claude Code가 이번 세션의 **목표**로 읽는 단일 명세다. `CLAUDE.md`, 시나리오 문서(D·F)와 함께 읽는다.

---

## PRECONDITIONS

- `artifacts/m2/REPORT.md` 전부 PASS
- 모의 포털에 D(인사 포털형: 조직도 트리 + 구성원 목록에 이름·사번 7자리·전화·이메일 노출)와 F(전자결재형: POST 검색 폼, 리치 에디터 iframe contenteditable, "상신" 버튼, 청구 포털 탭)를 이 세션에서 추가한다

## OBJECTIVE

AI가 하는 모든 일이 사용자의 통제 아래 있게 만든다. 중요한 행위는 승인(한 번 / 이 스레드 / 이 도메인)을 받고, 설정에서 미리 거부할 수 있고, 되돌릴 수 있는 것은 되돌리며, 전부 기록되어 재생된다.

## IN SCOPE

**Policy** (`src/main/control/Policy.ts`, `config/policy.json`)
- 사이트 정책 `sites: {host: allow|ask|deny, default: ask}`, `deny.hosts`, `deny.tools`
- 쓰기 키워드(결제·송금·이체·제출·전송·삭제·승인·확정·구매·주문·결재·등록 + 영문) 요소 클릭·폼 제출·download·upload·javascript·미승인 도메인 첫 접근 → 승인 대상
- grants 기록 `{tool|action, host, scope: once|thread|domain, threadId?, grantedAt}`, 관리자 잠금 `locked: true`
- 모든 도구 호출 앞의 Policy 훅: 거부 → 승인 필요 여부 → 마스킹

**Approval** (`control/Approval.ts`, `renderer/control/ApprovalDialog`, `SiteAccessPrompt`)
- 다이얼로그 3선택지(이번 한 번 / 이 스레드 동안 / 이 도메인에서 항상), irreversible 도구엔 "이 작업은 되돌릴 수 없습니다" 고정 문구
- request_access → SiteAccessPrompt(once/site) → policy 저장(M2에서 UI만 있던 것을 완성)
- 설정 화면: grants 조회·회수, 거부 목록 편집, 잠금 상태 표시

**UndoManager** (`persistence/UndoManager.ts`, `renderer/sidebar/UndoPanel`)
- 도구 계약에 `irreversible`, `inverse` 추가. inverse 없는 도구는 irreversible=true 강제(lint 규칙)
- inverse 구현: navigate(이전 URL), type/form_input(입력 전 값 복원, 제출 전 한정), tabs_create/close(닫기/복구), download(파일 삭제+기록 제거, 확인 1회)
- 제출 후 entry `sealed` 표시
- 스레드별 스택(스레드 개념은 M4 — 이번엔 "실행 단위 runId"로 대체, M4에서 threadId로 승격)

**AuditLog / StepLogPlayer** (`audit/AuditLog.ts`, `renderer/sidebar/StepLogPlayer`)
- 모든 도구 호출 JSONL `{ts, source, tabId, url, tool, args(마스킹), targetText, result, durationMs, screenshotPath?, policyDecision}`
- 조작 도구는 호출 직후 스크린샷 저장
- 재생 UI: 타임라인, 단계 스크린샷, "그 URL 새 탭으로 열기"

**PII 마스킹 규칙 확장** — 도구 결과·저장·스크린샷 3중 적용. 필드 패턴(사번 `\d{7}`, 전화, 이메일) 자동 감지 시 마스킹 + REVIEW 플래그

## OUT OF SCOPE

LLM·에이전트, 스레드·세션·체크포인트·받은편지함·메모·북마크 메타·변경 이력(M4), LoginBroker, 검증 계층, 실제 포털.

## FIXED DECISIONS

- 자동 승인 플래그는 만들지 않는다. 헤드리스/MCP 실행 중 승인 필요 → run 상태 `waiting_approval`, 승인 큐에 적재(받은편지함 UI는 M4, 이번엔 사이드바 임시 목록)
- `javascript` 도구 정책 기본값 `ask`
- policy.json은 zod 스키마로 로드 검증, 잘못되면 기동 실패(조용히 무시 금지)

## CONSTRAINTS

CLAUDE.md 보안 기본값. 승인 우회 경로 없음. 정책 파일은 사용자 데이터 폴더, 관리자 잠금 시 렌더러에서 편집 불가.

## SUCCESS CRITERIA (전부 통과)

1. `typecheck && lint && build && smoke && test:tools && test:mcp`(M2 회귀) 통과
2. `npm run test:policy` — 단위 테스트: 쓰기 키워드 40건 판정표, 도메인 allow/ask/deny 분기, grants scope 3종 만료·회수, locked 시 grant 추가 거부, zod 로드 실패 케이스
3. **시나리오 D**(MCP 스크립트): `navigate(hr)` → 정책 ask → request_access(once) → 승인 → 팀 5개 순회 → 산출 표. 검증: 산출물·JSONL 로그·모든 스크린샷에서 `\d{7}`, 전화, 이메일 패턴 검색 결과 **0**; 승인 로그 1건 존재; 승인 거부 케이스에서 즉시 종료·수집 0
4. **시나리오 F**(MCP 스크립트): POST 폼 검색 → 이전 문서 값 추출 → 청구 포털 탭 금액 추출 → 결재 작성 필드 form_input → contenteditable type → "상신" click 시도 → Policy 차단 + ApprovalDialog 표시 → 스크립트가 거부 → 로그에 `blocked_by_policy`, 문서 상태 미변경. 3회 반복에서 자동 상신 **0회**
5. 되돌리기 테스트: type 3회 → undo 2회 → 필드 값이 1회차 상태; 제출 후 undo 시도 → `sealed` 거부; tabs_close → undo → 탭 복구; download → undo → 파일 없음·기록 없음
6. lint 규칙 테스트: `inverse` 없이 `irreversible:false`인 도구 파일을 추가하면 lint 실패
7. StepLogPlayer: 시나리오 F 로그를 로드해 단계 수·스크린샷 존재·"새 탭으로 열기" 동작(smoke)
8. `artifacts/m3/REPORT.md`

## AUTONOMY LOOP

Policy → Approval → Undo → AuditLog/Player 순, 각 단계 테스트 통과 후 다음. `[M3]` 커밋. 전부 PASS면 REPORT.md.

## STOP CONDITIONS

- PRECONDITIONS 미충족 / 같은 근본 원인 5회 실패 / OUT OF SCOPE 결정 필요
- 시나리오 D에서 PII 패턴이 1건이라도 남으면 통과 처리 금지 — 원인 제거까지 반복, 5회 초과 시 STOP

## DONE

`artifacts/m3/REPORT.md` 전부 PASS. 사람이 모의 인사 포털을 AI에게 시키면 승인 프롬프트가 뜨고 결과에 개인정보가 없으며, 결재 초안은 채워지지만 상신은 AI가 못 누르고, 잘못 입력된 필드는 되돌리기로 복구된다.

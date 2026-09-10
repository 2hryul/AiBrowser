# M3 제어 검증 리포트 — 승인 3단계 · 거부 · 되돌리기 · 감사 로그

- 대상: `goals/GOAL-M3.md`
- 환경: Windows 11 (26200), Electron 44.3.0 (Node 24.20 / Chromium 142), Node 24.x
- 실행 일자: 2026-09-10
- 결과: **SUCCESS CRITERIA 8건 전부 PASS**

---

## 실행 방법

```powershell
npm install
npm run fixtures
npm run typecheck
npm run lint
npm run build
npm run test:unit        # 정책·마스킹·lint 규칙·옴니박스·읽기모드·프로필 (134건)
npm run test:policy      # 정책 단위 테스트만 (79건)
npm run smoke            # M0·M1 회귀 (13건)
npm run test:tools       # 도구 단위 (10건)
npm run test:mcp         # M2 시나리오 A·B·C 회귀 (6건)
npm run test:scenarios   # M3 시나리오 D·F + StepLogPlayer + 정책·되돌리기 화면 (6건)
npm run test:undo        # 되돌리기 (4건)
```

정책 화면은 `Ctrl+,`, 되돌리기 목록은 `Ctrl+Shift+U`, 단계 로그 재생은 `Ctrl+Shift+G`
(툴바 🔐 / ↩ / 🎞️ 버튼도 같은 패널을 연다).

---

## SUCCESS CRITERIA 판정

### 1. `typecheck && lint && build && smoke && test:tools && test:mcp` — PASS

| 항목 | 결과 |
|---|---|
| `typecheck` | 통과 (tsconfig.node + tsconfig.web) |
| `lint` | 통과 (`--max-warnings=0`, 커스텀 규칙 2종 포함) |
| `build` | 통과 (main 232KB · preload 11.6KB · renderer 315KB) |
| `smoke` | 13/13 통과 |
| `test:tools` | 10/10 통과 |
| `test:mcp` | 6/6 통과 (시나리오 A 200건 · B 필터 · C EUC-KR · Handoff · Overlay) |

M2 회귀 중 **의도적으로 바꾼 계약 1건**: `request_access` 는 이제 `ask_user` 프롬프트가 아니라
승인 큐(3단계)를 지난다. GOAL-M3 IN SCOPE("M2 에서 UI 만 있던 것을 완성")에 따른 변경이므로
해당 테스트를 새 계약으로 갱신했다(`scripts/tool-tests.ts` — 승인 큐로 답하고 grants 기록을 확인).

### 2. `npm run test:policy` — PASS (79건)

- 쓰기 키워드 **40행 판정표** (참 20 / 거짓 20): `상신`·`결재요청`·`제출하기`·`Submit` 등은 참,
  `상세보기`·`목록`·`검색`·`Download list` 등은 거짓
- 행위 분류 7종(`write_click`/`form_submit`/`download`/`upload`/`javascript`/`site_first_visit`/`tool`)
- 사이트 allow / ask / deny 분기, `deny.hosts` 가 `sites.hosts` 를 이김
- grants 범위 3종: `once` 는 1회 사용 후 소멸, `thread` 는 같은 runId 에서만, `domain` 은 재로드 후 유지
- 회수(`revokeGrant`), 관리자 잠금(`locked: true` → thread/domain 추가 거부, once 는 메모리라 허용)
- zod 로드 실패 4종: 잘못된 enum, 잘못된 scope, 깨진 JSON, boolean 아닌 locked → `PolicyLoadError`
- PII 마스킹: 7자리 사번 마스킹 / 8자리 이상 비마스킹 / 전화 / 이메일 / 혼합 / `maskDeep` 재귀 / `kinds` 필터

### 3. 시나리오 D — PASS

`npm run test:scenarios` 의 2건(`[시나리오 D-거부]`, `[시나리오 D]`).

| 판정 항목 | 실측 |
|---|---|
| 순회한 팀 | 5 / 5 (팀당 구성원 4명) |
| 승인 기록 | **1건** (`request_access`, scope `once`) |
| 산출물 PII (`\d{7}`·전화·이메일) | **0건** (`scenario-d-table.json`) |
| JSONL 로그 PII | **0건** (`<userData>/audit/<runId>.jsonl` 전문 검색) |
| 스크린샷 PII | **0건** — 팀별 12개 영역 마스킹, 덮인 비율 **1.00** (최소값) |
| 원본 미끼 PII | 60건 (구성원 20명 × 3종) — 검증이 헛돌지 않았다는 근거 |
| REVIEW 플래그 | 5건 (팀 페이지를 읽은 호출마다) |
| 거부 케이스 | `blocked_by_policy: true, by: 'user'`, 탭 생성 0, 수집 **0** |

스크린샷 판정은 픽셀로 한다: 페이지에서 `.member-no`/`.member-phone`/`.member-email` 의
**텍스트 사각형**을 Range 로 측정하고, 그 영역이 마스킹 색(40,40,40)으로 덮인 비율을 센다.
5개 팀 모두 최소 비율 1.00(= 완전히 덮임).

산출물 예:

```
"김민준\t주임\t10*****\t010-****-1000\tus****@example.co.kr"
```

- 화면: `scenario-d-0.png` … `scenario-d-4.png`
- 산출 표: `scenario-d-table.json`

### 4. 시나리오 F — PASS

| 판정 항목 | 실측 |
|---|---|
| POST 폼 검색 | GET 은 `0건`, 폼 제출 후 `3건` |
| 이전 문서 금액 추출 | `1,540,000` (AP-2026-0001) |
| 청구 포털 탭 금액 추출 | `1,541,000` |
| 결재 초안 입력 | 제목·공급사·금액 `form_input` 적용됨 |
| iframe contenteditable 본문 | `read_page` 평탄화 프레임 2개, `computer type` 성공 |
| "상신" 클릭 3회 | 3회 모두 `blocked_by_policy`, `by: 'user'` |
| ApprovalDialog 표시 | `data-approval-action="write_click"`, 대상 문구 `상신`, 범위 3종 + 거부 버튼 |
| **자동 상신** | **0회** (`portalTestHooks.submittedDocs()` 가 빈 배열) |
| 문서 상태 | `임시저장` 유지, "상신되었습니다" 없음 |
| 로그 | JSONL 에 `blocked_by_policy` 문자열 존재, 차단 기록 4건 |

거부는 **실제 UI 경로**로 한다 — 셸의 `[data-approval-deny]` 버튼을 눌러 IPC 로 답한다.

- 화면: `scenario-f-approval.png`(승인 다이얼로그), `scenario-f-draft.png`(작성된 초안)

### 5. 되돌리기 — PASS (`npm run test:undo`, 4건)

| 케이스 | 실측 |
|---|---|
| type 3회 → undo 2회 | `1월` → `1월정산` → `1월정산재요청` → undo → `1월정산` → undo → **`1월`** |
| `tabs_close` → undo | 탭 복구, 주소 `app://portal-a/list?page=1`, 소유권 `ai` 로 복원 |
| `download` → undo | `rule-1.pdf` 파일 삭제 확인, 다운로드 기록 제거 확인 |
| 상신 후 undo | 봉인 2건, 사유 `상신 실행 후에는 되돌릴 수 없습니다`, 사람·AI 경로 모두 `reason: 'sealed'` |

AI 경로(`undo` 도구)는 `irreversible: true` 라서 매번 승인을 받는다 — 테스트가 그 승인 요구를
확인한 뒤 허용한다. 봉인 표시와 사유가 화면에 나오는지는 `undo-panel.png` 와
`[data-undo-sealed]` 검사로 확인했다(되돌리기 버튼 비활성 + 사유 문구).

### 6. lint 규칙 — PASS (`tests/require-tool-inverse.test.ts`, 3건)

- RuleTester: 정상 5건 / 위반 4건(`missingInverse` 3, `inverseOnIrreversible` 1)
- **실제 배선**: `src/main/tools/__inverse_probe__.ts` 에 `irreversible: false` + `inverse` 없는 도구를
  만들면 프로젝트 설정(`eslint.config.mjs`)으로 돌린 lint 가 severity 2 오류를 낸다 →
  `--max-warnings=0` 에서 빌드가 막힌다. 파일을 지우면 다시 통과한다(같은 테스트에서 확인).

### 7. StepLogPlayer — PASS

| 판정 항목 | 실측 |
|---|---|
| 단계 수 | 61 (그 시점 로그 줄 수와 타임라인 `data-audit-count` 가 일치) |
| 스크린샷 있는 단계 | 12 — 경로가 적힌 파일 전부 실제로 존재 |
| 단계 상세 | `file://` 스크린샷 표시, 판정(허용/승인/거부)·범위·소요시간·마스킹된 인자/결과 |
| "그 URL 새 탭으로 열기" | 새 탭 1개 생성, 주소 `app://portal-d/`, 소유권 `human` |

- 화면: `step-log-player.png`

### 8. 이 리포트 — PASS

---

## 추가로 검증한 것 (IN SCOPE 항목)

**설정 화면** (`[정책 화면]` 테스트, `policy-panel.png`)

- grants 조회: 시나리오 F 가 남긴 `site:portal-f`·`site:portal-billing` (`thread` 범위) 2건 표시
- 회수: 목록에서 누르면 `policy.json` 에서도 사라진다(2건 → 1건)
- 거부 목록 편집: 렌더러에서 저장한 `evil.example.com`·`portal-z` 가 정책에 반영되고,
  그 도메인으로 `navigate` 하면 `blocked_by_policy`(`by: 'policy'`) — 승인 여부와 무관하게 막힌다
- 잠금 상태 표시: `data-policy-locked` (`편집 가능` / `관리자 잠금` 배지)

**되돌리기 화면** (`[되돌리기 화면]` 테스트, `undo-panel.png`)

- MCP 클라이언트가 만든 항목 15건이 사람 목록에 보인다(사람 UI 와 AI 도구가 같은 스택)
- 봉인 항목은 사유와 함께 표시되고 되돌리기 버튼이 비활성

---

## 이번 세션에 찾은 실제 결함 (전부 수정)

시나리오 D·F 를 돌려서 드러난 것들이다. 코드를 읽어서는 하나도 못 찾았다.

1. **"상신" 클릭이 승인 없이 통과했다.** `describeTarget` 이 ref 의 접근성 이름을 얻는 경로를
   지연 `require('../cdp/PageReader')` 로 썼는데, 번들된 main 에는 그 상대 경로가 없어
   `catch` 로 떨어져 **항상 빈 문자열**을 돌려줬다. 대상 문구가 없으면 쓰기 키워드 판정이
   불가능하므로 `write_click` 이 `tool` 로 분류되어 그대로 실행됐다. → 정적 import 로 교체.
   (M3 의 존재 이유 자체를 무력화하는 결함이었다. `blocked_by_policy` 를 감사 로그에
   결과로 남기게 바꾼 것도 이 사건 때문이다 — 로그만 보고 차단을 확인할 수 있어야 한다.)
2. **입력 내용이 승인 판정에 섞였다.** `computer` 의 `type` 은 `args.text` 가 입력할 내용인데
   쓰기 키워드 판정 근거로 쓰였다. 본문에 "청구액" 을 적었다는 이유로 승인 대기에 걸려
   MCP 호출이 60초 타임아웃으로 죽었다. → `type` 은 대상 문구 판정에서 제외.
3. **AI 자신의 클릭이 사람 개입으로 오인됐다.** Handoff 의 자기 입력 억제가 120ms 플래그라서,
   클릭이 페이지 이동을 일으키면 mousedown 보고가 새 문서 로드 뒤에 도착해 플래그가 이미
   내려가 있었다. → 이벤트 **발생 시각**을 조작 구간과 비교하는 방식으로 교체.
4. **닫은 탭을 되돌리면 소유권이 사람으로 바뀌었다.** AI 가 닫은 탭을 되돌린 뒤 AI 가 다시
   다룰 수 없었다. → 스냅샷에 `owner` 를 담아 복원.
5. **도구가 스스로 받은 승인이 감사 로그에 남지 않았다.** `request_access` 는 자기 `run` 안에서
   승인을 받으므로 `callTool` 의 ask 경로를 지나지 않아 `grantScope` 가 비었다. →
   `Approval` 이 실행 단위별 허용 기록을 남기고 `callTool` 이 run 전후를 비교해 채운다.
6. **셸의 UndoPanel 이 앱 실행 단위 스택만 봤다.** MCP 연결이 만든 항목은 사람이 볼 수 없었다.
   → 처음 열 때 가장 최근에 움직인 스택을 보여준다(변경 알림은 이미 그렇게 동작하고 있었다).

---

## 문서화한 편차·한계

1. **읽기 도구는 `inverse` 를 요구하지 않는다.** lint 규칙 `require-tool-inverse` 는
   `sideEffect: 'read'` 를 건너뛴다. 읽기는 되돌릴 대상이 없고, `irreversible: true` 로 두면
   페이지를 읽을 때마다 승인을 요구해 규칙의 의도와 어긋난다. → ADR 0002.
2. **`computer` 의 screenshot/zoom/hover 는 판정 시 읽기로 취급한다.** 한 도구가 조작과 관찰을
   함께 담고 있어서다(`effectiveSideEffect`). 화면 한 번 보는 데 승인을 요구하지 않는다.
3. **사이트 접근 승인은 범위와 무관하게 그 실행 동안 유지된다**(`markVisited`).
   `once` 를 골라도 같은 호스트의 다음 페이지에서 다시 묻지 않는다. 쓰기 행위는 이 완화와
   무관하게 매번 판정한다. 근거와 대안 검토는 ADR 0002.
4. **금액과 사번을 숫자 모양으로 구분할 수 없다.** 사번 패턴("독립된 7자리")이 `1200000` 같은
   금액을 잡는다. 모의 포털 F/청구 포털은 실제 결재 화면처럼 천 단위 쉼표를 넣어 이 오탐을
   피했다(`won()`). 실제 포털에서는 호출부가 `kinds` 로 범위를 좁히거나 필드 라벨을 함께 보는
   규칙이 필요하다 — M4 이후 과제.
5. **감사 로그 스크린샷은 조작 도구(input/write)만 남긴다.** 읽기까지 남기면 용량이 폭증한다.
   그래서 61단계 중 12단계에 화면이 있다.
6. **`thread` 범위는 실행 단위(runId)** 다. 진짜 스레드는 M4 에서 도입하며 그때 승격한다.
7. **StepLogPlayer 는 현재 실행의 로그만 읽는다.** 과거 실행 로그 열기는 M4(받은편지함·스레드)와
   함께 붙이는 것이 자연스러워 이번에는 넣지 않았다.

---

## 보안 기본값 재확인

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` 유지. 웹 콘텐츠
  WebContentsView 에 preload 없음(내부 화면은 셸 패널 — ADR 0005)
- IPC 는 `channels.ts` 화이트리스트만. M3 채널 13개 추가(승인·정책·되돌리기·감사)
- **자동 승인 플래그 없음**, 승인 우회 경로 없음. 앱 종료 시 대기 중 승인은
  `Approval.rejectAll()` 로 **거부** 처리한다(조용히 통과시키지 않는다)
- 정책 파일은 사용자 데이터 폴더(`<userData>/policy.json`). 관리자 잠금이면 렌더러에서
  grants 추가·회수·거부 목록 편집이 모두 거부되고 UI 도 비활성으로 표시된다
- 정책 파일 형식 오류는 zod 로 잡아 `dialog.showErrorBox` + `app.exit(1)` — 기본값으로 조용히
  넘어가지 않는다
- 자격증명·쿠키·토큰을 읽는 코드 없음(`no-credential-files` 규칙이 계속 감시).
  브라우저 세션 이관 코드 없음(불변 조건 9)
- 감사 로그·메모에 개인정보를 쓰지 않는다 — 마스킹은 도구 결과·저장·스크린샷 3중 적용

## 산출물

| 파일 | 내용 |
|---|---|
| `scenario-summary.json` | 시나리오 D·F·StepLogPlayer·정책 화면·되돌리기 화면 실측값 |
| `undo-summary.json` | 되돌리기 4케이스 실측값 |
| `scenario-d-table.json` | 시나리오 D 산출 표 (마스킹 적용) |
| `scenario-d-0..4.png` | 팀별 구성원 화면 (개인정보 영역 마스킹) |
| `scenario-f-approval.png` | "상신" 클릭 시 승인 다이얼로그 |
| `scenario-f-draft.png` | 채워진 결재 초안 |
| `step-log-player.png` | 단계 로그 재생 화면 |
| `policy-panel.png` | 정책 화면 (grants·거부 목록·잠금 상태) |
| `undo-panel.png` | 되돌리기 목록 (봉인 사유 표시) |

# ToolSurface 호환표 (M4b)

Helm 의 도구 이름·인자는 Claude Browser 와 호환한다. 같은 이름이면 같은 뜻으로 쓸 수 있어야
외부 MCP 클라이언트(Claude Code)가 배운 대로 동작한다. 이 문서는 **같은 것**과 **다른 것**을 적는다.

구현: `src/main/tools/` (도구), `src/main/cdp/` (페이지 제어), `src/main/mcp/Server.ts` (노출).
등록 목록의 단일 출처는 `src/main/tools/register.ts` 다.

## 노출 도구 33종

| 도구 | sideEffect | 되돌리기 | 요약 |
|---|---|---|---|
| `tabs_context` | read | — | 열린 탭 목록. 제목과 함께 `origin` 을 준다 |
| `tabs_create` | navigate | 탭 닫기 | 새 탭. 기본은 **배경 탭** |
| `tabs_select` | navigate | 이전 탭 복귀 | AI 소유 탭만 앞으로 |
| `tabs_close` | navigate | 닫은 탭 복구 | AI 소유·비고정 탭만 |
| `preview_start` | navigate | — | 작업 시작점 열기 |
| `navigate` | navigate | 뒤로 | 이동 + 로딩 대기. `redirected`·`finalUrl` 보고 |
| `navigate_history` | navigate | — | 뒤로/앞으로 |
| `get_page_text` | read | — | 본문 텍스트(iframe 포함) 또는 읽기 모드 추출 |
| `read_page` | read | — | 접근성 트리 + `ref`, iframe 평탄화 |
| `find` | read | — | 규칙 매칭으로 요소 찾기 |
| `computer` | input | — | 클릭·입력·키·스크롤·드래그·스크린샷 |
| `form_input` | input | 이전 값 복원 | 폼 요소 값 설정 |
| `javascript` | exec | **없음(irreversible)** | 격리 월드에서 표현식 평가 |
| `read_network_requests` | read | — | XHR/fetch 응답 본문 |
| `read_console_messages` | read | — | 페이지 콘솔 로그 |
| `download` | write | 파일 삭제 | 파일 받기 |
| `upload` | input | — | 파일 선택 입력 설정 |
| `ask_user` | read | — | 사람에게 묻기 |
| `request_access` | read | — | 도메인 접근 허락 요청(승인 3단계) |
| `undo_list` | read | — | 되돌릴 수 있는 항목 나열(`sealed` 표시 포함) |
| `undo` | write | **없음(irreversible)** | 최근 작업 되돌리기. 재실행은 없다 |
| `session_list` | read | — | 이름 붙인 세션 목록과 현재 세션 |
| `session_use` | persist | 이전 세션 복귀 | 다음에 만들 탭의 세션을 정한다 |
| `checkpoint_save` | persist | 체크포인트 삭제 | 진행 상태를 복구 지점으로 남긴다 |
| `checkpoint_list` | read | — | 이 작업의 복구 지점 목록 |
| `checkpoint_restore` | navigate | 복원 전 지점으로 되돌림 | 저장된 탭·결과·커서를 되살린다 |
| `note_read` | read | — | thread/site 메모 읽기 |
| `note_append` | persist | 이전 버전 복원 | 메모 덧붙이기(자격증명·PII 거부) |
| `bookmark_list` | read | — | 북마크 + AI 메타(의도·기대콘텐츠·핵심필드·요령) |
| `bookmark_get` | read | — | 북마크 하나를 메타와 함께 |
| `page_history` | read | — | 그 주소의 본문 스냅샷 이력 |
| `page_diff` | read | — | 두 스냅샷의 낱말 단위 차이 |
| `inbox_post` | persist | 항목 삭제 | 결과·완료·실패를 받은편지함에 남긴다 |

`irreversible: true` 는 `javascript` 와 `undo` 둘이다. Policy 가 이 표시를 보고 승인을 강제한다.
나머지 **상태를 바꾸는** 도구는 역연산이 정의되어 있고 UndoManager 가 그 역연산을 스택에 쌓는다.
읽기 도구(`sideEffect: 'read'`)는 되돌릴 대상이 없어 `inverse` 를 요구하지 않는다 —
lint 규칙 `require-tool-inverse` 도 같은 경계를 쓴다(근거는 `docs/adr/0002-승인과-되돌리기-경계.md`).

`navigate_history`·`preview_start`·`upload`·`computer(type)` 의 역연산은 M3 에서 구현했다.
`computer` 는 `type` 만 되돌릴 수 있다(입력 전 값 복원). 클릭·스크롤·키는 되돌릴 대상이 없다.

## Claude Browser 와 같은 것

- **이름**: `tabs_context` / `tabs_create` / `tabs_select` / `tabs_close` / `preview_start` /
  `navigate` / `get_page_text` / `read_page` / `find` / `computer` / `form_input` /
  `read_network_requests` / `read_console_messages` / `javascript` / `upload`
- **대상 지정 방식**: `read_page`·`find` 가 `ref_N` 을 주고, `computer`·`form_input` 이 그 `ref`
  또는 `coordinate` 로 대상을 지정한다.
- **`computer` 액션**: `screenshot` / `left_click` / `right_click` / `double_click` / `type` /
  `key` / `scroll` / `drag` / `hover` / `zoom`
- **`tabId` 생략 시 활성 탭.**
- **`read_page` 는 상한이 있고 넘으면 `truncated: true`** 로 알린다(기본 200노드).

## 다른 것 (차이와 이유)

### 1. `navigate` 는 `back`/`forward` 를 받지 않는다 → `navigate_history`

Claude Browser 는 `navigate({url: 'back'})` 처럼 문자열로 뒤로 가기를 받는다.
Helm 은 별도 도구로 분리했다. `back` 이라는 호스트가 실제로 존재할 수 있고(사내망에 흔하다),
주소와 명령이 같은 자리에 섞이면 조용히 잘못된 곳으로 가기 때문이다.

### 2. `preview_start` 는 개발 서버를 띄우지 않는다

Claude Browser 의 `preview_start` 는 `.claude/launch.json` 의 dev 서버를 기동한다.
Helm 은 사내 포털을 다루는 브라우저이므로 `url` 만 받아 작업 시작점을 연다.

### 3. `get_page_text` 에 `mode` 가 있다

`mode: 'text'`(기본)는 iframe 을 포함한 화면 텍스트, `mode: 'article'` 은 M1 읽기 모드와
**같은 추출기**(`@mozilla/readability`)로 본문만 뽑는다. 추출기를 공유하는 것이 GOAL 의
"Reader 공용" 요구다. 광고·내비가 많은 규정 포털에서 `article` 이 토큰을 크게 줄인다.

### 4. `tabs_create` 는 기본이 배경 탭이다

`foreground: true` 를 명시해야 사람이 보는 탭이 바뀐다. 불변 조건 3(사람이 우선권을 가진다)에
따라 AI 가 화면을 빼앗지 않는다.

### 5. `tabs_select` / `tabs_close` 는 AI 소유 탭만 다룬다

사람 소유 탭에 대해서는 `not_ai_tab` 오류를 돌려준다. 소유권의 근거는 `TabManager.owner` 다 —
`window.open` 으로 열린 팝업도 부모 탭의 소유자를 물려받아 AI 탭이 된다.

### 6. 읽기 도구는 비밀번호를 `***` 로 가린다

`read_page`·`get_page_text` 는 `input[type=password]` 값을 `***` 로 바꾼다.
`computer`(screenshot·zoom)는 그 입력의 화면 영역을 **단색으로 덮는다** — 블러는 원본 정보가
남고 검증도 애매해서 쓰지 않았다. 가린 영역 수는 `maskedRegions` 로 함께 돌려준다.

Chromium 의 접근성 트리는 이미 비밀번호를 불릿(`•••`)으로 주지만, 마스킹을 그 동작에 의존하지
않는다. DOM 에서 password 입력의 `backendNodeId` 를 직접 모아 표기를 통일한다.

### 7. `find` 는 규칙이 먼저고, 모델은 빈손일 때만 (M4b 갱신)

정확 일치(100) → 접두(80) → 부분(60) → 공백·구두점 무시(40) → 입력 값 일치(점수 −20)
순으로 점수를 매기고, 어떤 규칙으로 맞았는지 `rule` 로 함께 돌려준다.

M4b 에서 **규칙이 하나도 못 맞혔을 때에 한해** 모델이 후보 중 하나를 고르는 2차가 붙었다
(`rule: 'llm'`, 점수 10). 경계가 좁은 데는 이유가 있다:

- 규칙이 맞힌 결과를 모델이 뒤집지 않는다. 1차는 설명 가능한 근거가 있고 2차는 없다.
- 모델이 목록에 없는 `ref` 를 지어내면 버린다. 없는 것을 클릭하게 둘 수는 없다.
- 후보 목록도 페이지에서 온 글자다 — `<page_content>` 로 감싸 넘긴다. 링크 이름 자리에
  지시문을 적어 두는 것은 공격자에게 공짜다.
- 모델이 설정되지 않은 환경에서는 이 경로가 아예 없다. MCP 클라이언트가 보는 `find` 의
  동작은 M2 와 같다.

### 8. `read_network_requests` 는 첫 호출부터 기록을 시작한다

응답 본문은 지나가면 사라지므로 도청을 켠 뒤의 것만 잡힌다. **조회 버튼을 누르기 전에 한 번
불러 두어야** 한다. 본문 보관 상한은 256KB이고, 넘으면 오래된 본문부터 버리고
`bodyEvicted: true` 로 표시한다(메타데이터는 남는다). `bodyLimitBytes`·`bodyBytesUsed` 를
함께 돌려주어 왜 본문이 비었는지 알 수 있게 했다.

### 9. `upload` 는 다운로드 폴더 아래로 제한된다

임의 경로를 열지 않는다. 페이지 지시에 따라 AI 가 사용자의 아무 파일이나 올리는 경로를
만들지 않기 위함이다. 그 밖의 파일은 사람이 직접 선택해야 한다.

### 10. `ref` 는 호출마다 다시 부여된다

`read_page`·`find` 를 부를 때마다 `ref_1` 부터 새로 매긴다. 조작 직전에 읽어야 하며,
알 수 없는 `ref` 로 조작하면 "read_page 를 다시 호출해 ref 를 갱신하세요" 오류가 난다.

### 11. Helm 에만 있는 것

- `request_access` — 아직 허용되지 않은 도메인 접근 전 사람의 허락. 사람이 고른 범위
  (`once` / `thread` / `domain`)가 결과의 `scope` 로 돌아오고 `policy.json.grants` 에 기록된다.
  거부하면 `{granted: false, scope: null}` 이다.
- `undo_list` / `undo` — 사람 UI(UndoPanel)와 **같은 스택**을 본다. AI 는 자기 스레드의
  항목만 되돌릴 수 있고, 제출·상신 뒤 봉인된 항목은 `reason: 'sealed'` 로 거부된다.
- `session_*` — 세션을 바꾸면 **다음에 만드는 탭**부터 그 파티션을 쓴다. 이미 열린 탭은
  그대로다(보고 있는 화면의 계정이 뒤에서 바뀌면 안 된다). 기본 세션의 파티션 이름은
  `persist:helm` 이고 이름 있는 세션만 `persist:helm:<name>` 이다.
- `checkpoint_*` — `cursor` 에 작업 고유의 진행 표시를 아무 형태로나 담을 수 있다. 자동 저장
  (10스텝마다·페이지 전환마다·ask_user 직전)은 도구 밖에서 걸리고, **마지막 커서를 실어 나른다**.
- `note_append` / `bookmark_list` 메타 — 여기 적은 것은 다음 실행의 프롬프트에 실린다.
  그래서 자격증명·개인정보 패턴은 저장 전에 거부하고, 거부를 **결과로** 알린다(오류가 아니다).
  site 메모는 호스트당 2KB 상한이며 넘으면 오래된 앞부분이 잘린다.
- `page_diff` — 차이가 너무 커서 낱말 정렬을 포기하면 `coarse: true` 로 알린다. 정확해 보이는
  거짓 diff 보다 "전문을 다시 읽어야 한다" 는 신호가 낫다.
- **`{blocked_by_policy: true, reason, tool, by}` 반환** — 정책이 막거나 사람이 거부하면 오류가
  아니라 결과로 돌려준다. 호출자가 "왜 막혔는지" 보고 다음 수를 정할 수 있어야 한다.
  이 결과는 감사 로그에도 그대로 남는다.
- `ask_user` — 로그인·캡차처럼 AI 가 대신할 수 없는 지점. 세션 만료 흐름의 핵심이다.
- **`{paused: true}` 반환** — 사람이 AI 탭을 건드리면 진행 중 도구 호출이 오류가 아니라
  `{paused, reason, tabId}` 를 돌려준다. 중단은 정상 흐름이다(불변 조건 6).

## 내장 에이전트 전용 도구 (M4b) — ToolSurface 가 아니다

내장 에이전트는 모델에게 두 개의 도구를 더 준다. 이 둘은 **브라우저를 만지지 않으므로
ToolSurface 가 아니고, MCP 로도 노출되지 않는다.** 외부 클라이언트는 볼 수 없다.

| 도구 | 하는 일 | 왜 ToolSurface 가 아닌가 |
|---|---|---|
| `agent_extract_rows` | 읽은 화면에서 뽑은 행을 결과표에 기록 | 페이지를 건드리지 않는다. 모델의 출력을 받는 창구다 |
| `agent_done` | 다 했다고 **제안** | 종료 판정은 루프가 한다 — 목표 건수를 못 채웠으면 되돌려 보낸다 |

`agent_done` 이 "제안" 인 이유는 실측에 있다. 7B 모델은 10페이지 중 9페이지에서 스스로
`done` 을 불렀다(`docs/eval.md` 2026-09-12). 끝을 모델이 선언하게 두면 그 실패가 그대로
성공으로 기록된다.

에이전트에게 주는 ToolSurface 도구는 33종 전부가 아니라 **15종**이다(`AGENT_TOOL_NAMES`).
도구 정의도 프롬프트에 실리고, 작은 모델에 33개를 한꺼번에 주면 고르는 정확도가 떨어진다.
MCP 클라이언트에는 33종 그대로 나간다.

또 하나, 에이전트는 **자기 탭에서만 일한다.** 시작할 때 `tabs_create` 로 배경 탭을 열고,
`tabId` 를 비운 호출에는 루프가 그 탭 번호를 채워 넣는다. `tabId` 를 비우면 활성 탭이 되는데
그건 보통 사람이 보고 있는 탭이다(불변 조건 3).

## 스레드 이어가기 (M4a)

MCP 연결은 기본적으로 연결마다 새 스레드(`mcp-xxxxxxxx`)를 만든다. 앱을 재시작한 뒤 **같은
작업을 이어가려면** 같은 스레드에 붙어야 하므로(체크포인트·메시지가 거기 매달려 있다),
클라이언트가 스레드를 지정할 수 있다.

```
X-Helm-Thread: my-task-1
```

형식은 `[\w.-]{1,64}` 로 제한한다 — 이 값은 DB 키이자 파일 경로 조각으로 쓰인다.
헤더가 없거나 형식에 맞지 않으면 새 스레드를 만든다.

## MCP 접속

```powershell
npm run dev
```

기동 시 콘솔에 엔드포인트가 찍힌다(기본 `http://127.0.0.1:3100/mcp`).
토큰은 실행마다 새로 만들어지며, 고정하려면 `HELM_MCP_TOKEN` 을 준다.

```powershell
claude mcp add helm --transport http http://127.0.0.1:3100/mcp --header "Authorization: Bearer <토큰>"
```

- **127.0.0.1 에만 바인딩한다.** 다른 기기에서 붙을 수 없다.
- 토큰은 `Authorization: Bearer` 헤더 또는 `?token=` 쿼리로 받는다. 없으면 401.
- `HELM_MCP_PORT` 로 포트를, `HELM_MCP_DISABLED=1` 로 서버를 끌 수 있다.
- 승인 3단계는 M3 에서 구현했다. 토큰 발급·회수 UI 는 M6(파일럿) 다.

### stdio

GOAL-M2 는 stdio 와 Streamable HTTP 둘 다를 요구하지만, **HTTP 만 구현했다.**
Helm 은 GUI 앱이라 그 프로세스의 stdio 를 MCP 전송 채널로 쓸 수 없다(콘솔 출력과 충돌하고,
클라이언트가 앱을 자식 프로세스로 띄우는 모델과 맞지 않는다). stdio 클라이언트를 붙여야 하면
stdio↔HTTP 를 중계하는 작은 브리지 스크립트가 맞는 형태이며, M2 에서는 만들지 않았다.
`artifacts/m2/REPORT.md` 에 미구현으로 기록했다.

## 도구를 바꿀 때

1. `src/main/tools/` 에서 고치고 `register.ts` 에 반영
2. 이 문서의 표와 차이점을 갱신
3. `npm run test:tools` (스키마·마스킹·규칙) 와 `npm run test:mcp` (시나리오) 재실행
4. 되돌릴 수 있는 도구를 추가하면 `inverse` 테스트 필수 — `npm run test:undo`
5. 승인 판정이 바뀌면 `npm run test:policy` 와 `npm run test:scenarios` 재실행
6. 지속성 도구를 바꾸면 `npm run test:persistence` 와 `npm run test:persistence-e2e` 재실행

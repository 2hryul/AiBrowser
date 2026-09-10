# M2 REPORT — 보이는 AI (ToolSurface + 코브라우징 + MCP)

- 작성: 2026-09-10
- 목표: `goals/GOAL-M2.md`
- 이전 단계: `artifacts/m1/REPORT.md` (6개 조건 PASS)
- 환경: Windows 11 (x64) · Node v24.11.0 · Electron 44.3.0 · MCP SDK 1.30.0

## 1. PRECONDITIONS

| 조건 | 상태 |
|---|---|
| `artifacts/m1/REPORT.md` 전부 PASS | **충족** |
| 사내 포털 접근 불가 → 모의 포털을 세션 안에서 만들어 검증 | **충족** (아래 2절) |

**시나리오 문서(`docs/AI브라우저_폐쇄망포털_스크래핑_시나리오.md`)는 저장소에 없다.**
GOAL-M2 가 포털 A·B·C 의 기술 패턴과 각 시나리오의 도구 시퀀스를 성공 조건에 직접 명세하고
있어 그것을 근거로 진행했다. PRECONDITIONS 에 걸린 항목이 아니므로 STOP 하지 않았다.

## 2. 성공 조건 판정

깨끗한 상태(`out\`, 각 프로필·다운로드 디렉터리, `artifacts\m2\`, `*.tsbuildinfo` 삭제)에서
순서대로 실행했다.

| # | 조건 | 결과 | 근거 |
|---|---|---|---|
| 1 | `typecheck && lint && build && smoke` (M0·M1 회귀) | **PASS** (전부 exit 0, smoke 13 passed) | strict TS, `eslint --max-warnings=0` |
| 2 | `npm run test:tools` | **PASS** (exit 0, 9 passed) | 아래 4절 |
| 3 | `npm run test:mcp` — 시나리오 A·B·C | **PASS** (exit 0, 6 passed) | 아래 5절 |
| 4 | Handoff — 키 입력 주입 → `{paused:true}` → 이어서 | **PASS** | 5절 |
| 5 | Overlay — 클릭 직전 하이라이트 bbox 픽셀 | **PASS** | 5절 |
| 6 | `docs/tool-compat.md` | **PASS** | 호환 도구 19종 표 + 차이점 11항목 |
| 7 | `artifacts/m2/REPORT.md` | **PASS** | 이 문서 |

참고: `npm run test:unit`(M1 단위 테스트 52건)도 회귀로 함께 통과했다.

## 3. 모의 포털 3종

`src/main/browser/PortalProtocol.ts`. `app://portal-a|b|c` 로 서비스하고, **패키징된 앱에는
등록하지 않는다**(`app.isPackaged` 확인).

| 포털 | 재현한 기술 패턴 | 규모 |
|---|---|---|
| A 그룹웨어형 | 서버 렌더링 표, 번호 페이지네이션, 세션 만료 → 로그인 리다이렉트, 만료 시뮬레이션 버튼 | 공지 200건 / 20행 × 10페이지 |
| B ITSM형 SPA | 체크박스·셀렉트 필터 → `/api/incidents?page&size&period&priority` JSON, 가상 스크롤(DOM 에 12행만), `total` 필드 | 장애 137건 |
| C 규정 포털형 | 좌 트리 iframe + 우 목록 iframe, `window.open` 팝업 상세, 첨부 PDF, EUC-KR 문서 1건 | 규정 10건 |

### 세션을 실제 쿠키로 두지 못한 이유 (측정 결과)

포털 A 의 로그인 세션을 진짜 쿠키로 만들려 했으나 Chromium 이 거부한다:

```
Failed to set cookie - Attempted to set a cookie from a scheme that does not support cookies.
EXCLUDE_NONCOOKIEABLE_SCHEME
```

같은 세션에서 `https://` URL 로는 쿠키 설정이 성공한다. 즉 `app://` 커스텀 스킴은 쿠키를 가질
수 없다. 그래서 모의 포털의 세션 상태는 fixture 내부 변수로 두었다. **검증 대상은
"만료 → 리다이렉트 → ask_user → 복구 → 재개" 흐름**이고, 실제 포털은 https 라 쿠키가 정상
동작하며 `persist:helm` 파티션의 쿠키 유지는 M0·M1 스모크가 이미 검증했다.

리다이렉트도 302 대신 페이지 안 `location.replace()` 로 일으킨다 — 커스텀 스킴에서 302 를
Chromium 이 따라가지 않는 경우가 있고, `location.replace` 는 `did-navigate` 가 뜨는 진짜 탐색이라
AI 쪽에서 리다이렉트로 감지된다(시나리오 A 가 이를 실측으로 확인한다).

### EUC-KR

`scripts/make-portal-fixtures.mjs` 가 iconv-lite 로 한 번 인코딩해 파일로 커밋하고, 런타임은
그 바이트를 `charset=EUC-KR` 로 내려보낸다(런타임에 iconv 의존 없음). 생성기가 **왕복 완전
일치**를 검사해 손실 인코딩(예: em-dash → `?`)을 막는다.

## 4. `npm run test:tools` — 9건

| 항목 | 실측 |
|---|---|
| 레지스트리·스키마 | 호환 이름 18종 존재 확인. 없는 도구 / 필수 인자 누락 / 타입 불일치 / 스키마 밖 인자 / enum 위반 / 범위 위반 6가지 거부 |
| password 마스킹 | `read_page`·`get_page_text`(text·article) 결과에 원문 없음, `***` 존재. 스크린샷은 `maskedRegions ≥ 1` 이고 마스킹 색 픽셀 300개 이상 실측 |
| iframe 평탄화 (포털 C) | `frames ≥ 3`(메인+트리+목록), 트리·목록 iframe 노드가 한 목록에 함께 나오고 `frameId` 로 경계 표시 |
| NetTap 패턴 매칭 (포털 B) | `/api/incidents` 만 반환, JSON 본문의 `total > 0`, 맞지 않는 패턴은 빈 목록 |
| NetTap 256KB 상한 | 20회 대용량 응답 후 `bodyBytesUsed ≤ 262144`, `bodiesEvicted > 0`, 폐기 항목에 `bodyEvicted: true` |
| find 규칙 5종 | exact·prefix·substring·normalized·value 각각 실제로 매칭(5종 모두 서로 다른 규칙으로 확인). 없는 문구는 빈 결과 |
| 승인 다이얼로그 | `request_access` 가 사람에게 묻고 "허용"→`granted:true`, `ask_user` 가 "아니오" 를 그대로 전달 |
| 탭 소유권 | 사람 탭에 대한 `tabs_select`·`tabs_close` 거부, `tabs_context` 가 `origin` 함께 반환 |
| upload 경로 제한 | 다운로드 폴더 밖 경로 거부 |

## 5. `npm run test:mcp` — 시나리오 A·B·C + Handoff + Overlay

실측값 원본: `artifacts/m2/mcp-summary.json`

### MCP 표면

| 항목 | 실측 |
|---|---|
| 엔드포인트 | `http://127.0.0.1:3199/mcp` (테스트 포트) |
| 노출 도구 | **19종** |
| 토큰 없는 POST | **401** |
| 스키마 전달 | `navigate` 의 `inputSchema` 에 `url` 포함 |
| irreversible 표시 | `javascript` 설명에 "되돌릴 수 없음" |

### 시나리오 A — 공지 200건, 세션 만료 후 재개

| 항목 | 실측 |
|---|---|
| 수집 행 | **200** |
| 고유 id | **200** (중복 0) |
| 방문 페이지 | **10** (서로 다른 URL) |
| 게시일 형식 | 200행 모두 `YYYY-MM-DD` (어긋난 행 0) |
| 세션 만료·복구 | **발생 후 재개 성공** |
| 첫/마지막 행 | `1 · 사내 공지 001 … · 2026-01-01` / `200 · 사내 공지 200 … · 2026-07-19` |

흐름: `preview_start` → `navigate`(로그인으로 밀림 감지) → `ask_user` → 사람 답 → `find`+
`computer` 로 로그인 → `read_page` 로 페이지네이션 확인 → 10페이지 `navigate`+`get_page_text` →
6페이지 진입 전에 **세션 만료 버튼 클릭** → `navigate` 가 `redirected: true` 와 `/login` 을 보고 →
`ask_user` → 로그인 복구 → **끊긴 6페이지에서 재개**.

스크린샷: `scenario-a.png`

### 시나리오 B — 필터 → XHR JSON 누적 (DOM 파싱 없이)

| 항목 | 실측 |
|---|---|
| 필터 | 우선순위 P1·P2, 기간 = 최근 1분기 |
| `total` | **24** |
| 누적 건수 | **24** (= total) |
| 그 시점 DOM 행 | **12** (가상 스크롤) |
| P3 혼입 | 없음 |

`form_input` 으로 체크박스 2개와 셀렉트를 설정하고 `read_page` 로 `checked` 2개를 확인한 뒤
조회 → `javascript` 로 요약 갱신 확인 → `computer` 스크롤 반복 + `read_network_requests` 로 JSON
누적. **DOM 에는 12행만 있는데 24건 전체를 확보**했다 — 이 시나리오의 요지가 그것이다.

스크린샷: `scenario-b.png`

### 시나리오 C — iframe → 팝업 → 첨부 → EUC-KR

| 항목 | 실측 |
|---|---|
| 팝업 탭 | **10** (`window.open` → 새 탭) |
| 첨부 다운로드 | **10** (모두 `completed`, 파일 존재·크기 > 0) |
| 치환문자 | **0** / 894자 (비율 0%) |
| EUC-KR 본문 표식 | `구형인코딩본문표식` 읽힘, `U+FFFD` 없음 |

흐름: `read_page` 로 평탄화된 iframe 트리에서 분류 링크 `ref` 확보 → `computer` 클릭 →
목록 iframe `get_page_text` → 행 클릭 → `tabs_context` 로 팝업 `tabId` 확보 → `download`(첨부) →
`tabs_close`. 인사규정 5건 + 보안규정 5건 = 10회 반복.

스크린샷: `scenario-c.png`

### Handoff (성공 조건 4)

| 항목 | 실측 |
|---|---|
| 일시정지 사유 | `사람이 키를 입력했습니다 (a)` |
| 진행 중 도구 호출 | `{paused: true, reason, tabId}` |
| 셸 PauseResumeBar | `data-ai-status="paused"` + 이어서/여기까지 버튼 렌더 확인 |
| "이어서" 반환 | `{resumed: true, note: 'user intervened'}` |
| 재개 후 | 도구 정상 동작(목록 텍스트 다시 읽힘) |

MCP 로 조작 중인 탭에 `sendInputEvent` 로 키를 주입해 실제 `before-input-event` 경로를 태웠다.

### Overlay (성공 조건 5)

| 항목 | 실측 |
|---|---|
| 대상 요소 사각형 | `{x: 16, y: 108.8, w: 137.76, h: 31.2}` |
| 클릭 직전 표시한 bbox | `{x: 16, y: 108.8, w: 137.76, h: 31.2}` (오차 < 3px) |
| 커서 표시 | `{x: 84.88, y: 124.4}` |
| 하이라이트 픽셀 | **3,259** / 1,139,304 (임계값 > 500) |

`computer left_click` 을 실제로 태운 뒤 **도구가 클릭 직전에 무엇을 표시했는지**(Overlay 의
마지막 상태)를 대상 요소의 `getBoundingClientRect` 와 비교하고, 같은 상태를 다시 그려
오버레이 뷰를 캡처해 붉은 계열 픽셀을 셌다. 스크린샷: `overlay-highlight.png`

## 6. 실행 방법

```powershell
npm install
npm run dev
```

기동 시 콘솔에 MCP 엔드포인트가 찍힌다(기본 `http://127.0.0.1:3100/mcp`). Claude Code 에 붙이려면:

```powershell
claude mcp add helm --transport http http://127.0.0.1:3100/mcp --header "Authorization: Bearer <토큰>"
```

토큰은 실행마다 새로 만들어진다. 고정하려면 `HELM_MCP_TOKEN` 을 주면 된다.
모의 포털은 개발 실행에서 `app://portal-a/list?page=1`, `app://portal-b/`, `app://portal-c/` 로 열 수 있다.

검증:

```powershell
npm run typecheck
npm run lint
npm run build
npm run test:unit    # 52건 (M1)
npm run smoke        # 13건 (M0·M1 회귀)
npm run test:tools   # 9건 (도구 단위)
npm run test:mcp     # 6건 (시나리오 A·B·C + Handoff + Overlay)
```

## 7. 도중에 발견해서 고친 것

전부 테스트가 잡았다.

1. **CDP `Input` 도메인에는 `enable` 이 없다.** `Input.enable` 을 호출해 모든 클릭이 실패했다
   (`'Input.enable' wasn't found`). 다른 도메인과 달리 준비 호출이 없다.
2. **AX 트리의 `checked`·`disabled`·`focused` 는 토큰 문자열(`'true'`)로도 온다.** 불리언만
   비교해 체크박스 상태를 놓쳤고, 시나리오 B 의 필터 확인이 실패했다.
3. **하이라이트가 10px 어긋났다.** `DOM.getBoxModel` 의 `content` quad(패딩 안쪽)를 썼기
   때문이다. 사람이 보는 것은 border 박스이므로 그쪽으로 바꿨다.
4. **`read_page` 의 `interactive` 필터가 상한 뒤에 적용됐다.** 200노드로 자른 다음 거르니
   표가 큰 페이지에서 페이지네이션·버튼이 통째로 사라졌다. 걸러낸 뒤 상한을 적용한다.
5. **`window.open` 팝업이 Handoff 에 귀속되지 않았다.** TabManager 는 owner='ai' 로 만들지만
   Handoff 가 그 탭을 모르니 `tabs_close` 가 자기 탭을 "사람 소유"로 거부했다. 소유권 판정을
   `TabManager.owner` 로 옮기고, 팝업을 부모 탭의 스레드에 귀속시킨다.
6. **ToolSurface 등록이 MCP 기동에 묶여 있었다.** MCP 를 끄면 도구가 사라져 내장 에이전트(M4)
   경로가 죽는다. 기동 시 항상 등록한다.
7. **비밀번호 마스킹이 Chromium 동작에 의존했다.** 접근성 트리는 이미 불릿(`•••`)을 주지만,
   그것에 기대지 않고 DOM 에서 password 입력의 `backendNodeId` 를 직접 모아 `***` 로 통일한다.
8. **포털 B fixture 의 우선순위와 기간이 완전히 상관됐다**(둘 다 `n % 3`). "P1 + 최근 1분기" 가
   공집합이어서 필터 조합 검증이 성립하지 않았다. 주기를 분리했다 — fixture 결함.
9. **테스트 결함 2건**: NetTap 폐기 검증의 폴링 조건이 항상 참이라 실제로 기다리지 않았고,
   오버레이 테스트를 자리만 잡아 둔 상태로 남겼다. 둘 다 실제 검증으로 바꿨다.

## 8. 제약 준수

| 제약 | 상태 |
|---|---|
| 페이지 제어는 `webContents.debugger`(CDP)만 | `src/main/cdp/` 에만 CDP 호출. Playwright 는 `scripts/*.ts` 테스트에서만 |
| Overlay 는 페이지 DOM 에 주입하지 않는다 | 별도 투명 `WebContentsView`(`app://overlay/`). 페이지 DOM 을 바꾸지 않는다 |
| `contextIsolation`/`nodeIntegration:false`/`sandbox:true` | 셸·탭·오버레이 모든 뷰에 적용 |
| 웹 콘텐츠 뷰에 preload 금지 | 유지. 오버레이도 preload 없이 `executeJavaScript` 로 제어 |
| IPC 화이트리스트 | `channels.ts` 채널만 preload 가 노출 |
| 외부 네트워크 없음 | 모의 포털은 `app://`. MCP 는 127.0.0.1 바인딩 |
| 봇 탐지 우회 금지 | UA 스푸핑·입력 위조 없음. CDP `Input` 으로 신뢰된 이벤트를 보내는 것이 전부 |
| 자격증명 이관 코드 없음 | `no-credential-files` lint 가 저장소 전체에 걸려 있고 통과 |
| 라이선스 | MCP SDK(MIT)·ajv(MIT)·iconv-lite(MIT) 추가. 금지 라이선스 0건 |

Handoff 가 마우스를 감지할 때 CDP 격리 월드에 리스너를 단다(`Page.addScriptToEvaluateOnNewDocument`
+ `Runtime.addBinding`). 페이지 DOM 을 바꾸지 않고 리스너만 붙이는 방식이며, 오버레이 제약
("페이지 DOM 주입 금지")과는 다른 층이다. 키보드는 Electron `before-input-event` 로 잡는다.

## 9. 이번 범위에서 하지 않은 것

GOAL-M2 OUT OF SCOPE: LLM 연결·내장 에이전트, 승인 3단계·grants 저장·거부 목록·되돌리기,
스레드·세션·체크포인트·받은편지함·메모·북마크 메타·변경 이력, LoginBroker, 검증 계층, 실제 사내 포털.

**M2 진행 중 OUT OF SCOPE 결정이 필요해진 상황은 없었다.**

미구현으로 남긴 것 하나:

- **MCP stdio 전송.** GOAL 은 stdio + Streamable HTTP 둘 다를 요구하지만 **HTTP 만 만들었다.**
  Helm 은 GUI 앱이라 그 프로세스의 stdio 를 MCP 채널로 쓸 수 없다(콘솔 출력과 충돌하고,
  클라이언트가 서버를 자식 프로세스로 띄우는 stdio 모델과도 맞지 않는다). stdio 클라이언트가
  필요하면 stdio↔HTTP 중계 브리지가 맞는 형태다. 검증에 쓰는 Claude Code 는 HTTP 전송을
  지원하므로 성공 조건 3·4·5 는 영향받지 않았다. `docs/tool-compat.md` 에도 적었다.

계약만 갖춰 두고 동작은 M3 인 것:

- `Tool.irreversible` 과 `Tool.inverse` 는 정의되어 있지만 Policy·UndoManager 가 없다.
  `javascript` 는 `irreversible: true` 로 표시되어 있고 M3 에서 승인이 강제된다.
- `request_access` 는 매번 묻고 결과를 기록하지 않는다(`scope: 'once'` 고정).

## 10. 다음 단계

`goals/README.md` 순서대로면 다음은 **M3**(승인 3단계·거부·되돌리기·감사 로그, 모의 포털 D·F).
선행 조건 없음.

M3 로 이어지는 접점:

- `callTool()` 에 Policy 훅 자리가 비어 있다(`src/main/tools/index.ts`). 순서는 CLAUDE.md 계약
  그대로 스키마 검증 → Policy → run → inverse 등록 → 감사 로그 → Overlay.
- 도구마다 `inverse` 가 이미 정의되어 있어 UndoManager 는 스택만 붙이면 된다.
- 감사 로그는 지금 콘솔에 남는다(인자 값은 길이만, 내용은 적지 않는다). M3 에서 JSONL 로 옮긴다.
- `request_access` 의 `scope` 를 `once | thread | domain` 으로 넓히고 `policy.json` 에 기록한다.

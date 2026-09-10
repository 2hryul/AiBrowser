# GOAL.md — Helm(가칭) M2 보이는 AI (ToolSurface + 코브라우징 + MCP)

이 파일은 Claude Code가 이번 세션의 **목표**로 읽는 단일 명세다. `CLAUDE.md`(규칙), `docs/AI브라우저_폐쇄망포털_스크래핑_시나리오.md`(시나리오 A·B·C)와 함께 읽는다.

---

## PRECONDITIONS

- `artifacts/m1/REPORT.md` 전부 PASS
- 이 세션은 사내 포털에 접근할 수 없다. 따라서 **모의 포털(fixtures)** 을 이 세션 안에서 직접 만들어 검증한다(IN SCOPE 참조). 실제 포털 검증은 사람이 M2 이후 별도 수행

## OBJECTIVE

AI가 사람처럼 브라우저를 다룰 수 있는 도구 표면(ToolSurface)을 Claude Browser 호환 이름으로 구현하고, 그 동작이 화면에 보이며(오버레이), 사람이 개입하면 멈추고(Handoff), 외부 MCP 클라이언트(Claude Code)가 같은 도구로 브라우저를 조작할 수 있게 한다. 이번 세션에 LLM은 연결하지 않는다 — 도구 표면은 MCP를 통해 Claude Code가 직접 호출해 검증한다.

## IN SCOPE

**모의 포털 3종** (`fixtures/portals/`, Electron 내장 정적 서버 `app://portal-a|b|c`)
- A 그룹웨어형: 서버 렌더링 테이블 20행×10페이지, 번호 클릭 페이지네이션, 상세는 같은 탭, 로그인 세션 쿠키 없으면 로그인 페이지로 리다이렉트(세션 만료 시뮬레이션 버튼 포함)
- B ITSM형 SPA: 필터 패널(체크박스·셀렉트) → `/api/incidents?page=N&size=50` JSON, 무한 스크롤(가상 스크롤), total 필드
- C 규정 포털형: 좌 트리 iframe + 우 목록 iframe, 상세는 `window.open` 팝업, 첨부 PDF 링크, **EUC-KR** 인코딩 페이지 1개

**ToolSurface** (`src/main/tools/`, 도구 1개 = 파일 1개, CLAUDE.md 계약 준수)
- tabs_context / tabs_create / tabs_select / tabs_close / preview_start
- navigate, get_page_text(Reader 공용), read_page(AX tree + ref, iframe 평탄화, 상한 200), find(1차 규칙만 — LLM 2차는 M4)
- computer(screenshot / left_click / right_click / double_click / type / key / scroll / drag / zoom), form_input
- read_network_requests(NetTap 링버퍼, 256KB 상한), read_console_messages, javascript
- download, upload, ask_user, request_access(이번엔 UI 다이얼로그까지, 정책 저장은 M3)
- 모든 읽기 도구에서 `input[type=password]` 값 `***` 마스킹, 스크린샷은 해당 영역 블러

**코브라우징** (`src/main/cobrowse/`)
- Overlay: AI 소유 탭 배지, 대상 bbox 하이라이트, 커서 애니메이션(별도 투명 View, 페이지 DOM 주입 금지)
- Handoff: AI 소유 탭에서 `before-input-event`/마우스다운 감지 → `paused` → PauseResumeBar("이어서"/"여기까지")

**MCP 서버** (`src/main/mcp/Server.ts`) — stdio + Streamable HTTP, ToolSurface 전부 노출, 클라이언트 토큰(고정 개발 토큰 1개, 회수 UI는 M3)

## OUT OF SCOPE

LLM 연결·내장 에이전트, 승인 3단계·grants 저장·거부 목록·되돌리기, 스레드·세션·체크포인트·받은편지함·메모·북마크 메타·변경 이력, LoginBroker, 검증 계층, 실제 사내 포털.

## FIXED DECISIONS

- 도구 이름·인자는 Claude Browser와 호환. 차이는 `docs/tool-compat.md`에 기록
- 페이지 제어는 `webContents.debugger`(CDP)만. Playwright는 `scripts/smoke.ts`와 `test:mcp`에서만
- read_page의 ref는 호출마다 재부여, backendNodeId 매핑은 탭 단위 보관
- click은 `DOM.getBoxModel` 중심 좌표 → `Input.dispatchMouseEvent`, type은 `DOM.focus` → `Input.insertText`
- MCP 검증은 `scripts/mcp-scenarios.ts`가 MCP 클라이언트로 붙어 시나리오 A·B·C의 도구 시퀀스를 **스크립트로** 재생(LLM 없이). 이것이 "Claude Code로 시나리오 통과"의 기계 판정 대체물이다

## CONSTRAINTS

CLAUDE.md 보안 기본값. Overlay는 페이지 DOM에 주입하지 않는다. 외부 네트워크 없음(모의 포털은 `app://`). 봇 탐지 우회 코드 금지.

## SUCCESS CRITERIA (전부 통과)

1. `typecheck && lint && build && smoke(M0·M1 회귀)` 통과
2. `npm run test:tools` — 도구별 단위 테스트: 스키마 검증, password 마스킹(read_page·get_page_text·screenshot 블러 픽셀 검사), read_page iframe 평탄화(포털 C), NetTap 패턴 매칭·256KB 상한(포털 B), find 규칙 매칭 5건
3. `npm run test:mcp` — MCP 클라이언트 스크립트가 다음을 완료:
   - **시나리오 A**: preview_start → read_page → 페이지 10장 순회 get_page_text → 200행 수집 → 중복 URL 0, 게시일 형식 검증. 중간에 "세션 만료" 버튼으로 리다이렉트 유발 → ask_user 반환 확인 → 세션 복구 후 마지막 페이지에서 재개
   - **시나리오 B**: form_input(체크박스 P1·P2, 셀렉트 기간) → click 조회 → scroll 반복 + read_network_requests(`/api/incidents`)로 JSON 누적 → 건수 = total, DOM 파싱 없이 완료
   - **시나리오 C**: read_page로 iframe 트리 노드 ref → click → 목록 iframe get_page_text → 행 click → 팝업 새 탭 tabs_context로 tabId 확보 → download(첨부) → tabs_close, 10건 반복, EUC-KR 페이지 텍스트 깨짐 0(치환문자 비율 < 1%)
4. Handoff 테스트: MCP로 조작 중인 탭에 smoke가 키 입력 주입 → 진행 중 도구 호출이 `{paused:true}` 반환 → "이어서" → `{resumed:true, note:'user intervened'}` → 계속
5. Overlay 스크린샷: click 직전 프레임에 하이라이트 bbox 픽셀 존재(색상 임계값)
6. `docs/tool-compat.md` 생성(호환 도구 표 + 차이점)
7. `artifacts/m2/REPORT.md`에 결과·스크린샷(시나리오별 대표 3장)·실행법(`npm run dev` + MCP 접속 예: `claude mcp add helm --transport http http://localhost:3100`)

## AUTONOMY LOOP

모의 포털 → 도구 → 오버레이/Handoff → MCP 순으로 구현하되 각 단계마다 테스트 통과 후 다음으로. 실패 로그 읽고 수정·재시도. `[M2]` 커밋. 전부 PASS면 REPORT.md.

## STOP CONDITIONS

- PRECONDITIONS 미충족
- 같은 근본 원인 5회 실패
- `webContents.debugger`가 특정 CDP 도메인을 현재 Electron에서 지원하지 않음 → 대체 CDP 메서드 시도 후에도 불가하면 STOP(REPORT에 기록)
- OUT OF SCOPE 결정 필요

## DONE

`artifacts/m2/REPORT.md` 전부 PASS. 사람이 Claude Code에 MCP를 붙여 모의 포털 A에서 "공지 200건 표로 뽑아줘"를 시키면 AI 탭이 열리고 커서·하이라이트가 보이며, 사람이 그 탭을 클릭하면 멈춘다.

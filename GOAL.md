# GOAL.md — Helm(가칭) M0 첫 산출물

이 파일은 Claude Code가 이번 세션의 **목표**로 읽는 단일 명세다. `CLAUDE.md`(규칙)와 함께 읽고, 이 목표 하나만 개입 없이 끝까지 달성한다. 목표 밖은 하지 않는다.

---

## OBJECTIVE (목표)

사람은 기존 크롬처럼 쓰고 AI는 사람처럼 다루는 사내 브라우저 "Helm"의 **가장 작은 실행 골격(M0)** 을 신규 스캐폴딩으로 만든다. Electron(Chromium 내장) 위에서 탭·주소창·네비게이션이 동작하고 세션이 재시작 후에도 유지되는, "뜨는 빈 브라우저"가 결과물이다.

이번 세션의 목표는 이것 **하나**다.

## IN SCOPE (이번에 만드는 것)

- electron-vite 기반 Electron + React + TypeScript(strict) 신규 프로젝트
- 메인: `BaseWindow` + `WebContentsView` 기반 탭 관리(TabManager), 영구 세션 partition `persist:helm`
- 커스텀 프로토콜 `app://` 로 번들 홈페이지(`app://home`) 제공 (외부 네트워크 불필요)
- 렌더러: 세로 탭바 + 주소창 + 뒤로/앞으로/새로고침. 최소하지만 깔끔한 UI
- 자동 스모크 테스트(`scripts/smoke.ts`, `@playwright/test`의 Electron 런처)
- `package.json` 스크립트: `dev`, `build`, `typecheck`, `lint`, `smoke`

## OUT OF SCOPE (이번에 하지 않는 것)

AI 비서, ToolSurface, MCP 서버, 로컬 LLM, 에이전트, 사내 포털, 인증정보 임포트, 로그인 획득 경로, 검증(워크플로우) 계층, 승인·되돌리기 UI, 확장 프로그램. 이들은 M1 이후 별도 세션의 목표다. 이 항목이 필요해지면 스코프 오류이므로 만들지 말고 `REPORT.md`에 기록한다.

## FIXED DECISIONS (되묻지 말 것 — 이미 결정됨)

- 신규(greenfield) 스캐폴딩으로 만든다. Vessel 포크는 M0 산출물을 본 뒤 별도 검토(도중에 판단하지 않음).
- 스택은 위 IN SCOPE 그대로. 대체 프레임워크를 고르지 않는다.
- 테스트는 외부 접속 없이 번들 로컬 페이지(`app://home`)로만 한다.
- 모르는 Electron API는 추측하지 말고 설치된 타입 정의와 공식 문서 패턴을 확인한다.

## CONSTRAINTS (제약 — CLAUDE.md 보안 기본값과 동일)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- 웹 콘텐츠 `WebContentsView`에는 preload를 붙이지 않는다
- IPC는 화이트리스트 채널만 노출한다
- 외부 네트워크 호출 코드를 넣지 않는다(자동 업데이트·텔레메트리·크래시 리포트 금지). `npm install`만 예외
- 의존성 라이선스는 MIT/Apache-2.0/BSD/ISC/0BSD/MPL-2.0만

## SUCCESS CRITERIA (성공 조건 — 전부 통과해야 완료)

기계로 판정 가능한 조건이다. "됐다"를 말로 판단하지 않고 실제로 실행해 확인한다.

1. `npm run typecheck` 통과
2. `npm run lint` 통과
3. `npm run build` 성공
4. `npm run smoke` 통과 — 스모크 테스트가 다음을 검증:
   - 앱이 실행되고 메인 윈도우가 뜬다
   - 새 탭 2개 생성 → 하나를 `app://home` 으로 이동 → 문서 `title`이 기대값과 일치
   - 탭 전환·닫기 동작
   - 앱 종료 후 재실행 시 `persist:helm` 파티션이 유지됨(쿠키 1개 저장 → 재시작 → 동일 쿠키 재확인)
   - `webContents.capturePage()` 스크린샷을 `artifacts/m0/`에 저장
5. `artifacts/m0/REPORT.md` 에 위 4개 결과(PASS/FAIL), 스크린샷 경로, 실행 방법(`npm run dev`)을 기록

## AUTONOMY LOOP (개입 없이 도는 방식)

1. 스캐폴딩 → 구현 → `typecheck → lint → build → smoke` 순으로 실제 실행
2. 실패하면 로그를 읽고 원인을 고쳐 재시도. 통과할 때까지 반복
3. UI 렌더링 여부는 스크린샷 파일(크기·해상도)로 확인, 말로 단정하지 않음
4. 의미 단위로 커밋(한국어, 제목 50자 이내, 본문에 `[M0]`)
5. 5개 성공 조건이 모두 통과하면 `REPORT.md`를 쓰고 종료

## STOP CONDITIONS (여기서만 멈추고 사람을 부른다)

다음이면 억지로 진행하지 말고 `artifacts/m0/REPORT.md`에 상황·재현법·막힌 지점을 적고 종료:

- `npm install`이 레지스트리 접근 불가로 실패(환경 문제 — 코드로 해결 불가)
- 같은 근본 원인으로 5회 이상 build/smoke 실패
- OUT OF SCOPE 결정이 필요해짐(스코프 오류 — 발생 자체를 기록)

## DONE (완료의 정의)

`artifacts/m0/REPORT.md`가 존재하고 5개 성공 조건이 모두 PASS이며, `npm run dev`로 사람이 직접 띄웠을 때 탭·주소창·네비게이션이 동작하고 재시작 후 세션이 유지된다.

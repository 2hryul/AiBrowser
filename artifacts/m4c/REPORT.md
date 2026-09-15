# M4c REPORT — 로그인 획득 경로 + 최초 임포트 마법사

- 날짜: 2026-09-15
- 목표: `goals/GOAL-M4c.md` — 인증 토큰을 이관하지 않고도 "다시 로그인 안 함" 을 체감하게 한다
- 결론: **SUCCESS CRITERIA 전부 PASS**

## 성공 조건 판정

| # | 조건 | 판정 | 근거 |
|---|---|---|---|
| 1 | 회귀: typecheck·lint·build·smoke·test:tools·test:mcp·test:policy·test:persistence | **PASS** | typecheck·lint 0건, smoke 13/13, tools 10/10, mcp 6/6, policy 85, persistence 45. 단위 전체 429/429(주입 저항 10건 포함, 실제 모델) |
| 2 | `npm run test:login` | **PASS** (6/6) | 아래 상세 |
| 3 | `npm run test:import` | **PASS** (3/3) | 아래 상세 |
| 4 | lint 규칙(`Cookies` 금지, `Login Data` 조건부) | **PASS** | `eslint-rules/no-credential-files.mjs` + `tests/no-credential-files.test.ts` 2건. 미끼 이름은 `fixtures/profiles/skip-names.json` 데이터로만 존재 |
| 5 | `docs/adr/0003-인증정보-미이관.md` | **PASS** | ABE/DBSC 근거, 3경로·3단계 정책, CSV-only 사유, 선례 |
| 6 | 이 REPORT | **PASS** | — |

## 실행법

```powershell
npm run typecheck; npm run lint; npx vitest run
npm run smoke; npm run test:tools; npm run test:mcp
npm run test:login          # 로그인 경로 3종 + 세션 만료 연동
npm run test:import         # 3단계 임포트 마법사
```

주의: E2E 전에 앞 실행이 남긴 electron 이 단일 인스턴스 잠금을 쥐고 있을 수 있다 —
`taskkill /F /IM electron.exe /T` 후 실행.

## test:login 상세 (`scripts/login-e2e.ts`)

| 시나리오 | 확인한 것 |
|---|---|
| inapp | `app://idp-form` 폼 로그인 → fixture 세션 성립 → 세션 메타 `method:'inapp'` 기록 |
| inapp 재시작 | 앱 재시작 후 세션 메타(SQLite·safeStorage) 유지. `app://` 는 쿠키를 가질 수 없어(Chromium 이 커스텀 스킴 쿠키 거부) 파티션 쿠키의 재시작 유지는 smoke [M0] 가 실제 https 쿠키로 검증한다 |
| oauth_modal | 일반 탭에서 `app://idp-oauth` 를 열면 "안전하지 않은 앱"(#embedded-blocked) → 모달(Electron 토큰만 뗀 표준 Chromium UA)에서 로그인 시작 → 동의 → code 발급 → redirect → `/callback` 도달 → 모달 자동 닫힘 → 세션 성립 |
| external 허용 | 화이트리스트 호스트는 `shell.openExternal` 호출(HELM_E2E 에서 mock 기록) → 사람이 "완료" → probe 검증 통과 → 메타 `method:'external'` |
| external 거부 | 화이트리스트 밖 호스트(`portal-a`)는 **브라우저를 열기 전에** `denied` + 감사 로그 `login_denied`, openExternal 호출 0건 |
| 세션 만료 | 스레드 소유 탭이 보호 자원에서 로그인 화면으로 되밀림 → 스레드 `waiting_login` + 체크포인트("로그인 필요") + 받은편지함 `login_required` → 사이드바 카드(경로 3종 버튼)에서 inapp 로그인 → 스레드 `running` 재개 + 항목 읽음 처리 |

스크린샷: `artifacts/m4c/login-required-card.png` (경로 3종 버튼이 있는 카드),
실측값: `artifacts/m4c/login-summary.json`

## test:import 상세 (`scripts/import-e2e.ts`)

| 시나리오 | 확인한 것 |
|---|---|
| 건수 일치 | Chrome fixture: 북마크 4·기록 5·자동완성 3, Edge: 2·2·1 — `expected.json` 과 일치. 미끼 파일 5개는 "가져오지 않음" 으로 보고 |
| 접근 0건 | HELM_E2E 의 fs 계측(내용을 읽는 open/read/copy/stream 호출 기록)에서 fixture 프로필 내 자격증명 파일(`skip-names.json` 의 5종) 읽기 **0건**. 기록 자체가 작동함은 허용 파일 읽기 > 0 으로 먼저 확인 |
| 정책 꺼짐 | `allowPasswordImport:false` → 마법사 2단계에 "관리자 정책으로 비활성" 안내만 있고 CSV 입력·동의·버튼 부재(DOM 검사, OCR 아님) |
| 정책 켜짐 + 동의 | CSV 4행(유효 3 + 주소 불량 1) → 자격증명 대역(mock)에 `Helm:<host>` 3건, 건너뜀 1건, 원본 CSV 부재(0 덮고 삭제), 감사 로그 `import_passwords` count=3 |
| 값 노출 없음 | 마법사 DOM 전체(text + input value)에 fixture 비밀번호 문자열 5종 부재 + 스크린샷 |

스크린샷: `artifacts/m4c/wizard-passwords-disabled.png`, `artifacts/m4c/wizard-passwords-imported.png`,
실측값: `artifacts/m4c/import-summary.json`

## 이번 마일스톤에서 내린 설계 판단

1. **비밀번호는 Chrome 내보내기 CSV 경로만** — `no-credential-files` 의 좁은 예외는
   `Login Data` 만 덮고 복호화 관용구는 그대로 금지라, DPAPI 경로는 이 규칙 아래에서
   작성할 수 없다. 상세는 ADR 0003.
2. **`login_start` 는 ToolSurface 도구로 노출하지 않았다** — 로그인은 사람만 하는 일이다.
   AI(에이전트·MCP)는 로그인 벽을 만나면 `waiting_login` + 받은편지함으로 사람에게
   넘기고, 경로 선택(inapp/oauth_modal/external)은 사이드바 카드가 유일한 입구다.
   도구로 노출하면 AI 가 외부 브라우저 열기(external)를 개시할 수 있게 되는데, 그 판단을
   AI 에게 줄 이유가 없다. GOAL IN SCOPE 의 `tools/login.ts` 는 이 사유로 IPC
   (`helm:login:start`) + 카드로 대체했다. 필요해지면(예: MCP 클라이언트가 직접 로그인
   재개를 지시하고 싶을 때) 승인 강제(irreversible)로 노출하는 별도 결정을 한다.
3. **fixture 임베디드 거부는 페이지 안에서도 판정** — `protocol.handle` 의 Request 에는
   user-agent 헤더가 실리지 않는다(실측: 탭 UA 에 `Electron/44` 가 있어도 헤더는 빈 값).
   그래서 `navigator.userAgent` 를 확인하는 EMBED_GATE 스크립트를 fixture 페이지에
   넣었다. 모달의 `loadURL({userAgent})` 는 navigator 에 반영되므로 재현하려는 성질
   (토큰 뗀 모달만 통과)은 같다. 서버 쪽 `looksEmbedded` 는 실제 http IdP 용으로 남겼다.
4. **세션 만료 감지는 에이전트 안팎 이중** — 내장 에이전트는 `Agent.loginGate`(M4b),
   그 밖(MCP 가 몰던 탭, 복원된 탭)은 `sessions/SessionExpiry.ts` + `watchSessionExpiry`.
   에이전트 실행 중인 스레드는 후자가 건너뛰어 알림이 두 번 쌓이지 않는다.
5. **E2E 자격증명은 mock** — 실제 Windows 자격증명 관리자 연동(P/Invoke)은 단위 테스트에서
   실측으로 검증했고(인수인계 4-2), E2E 는 개발 머신을 더럽히지 않도록
   `MemoryCredentialStore` 를 쓴다(GOAL 성공 조건 3 도 mock 을 요구).

## 남은 것 / 다음 마일스톤(M6) 선행조건

- **M4b 조건 3 미달**(M4c 와 무관): 7B 모델이 XHR 경로를 안 쓰고 화면으로 샌다.
  모델 재선정은 사람 결정.
- 원격 `master` 브랜치 삭제: `git push origin --delete master` (사용자 권한 필요).
- M6 은 **사람 준비물**이 선행조건: 코드 서명 인증서(`HELM_SIGN_PFX`/`HELM_SIGN_PASS`,
  없으면 미서명 진행), `config/pilot.json`(파일럿 도메인·관리자 잠금·사내 LLM 엔드포인트,
  **없으면 STOP**). `externalLoginHosts` 의 운영 목록도 거기서 정한다 — 지금 값은
  검증용 모의 IdP 2종뿐이다.

# Helm (가칭)

AI 비서가 내장될 사내 브라우저. 현재 상태는 **M0 — 뜨는 빈 브라우저 골격**이다.
AI·MCP·에이전트는 아직 없다(M2 이후).

## 지금 되는 것

- `BaseWindow` + `WebContentsView` 기반 탭 관리, 세로 탭바
- 주소창(정규화·오류 표시), 뒤로/앞으로/새로고침
- 영구 세션 파티션 `persist:helm` — 앱을 껐다 켜도 쿠키·localStorage 유지
- 커스텀 프로토콜 `app://home/` 로 번들 홈페이지 제공 (외부 네트워크 불필요)
- 단축키: `Ctrl+T` 새 탭 · `Ctrl+W` 탭 닫기 · `Ctrl+L` 주소창 · `Ctrl+R`/`F5` 새로고침 · `Alt+←/→` 뒤/앞

## 실행 (Windows 11 / PowerShell)

```powershell
npm install
npm run dev
```

`npm install` 후 Electron 바이너리가 없다는 오류가 나면 한 번만:

```powershell
node node_modules\electron\install.js
```

## 검증

```powershell
npm run typecheck   # tsc strict (main/preload/renderer 분리 프로젝트)
npm run lint        # eslint, 경고 0건 정책
npm run build       # electron-vite build -> out\
npm run smoke       # build + Playwright Electron 스모크 (스크린샷은 artifacts\m0\)
```

스모크 결과 요약은 `artifacts\m0\REPORT.md`.

## 문서

- 기획: `docs\AI브라우저_기획서.md` (별도 관리)
- 규칙: `CLAUDE.md`
- 이번 세션 목표: `GOAL.md`
- 결정 기록: `docs\adr\`

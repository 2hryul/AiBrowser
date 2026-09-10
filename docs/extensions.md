# 확장 프로그램 호환성 기록 (M1)

구현: `src/main/browser/Extensions.ts` (`session.loadExtension`).
설정: `config/extensions.json` — unpacked 디렉터리 경로 목록.

```json
[{ "name": "사내 보안 확장", "path": "C:\\corp\\extensions\\security-unpacked", "required": true }]
```

`config/extensions.example.json` 에 형식 예시가 있다. 확장 로드 실패는 버그가 아니라 호환성
기록 대상이며(GOAL-M1 FIXED DECISIONS), 실패해도 브라우저는 정상 기동한다 — 로드는 창을 띄운
뒤에 수행한다.

## 사내 필수 확장 3종 — SKIPPED

**이번 세션에서는 검증하지 못했다.** `config/extensions.json` 이 `[]` 로,
사내 필수 확장의 unpacked 경로가 제공되지 않았다(GOAL-M1 PRECONDITIONS 의 "없으면 `[]` 를
두고 SKIPPED 로 기록" 경로). 실제 확장 3종은 경로가 채워진 뒤 이 문서에 결과를 추가한다.

| 확장명 | 경로 | 결과 | 미지원 API | 대안 |
|---|---|---|---|---|
| (미제공) | — | SKIPPED | — | `config/extensions.json` 에 경로 등록 후 재검증 |

## 로더 자체 검증 — PASS

확장 3종이 없어도 로더가 동작하는지는 확인해야 하므로, 저장소에 fixture 확장을 두고
스모크에서 실제로 로드한다(`fixtures/extensions/`). 실측 결과(`artifacts/m1/extensions.json`):

| fixture | manifest 이름 | 버전 | 로드 | 미지원 권한 | 비고 |
|---|---|---|---|---|---|
| `helm-devtest` | Helm 확장 로드 검증 | 1.0.0 | **성공** | 없음 | MV3, `storage` 권한만 |
| `helm-unsupported` | Helm 미지원 API 검증 | 0.2.0 | **성공** | `bookmarks`, `history`, `notifications` | 로드는 되지만 해당 API 는 동작하지 않음 |
| `helm-missing` | — | — | **실패** | — | `manifest.json 없음 (unpacked 디렉터리 경로인지 확인)` |

`allowFileAccess` 는 켜지 않는다 — 확장이 로컬 파일을 읽을 이유가 없다(최소 권한 원칙).

## Electron 이 지원하지 않는 확장 API

`findUnsupportedPermissions()` 가 manifest 의 `permissions`·`optional_permissions` 를 보고
아래 목록과 교차하는 항목을 경고로 올린다. 로드는 막지 않는다 — 확장이 그 API 를 실제로
쓰는지는 manifest 만으로 알 수 없기 때문이다.

`alarms`, `bookmarks`, `browsingData`, `commands`, `contextMenus`, `downloads`, `history`,
`identity`, `nativeMessaging`, `notifications`, `permissions`, `privacy`, `sessions`,
`tabGroups`, `topSites`, `webNavigation`

목록 근거는 Electron 공식 문서의 Chrome Extension Support 절이다. Electron 버전을 올릴 때
이 목록을 다시 확인해야 한다(`UNSUPPORTED_PERMISSIONS` in `Extensions.ts`).

### 자주 걸리는 대안

| 미지원 API | 사내 확장에서의 용도 | 대안 |
|---|---|---|
| `chrome.notifications` | 알림 표시 | 웹 `Notification` API 또는 M4 받은편지함(Inbox) |
| `chrome.contextMenus` | 우클릭 메뉴 항목 | Helm 셸의 컨텍스트 메뉴(M1 범위 밖, M2 이후) |
| `chrome.history` / `chrome.bookmarks` | 기록·북마크 읽기 | Helm 자체 저장소. AI 쪽은 M4 `bookmark_list` 도구 |
| `chrome.downloads` | 다운로드 제어 | Helm 다운로드 관리자(Ctrl+J) |
| `chrome.identity` | SSO 토큰 획득 | M4c `login_start` 3경로. 토큰 이관은 금지(불변 조건 9) |
| `chrome.webNavigation` | 탐색 이벤트 | M2 ToolSurface 의 탐색 이벤트 |

## 재검증 방법

```powershell
# config\extensions.json 에 경로를 채운 뒤
npm run smoke        # 확장 로드 결과가 artifacts\m1\extensions.json 에 남는다
```

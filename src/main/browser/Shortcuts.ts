import type { WebContents } from 'electron';

/**
 * 크롬 호환 단축키.
 * 셸과 각 탭 웹 콘텐츠 양쪽에 걸어야 포커스가 어디 있어도 동작한다.
 * (globalShortcut 은 앱이 백그라운드일 때도 가로채므로 쓰지 않는다.)
 *
 * 대응표는 docs/shortcuts.md 에 있고, 이 파일이 그 문서의 근거다.
 */
export interface ShortcutHandlers {
  newTab: () => void;
  closeTab: () => void;
  restoreClosedTab: () => void;
  focusOmnibox: () => void;
  reload: () => void;
  hardReload: () => void;
  goBack: () => void;
  goForward: () => void;
  openHistory: () => void;
  openDownloads: () => void;
  openBookmarkManager: () => void;
  /** M3 제어 화면 — 되돌리기 / 단계 로그 / 정책 */
  openUndoPanel: () => void;
  openStepLog: () => void;
  openPolicy: () => void;
  /** M4a 지속성 화면 — 작업(스레드) / 받은편지함 */
  openThreads: () => void;
  openInbox: () => void;
  bookmarkCurrentPage: () => void;
  toggleReader: () => void;
  openFind: () => void;
  print: () => void;
  savePdf: () => void;
  toggleDevTools: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  cycleTheme: () => void;
  toggleOrientation: () => void;
  escape: () => void;
  /** Ctrl+1..8 → n번째 탭, Ctrl+9 → 마지막 탭 (크롬과 동일) */
  selectTabByIndex: (index: number) => void;
  nextTab: () => void;
  previousTab: () => void;
}

export function attachShortcuts(wc: WebContents, handlers: ShortcutHandlers): void {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const ctrl = input.control || input.meta;
    const { shift, alt } = input;
    const key = input.key.toLowerCase();

    const run = (fn: () => void): void => {
      event.preventDefault();
      fn();
    };

    // ── Ctrl (+Shift 없음) ──
    if (ctrl && !shift && !alt) {
      switch (key) {
        case 't':
          return run(handlers.newTab);
        case 'w':
          return run(handlers.closeTab);
        case 'l':
          return run(handlers.focusOmnibox);
        case 'r':
          return run(handlers.reload);
        case 'h':
          return run(handlers.openHistory);
        case 'j':
          return run(handlers.openDownloads);
        case 'd':
          return run(handlers.bookmarkCurrentPage);
        case 'f':
          return run(handlers.openFind);
        case 'p':
          return run(handlers.print);
        case ',':
          return run(handlers.openPolicy);
        case 'tab':
          return run(handlers.nextTab);
        // 확대/축소: 키보드 배열에 따라 '+'·'='·'-'·'_' 가 모두 올 수 있다.
        case '+':
        case '=':
          return run(handlers.zoomIn);
        case '-':
        case '_':
          return run(handlers.zoomOut);
        case '0':
          return run(handlers.zoomReset);
        default:
          break;
      }

      if (/^[1-9]$/.test(key)) {
        // Ctrl+9 는 마지막 탭. 나머지는 1-기반 인덱스.
        return run(() => handlers.selectTabByIndex(key === '9' ? -1 : Number(key) - 1));
      }
    }

    // ── Ctrl+Shift ──
    if (ctrl && shift && !alt) {
      switch (key) {
        case 't':
          return run(handlers.restoreClosedTab);
        case 'o':
          return run(handlers.openBookmarkManager);
        case 'r':
          return run(handlers.hardReload);
        case 'i':
          return run(handlers.toggleDevTools);
        case 's':
          return run(handlers.savePdf);
        case 'd':
          return run(handlers.cycleTheme);
        case 'e':
          return run(handlers.toggleOrientation);
        case 'u':
          return run(handlers.openUndoPanel);
        case 'g':
          return run(handlers.openStepLog);
        case 'k':
          return run(handlers.openThreads);
        case 'm':
          return run(handlers.openInbox);
        case 'tab':
          return run(handlers.previousTab);
        default:
          break;
      }
    }

    // ── Alt ──
    if (alt && !ctrl) {
      if (input.key === 'ArrowLeft') return run(handlers.goBack);
      if (input.key === 'ArrowRight') return run(handlers.goForward);
    }

    // ── 단독 기능키 ──
    if (!ctrl && !alt && !shift) {
      if (key === 'f5') return run(handlers.reload);
      if (key === 'f12') return run(handlers.toggleDevTools);
      if (key === 'f9') return run(handlers.toggleReader);
      if (key === 'escape') return run(handlers.escape);
    }
  });
}

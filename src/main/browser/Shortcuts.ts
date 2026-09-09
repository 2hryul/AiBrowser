import type { WebContents } from 'electron';

export interface ShortcutHandlers {
  newTab: () => void;
  closeTab: () => void;
  focusOmnibox: () => void;
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
}

/**
 * 크롬과 같은 기본 단축키를 붙인다.
 * 셸과 각 탭 웹 콘텐츠 양쪽에 걸어야 포커스가 어디 있어도 동작한다.
 * (globalShortcut 은 앱이 백그라운드일 때도 가로채므로 쓰지 않는다.)
 */
export function attachShortcuts(wc: WebContents, handlers: ShortcutHandlers): void {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();

    const run = (fn: () => void): void => {
      event.preventDefault();
      fn();
    };

    if (ctrl && !input.shift && !input.alt) {
      if (key === 't') return run(handlers.newTab);
      if (key === 'w') return run(handlers.closeTab);
      if (key === 'l') return run(handlers.focusOmnibox);
      if (key === 'r') return run(handlers.reload);
    }
    if (!ctrl && key === 'f5') return run(handlers.reload);
    if (input.alt && !ctrl) {
      if (input.key === 'ArrowLeft') return run(handlers.goBack);
      if (input.key === 'ArrowRight') return run(handlers.goForward);
    }
  });
}

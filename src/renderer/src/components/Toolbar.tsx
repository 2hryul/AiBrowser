import type { ShellState } from '../../../shared/api';
import type { Bookmark, TabState } from '../../../shared/types';
import { NavButtons } from './NavButtons';
import { Omnibox } from './Omnibox';

interface Props {
  tab: TabState | null;
  shell: ShellState;
  bookmarks: Bookmark[];
}

const iconButton =
  'grid h-8 w-8 place-items-center rounded-md text-shell-muted transition-colors ' +
  'enabled:hover:bg-shell-panel enabled:hover:text-shell-text disabled:opacity-30';

const THEME_ICON: Record<ShellState['theme'], string> = {
  system: '🖥️',
  light: '☀️',
  dark: '🌙'
};

const THEME_LABEL: Record<ShellState['theme'], string> = {
  system: '시스템 설정',
  light: '밝게',
  dark: '어둡게'
};

/** 주소창 줄 — 네비게이션, 주소창, 페이지 도구, 패널 토글. */
export function Toolbar({ tab, shell, bookmarks }: Props): JSX.Element {
  const bookmarked = tab ? bookmarks.some((b) => b.url === tab.url) : false;

  const togglePanel = (panel: ShellState['panel']): void => {
    void window.helm.openPanel(shell.panel === panel ? 'none' : panel);
  };

  return (
    <div className="flex w-full items-center gap-2 px-3">
      <NavButtons tab={tab} />
      <Omnibox tab={tab} />

      <button
        type="button"
        aria-label={bookmarked ? '북마크 삭제' : '북마크 추가'}
        aria-pressed={bookmarked}
        title={bookmarked ? '북마크 삭제 (Ctrl+D)' : '북마크 추가 (Ctrl+D)'}
        className={iconButton}
        disabled={!tab}
        onClick={() => {
          if (!tab) return;
          if (bookmarked) void window.helm.bookmarkRemoveByUrl(tab.url);
          else void window.helm.bookmarkAdd(tab.url, tab.title);
        }}
      >
        <span className={bookmarked ? 'text-amber-400' : ''}>{bookmarked ? '★' : '☆'}</span>
      </button>

      <button
        type="button"
        aria-label="읽기 모드"
        aria-pressed={shell.panel === 'reader'}
        title="읽기 모드 (F9)"
        className={iconButton}
        disabled={!tab?.readerable && shell.panel !== 'reader'}
        onClick={() => togglePanel('reader')}
      >
        📖
      </button>

      <button
        type="button"
        aria-label="페이지에서 찾기"
        title="페이지에서 찾기 (Ctrl+F)"
        className={iconButton}
        disabled={!tab}
        onClick={() => void window.helm.find('')}
      >
        🔎
      </button>

      <button
        type="button"
        aria-label="방문 기록"
        aria-pressed={shell.panel === 'history'}
        title="방문 기록 (Ctrl+H)"
        className={iconButton}
        onClick={() => togglePanel('history')}
      >
        🕘
      </button>

      <button
        type="button"
        aria-label="다운로드"
        aria-pressed={shell.panel === 'downloads'}
        title="다운로드 (Ctrl+J)"
        className={iconButton}
        onClick={() => togglePanel('downloads')}
      >
        ⬇️
      </button>

      <button
        type="button"
        aria-label="북마크 관리자"
        aria-pressed={shell.panel === 'bookmarks'}
        title="북마크 관리자 (Ctrl+Shift+O)"
        className={iconButton}
        onClick={() => togglePanel('bookmarks')}
      >
        ☰
      </button>

      <button
        type="button"
        aria-label={`테마: ${THEME_LABEL[shell.theme]}`}
        title={`테마: ${THEME_LABEL[shell.theme]} (Ctrl+Shift+D)`}
        className={iconButton}
        onClick={() => void window.helm.cycleTheme()}
      >
        {THEME_ICON[shell.theme]}
      </button>

      <button
        type="button"
        aria-label="개발자도구"
        title="개발자도구 (F12)"
        className={iconButton}
        disabled={!tab}
        onClick={() => void window.helm.toggleDevTools()}
      >
        {'{}'}
      </button>

      <button
        type="button"
        aria-label="인쇄"
        title="인쇄 (Ctrl+P)"
        className={iconButton}
        disabled={!tab}
        onClick={() => void window.helm.print()}
      >
        🖨️
      </button>

      <button
        type="button"
        aria-label="PDF로 저장"
        title="PDF로 저장 (Ctrl+Shift+S)"
        className={iconButton}
        disabled={!tab}
        onClick={() => void window.helm.savePdf()}
      >
        📄
      </button>
    </div>
  );
}

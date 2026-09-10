import type { Bookmark } from '../../../shared/types';

interface Props {
  bookmarks: Bookmark[];
  activeTabId: number | null;
}

/** 북마크바. 북마크가 하나라도 있으면 주소창 아래에 붙는다. */
export function BookmarksBar({ bookmarks, activeTabId }: Props): JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="북마크바"
      className="flex h-full w-full items-center gap-1 overflow-x-auto border-b border-shell-line bg-shell-bg px-3"
    >
      {bookmarks.map((bookmark) => (
        <button
          key={bookmark.id}
          type="button"
          data-bookmark-id={bookmark.id}
          title={`${bookmark.title}\n${bookmark.url}${bookmark.folder ? `\n폴더: ${bookmark.folder}` : ''}`}
          className="flex h-6 max-w-[180px] shrink-0 items-center gap-1.5 rounded px-2 text-[12px] text-shell-muted hover:bg-shell-panel hover:text-shell-text"
          onClick={() => {
            if (activeTabId !== null) void window.helm.navigate(activeTabId, bookmark.url);
            else void window.helm.createTab(bookmark.url);
          }}
          onAuxClick={(e) => {
            // 가운데 버튼 → 새 탭에서 열기 (크롬 동작)
            if (e.button === 1) void window.helm.createTab(bookmark.url);
          }}
        >
          <span aria-hidden className="text-[10px] text-amber-400">
            ★
          </span>
          <span className="truncate">{bookmark.title}</span>
        </button>
      ))}
    </div>
  );
}

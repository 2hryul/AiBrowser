import { useState } from 'react';
import type { Bookmark } from '../../../../shared/types';
import { PanelFrame } from './PanelFrame';
import { ImportPanel } from './ImportPanel';

interface Props {
  bookmarks: Bookmark[];
  activeTabId: number | null;
}

/** 북마크 관리자 (Ctrl+Shift+O). 열기·이름 변경·삭제. */
export function BookmarksPanel({ bookmarks, activeTabId }: Props): JSX.Element {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const commitRename = (bookmark: Bookmark): void => {
    const title = draft.trim();
    setEditingId(null);
    if (title === '' || title === bookmark.title) return;
    void window.helm.bookmarkRename(bookmark.id, title);
  };

  const smallButton =
    'h-6 rounded border border-shell-line px-2 text-[11px] text-shell-muted hover:text-shell-text';

  return (
    <PanelFrame title="북마크" count={bookmarks.length}>
      <ImportPanel />
      {bookmarks.length === 0 ? (
        <p className="p-6 text-[13px] text-shell-muted">
          북마크가 없습니다. 주소창 오른쪽 별(☆) 또는 Ctrl+D 로 추가합니다.
        </p>
      ) : (
        <ul data-bookmarks-count={bookmarks.length} className="divide-y divide-shell-line">
          {bookmarks.map((bookmark) => (
            <li
              key={bookmark.id}
              data-bookmark-id={bookmark.id}
              className="flex items-center gap-3 px-4 py-2 text-[13px]"
            >
              <span aria-hidden className="shrink-0 text-amber-400">
                ★
              </span>

              {editingId === bookmark.id ? (
                <input
                  autoFocus
                  aria-label="북마크 이름"
                  className="h-7 min-w-0 flex-1 rounded border border-shell-accent bg-shell-panel px-2 outline-none"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(bookmark)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(bookmark);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                  title={bookmark.url}
                  onClick={() => {
                    if (activeTabId !== null) void window.helm.navigate(activeTabId, bookmark.url);
                    else void window.helm.createTab(bookmark.url);
                    void window.helm.openPanel('none');
                  }}
                >
                  {bookmark.title}
                </button>
              )}

              {bookmark.folder ? (
                <span className="shrink-0 rounded bg-shell-line px-1.5 py-0.5 text-[10px] text-shell-muted">
                  {bookmark.folder}
                </span>
              ) : null}

              <span className="hidden max-w-[30%] shrink-0 truncate text-[11px] text-shell-muted md:block">
                {bookmark.url}
              </span>

              <button
                type="button"
                className={smallButton}
                onClick={() => {
                  setEditingId(bookmark.id);
                  setDraft(bookmark.title);
                }}
              >
                이름 변경
              </button>
              <button
                type="button"
                aria-label={`${bookmark.title} 북마크 삭제`}
                className={smallButton}
                onClick={() => void window.helm.bookmarkRemove(bookmark.id)}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

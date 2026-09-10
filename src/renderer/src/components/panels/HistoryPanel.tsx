import { useEffect, useState } from 'react';
import type { HistoryEntry } from '../../../../shared/types';
import { PanelFrame } from './PanelFrame';

interface Props {
  activeTabId: number | null;
}

/** 방문 기록 화면 (Ctrl+H). 검색 필터와 개별·전체 삭제를 제공한다. */
export function HistoryPanel({ activeTabId }: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  const reload = (nextQuery: string): void => {
    void window.helm.historyList(nextQuery).then(setEntries);
  };

  // 입력이 멈춘 뒤 조회한다 — 타이핑마다 DB 를 때리지 않게 한다.
  useEffect(() => {
    const timer = setTimeout(() => reload(query), 80);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <PanelFrame
      title="방문 기록"
      count={entries.length}
      actions={
        <>
          <input
            type="search"
            aria-label="방문 기록 검색"
            placeholder="제목·주소 검색"
            className="h-7 w-56 rounded border border-shell-line bg-shell-panel px-2 text-[12px] outline-none focus:border-shell-accent"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="h-7 rounded border border-shell-line px-2 text-[12px] text-shell-muted hover:text-shell-text"
            onClick={() => {
              void window.helm.historyClear().then(() => reload(query));
            }}
          >
            전체 삭제
          </button>
        </>
      }
    >
      {entries.length === 0 ? (
        <p className="p-6 text-[13px] text-shell-muted">
          {query === '' ? '방문 기록이 없습니다.' : `"${query}" 와 일치하는 기록이 없습니다.`}
        </p>
      ) : (
        <ul data-history-count={entries.length} className="divide-y divide-shell-line">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-history-url={entry.url}
              className="group flex items-center gap-3 px-4 py-2 text-[13px] hover:bg-shell-panel/50"
            >
              <span className="w-32 shrink-0 text-[11px] tabular-nums text-shell-muted">
                {formatTime(entry.visitedAt)}
              </span>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left hover:underline"
                title={entry.url}
                onClick={() => {
                  if (activeTabId !== null) void window.helm.navigate(activeTabId, entry.url);
                  else void window.helm.createTab(entry.url);
                  void window.helm.openPanel('none');
                }}
              >
                {entry.title || entry.url}
              </button>
              <span className="hidden max-w-[35%] shrink-0 truncate text-[11px] text-shell-muted md:block">
                {entry.url}
              </span>
              <button
                type="button"
                aria-label={`${entry.title || entry.url} 기록 삭제`}
                className="shrink-0 rounded px-1 text-shell-muted opacity-0 hover:bg-shell-line group-hover:opacity-100"
                onClick={() => {
                  void window.helm.historyRemove(entry.id).then(() => reload(query));
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

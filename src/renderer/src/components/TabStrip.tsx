import type { TabState } from '../../../shared/types';

interface Props {
  tabs: TabState[];
  activeTabId: number | null;
}

/** 세로 탭바. 탭 제목·로딩 표시·닫기 버튼과 새 탭 버튼만 있는 최소 구성. */
export function TabStrip({ tabs, activeTabId }: Props): JSX.Element {
  return (
    <div className="flex h-full flex-col border-r border-shell-line bg-shell-bg">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-shell-accent text-[12px] font-bold text-white">
          H
        </span>
        <span className="text-[13px] font-semibold tracking-tight">Helm</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              title={tab.url}
              onMouseDown={() => void window.helm.selectTab(tab.id)}
              className={[
                'group mb-1 flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-[13px]',
                active
                  ? 'bg-shell-panel text-shell-text'
                  : 'text-shell-muted hover:bg-shell-panel/60 hover:text-shell-text'
              ].join(' ')}
            >
              <span
                className={[
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  tab.loading ? 'bg-shell-accent' : active ? 'bg-shell-muted' : 'bg-transparent'
                ].join(' ')}
              />
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              {tab.owner === 'ai' ? (
                <span className="shrink-0 rounded bg-shell-accent/20 px-1 text-[10px] text-shell-accent">
                  AI
                </span>
              ) : null}
              <button
                type="button"
                aria-label={`${tab.title} 탭 닫기`}
                className="grid h-5 w-5 shrink-0 place-items-center rounded opacity-0 hover:bg-shell-line group-hover:opacity-100"
                onMouseDown={(e) => {
                  // 탭 선택으로 이벤트가 번지지 않도록 먼저 막는다.
                  e.stopPropagation();
                  void window.helm.closeTab(tab.id);
                }}
              >
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}

        <button
          type="button"
          aria-label="새 탭"
          title="새 탭 (Ctrl+T)"
          className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-[13px] text-shell-muted hover:bg-shell-panel/60 hover:text-shell-text"
          onClick={() => void window.helm.createTab()}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
          </svg>
          새 탭
        </button>
      </div>

      <div className="shrink-0 border-t border-shell-line px-3 py-2 text-[11px] text-shell-muted">
        탭 {tabs.length}개 · persist:helm
      </div>
    </div>
  );
}

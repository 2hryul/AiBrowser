import { useEffect } from 'react';
import { LAYOUT } from '../../shared/types';
import { useShellStore, selectActiveTab } from './store';
import { TabStrip } from './components/TabStrip';
import { Omnibox } from './components/Omnibox';
import { NavButtons } from './components/NavButtons';

export function App(): JSX.Element {
  const tabs = useShellStore((s) => s.tabs);
  const activeTabId = useShellStore((s) => s.activeTabId);
  const apply = useShellStore((s) => s.apply);
  const activeTab = useShellStore(selectActiveTab);

  // 최초 1회 상태를 읽고, 이후는 메인의 푸시만 받는다(폴링 없음).
  useEffect(() => {
    const unsubscribe = window.helm.onStateChanged(apply);
    void window.helm.getState().then(apply);
    return unsubscribe;
  }, [apply]);

  return (
    <div className="flex h-full w-full">
      <aside className="shrink-0" style={{ width: LAYOUT.sidebarWidth }}>
        <TabStrip tabs={tabs} activeTabId={activeTabId} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex shrink-0 items-center gap-2 border-b border-shell-line bg-shell-bg px-3"
          style={{ height: LAYOUT.toolbarHeight }}
        >
          <NavButtons tab={activeTab} />
          <Omnibox tab={activeTab} />
        </header>

        {/* 이 아래 영역은 탭의 WebContentsView가 덮는다. 탭이 없을 때만 보인다. */}
        <main className="grid min-h-0 flex-1 place-items-center bg-shell-panel text-[13px] text-shell-muted">
          {tabs.length === 0 ? '탭이 없습니다. Ctrl+T 로 새 탭을 엽니다.' : null}
        </main>
      </div>
    </div>
  );
}

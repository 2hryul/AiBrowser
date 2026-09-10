import { useEffect } from 'react';
import { LAYOUT } from '../../shared/types';
import { selectActiveTab, useShellStore } from './store';
import { TabStrip } from './components/TabStrip';
import { Toolbar } from './components/Toolbar';
import { BookmarksBar } from './components/BookmarksBar';
import { FindBar } from './components/FindBar';
import { HistoryPanel } from './components/panels/HistoryPanel';
import { DownloadsPanel } from './components/panels/DownloadsPanel';
import { BookmarksPanel } from './components/panels/BookmarksPanel';
import { ReaderView } from './components/panels/ReaderView';

export function App(): JSX.Element {
  const tabs = useShellStore((s) => s.tabs);
  const activeTabId = useShellStore((s) => s.activeTabId);
  const orientation = useShellStore((s) => s.orientation);
  const canRestoreClosedTab = useShellStore((s) => s.canRestoreClosedTab);
  const shell = useShellStore((s) => s.shell);
  const bookmarks = useShellStore((s) => s.bookmarks);
  const downloads = useShellStore((s) => s.downloads);
  const activeTab = useShellStore(selectActiveTab);

  const applyBrowserState = useShellStore((s) => s.applyBrowserState);
  const applyShellState = useShellStore((s) => s.applyShellState);
  const setBookmarks = useShellStore((s) => s.setBookmarks);
  const setDownloads = useShellStore((s) => s.setDownloads);

  // 최초 1회 상태를 읽고, 이후는 메인의 푸시만 받는다(폴링 없음).
  useEffect(() => {
    const unsubscribers = [
      window.helm.onStateChanged(applyBrowserState),
      window.helm.onShellChanged(applyShellState),
      window.helm.onBookmarksChanged(setBookmarks),
      window.helm.onDownloadsChanged(setDownloads)
    ];

    void window.helm.getState().then(applyBrowserState);
    void window.helm.getShellState().then(applyShellState);
    void window.helm.bookmarksList().then(setBookmarks);
    void window.helm.downloadsList().then(setDownloads);

    return () => unsubscribers.forEach((off) => off());
  }, [applyBrowserState, applyShellState, setBookmarks, setDownloads]);

  // 메인이 판정한 다크모드를 문서 속성으로 내린다.
  // nativeTheme 변경이 WebContentsView 의 prefers-color-scheme 으로 전파되지 않아
  // 미디어 쿼리만으로는 셸 색이 바뀌지 않는다(Electron 44 실측, index.css 주석 참고).
  useEffect(() => {
    document.documentElement.dataset['theme'] = shell.darkMode ? 'dark' : 'light';
  }, [shell.darkMode]);

  const vertical = orientation === 'vertical';

  return (
    <div className={vertical ? 'flex h-full w-full' : 'flex h-full w-full flex-col'}>
      {vertical ? (
        <aside className="shrink-0" style={{ width: LAYOUT.sidebarWidth }}>
          <TabStrip
            tabs={tabs}
            activeTabId={activeTabId}
            orientation={orientation}
            canRestoreClosedTab={canRestoreClosedTab}
          />
        </aside>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className="flex shrink-0 items-center border-b border-shell-line bg-shell-bg"
          style={{ height: LAYOUT.toolbarHeight }}
        >
          <Toolbar tab={activeTab} shell={shell} bookmarks={bookmarks} />
        </header>

        {!vertical ? (
          <div className="shrink-0" style={{ height: LAYOUT.horizontalTabStripHeight }}>
            <TabStrip
              tabs={tabs}
              activeTabId={activeTabId}
              orientation={orientation}
              canRestoreClosedTab={canRestoreClosedTab}
            />
          </div>
        ) : null}

        {shell.bookmarksBarVisible ? (
          <div className="shrink-0" style={{ height: LAYOUT.bookmarksBarHeight }}>
            <BookmarksBar bookmarks={bookmarks} activeTabId={activeTabId} />
          </div>
        ) : null}

        {shell.find ? (
          <div className="shrink-0" style={{ height: LAYOUT.findBarHeight }}>
            <FindBar find={shell.find} />
          </div>
        ) : null}

        {/*
          이 영역은 평소 탭의 WebContentsView 가 덮는다.
          내부 화면(패널)이 열리면 메인이 탭 뷰를 숨기므로 여기 그린 내용이 보인다(ADR 0005).
        */}
        <main className="min-h-0 flex-1 bg-shell-panel">
          {shell.panel === 'history' ? <HistoryPanel activeTabId={activeTabId} /> : null}
          {shell.panel === 'downloads' ? <DownloadsPanel downloads={downloads} /> : null}
          {shell.panel === 'bookmarks' ? (
            <BookmarksPanel bookmarks={bookmarks} activeTabId={activeTabId} />
          ) : null}
          {shell.panel === 'reader' ? <ReaderView activeTabId={activeTabId} /> : null}
          {shell.panel === 'none' && tabs.length === 0 ? (
            <div className="grid h-full place-items-center text-[13px] text-shell-muted">
              탭이 없습니다. Ctrl+T 로 새 탭을 엽니다.
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}

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
import { PolicyPanel } from './components/panels/PolicyPanel';
import { PauseResumeBar } from './components/control/PauseResumeBar';
import { PromptDialog } from './components/control/PromptDialog';
import { ApprovalDialog } from './components/control/ApprovalDialog';
import { UndoPanel } from './components/sidebar/UndoPanel';
import { StepLogPlayer } from './components/sidebar/StepLogPlayer';
import { ThreadsPanel } from './components/sidebar/ThreadsPanel';
import { InboxView } from './components/sidebar/InboxView';
import { NotesPanel } from './components/sidebar/NotesPanel';
import { ResultsTable } from './components/sidebar/ResultsTable';
import { SessionsPanel } from './components/panels/SessionsPanel';
import { ChangesPanel } from './components/panels/ChangesPanel';
import { WorkflowsPanel } from './components/panels/WorkflowsPanel';

export function App(): JSX.Element {
  const tabs = useShellStore((s) => s.tabs);
  const activeTabId = useShellStore((s) => s.activeTabId);
  const orientation = useShellStore((s) => s.orientation);
  const canRestoreClosedTab = useShellStore((s) => s.canRestoreClosedTab);
  const shell = useShellStore((s) => s.shell);
  const bookmarks = useShellStore((s) => s.bookmarks);
  const downloads = useShellStore((s) => s.downloads);
  const ai = useShellStore((s) => s.ai);
  const prompts = useShellStore((s) => s.prompts);
  const approvals = useShellStore((s) => s.approvals);
  const policyLocked = useShellStore((s) => s.policyLocked);
  const activeTab = useShellStore(selectActiveTab);

  const applyBrowserState = useShellStore((s) => s.applyBrowserState);
  const applyShellState = useShellStore((s) => s.applyShellState);
  const setBookmarks = useShellStore((s) => s.setBookmarks);
  const setDownloads = useShellStore((s) => s.setDownloads);
  const setAiState = useShellStore((s) => s.setAiState);
  const addPrompt = useShellStore((s) => s.addPrompt);
  const removePrompt = useShellStore((s) => s.removePrompt);
  const setApprovals = useShellStore((s) => s.setApprovals);
  const addApproval = useShellStore((s) => s.addApproval);
  const removeApproval = useShellStore((s) => s.removeApproval);
  const setPolicyLocked = useShellStore((s) => s.setPolicyLocked);

  // 최초 1회 상태를 읽고, 이후는 메인의 푸시만 받는다(폴링 없음).
  useEffect(() => {
    const unsubscribers = [
      window.helm.onStateChanged(applyBrowserState),
      window.helm.onShellChanged(applyShellState),
      window.helm.onBookmarksChanged(setBookmarks),
      window.helm.onDownloadsChanged(setDownloads),
      window.helm.onAiStateChanged(setAiState),
      window.helm.onPromptRequested(addPrompt),
      window.helm.onApprovalRequested(addApproval),
      window.helm.onApprovalQueueChanged(setApprovals)
    ];

    void window.helm.getState().then(applyBrowserState);
    void window.helm.getShellState().then(applyShellState);
    void window.helm.bookmarksList().then(setBookmarks);
    void window.helm.downloadsList().then(setDownloads);
    void window.helm.getAiState().then(setAiState);
    void window.helm.getApprovalQueue().then(setApprovals);
    // 잠금 상태는 승인 다이얼로그의 선택지를 좌우한다 — 다이얼로그가 뜨기 전에 미리 읽어둔다.
    void window.helm.getPolicy().then((value) => setPolicyLocked(value?.locked ?? false));

    return () => unsubscribers.forEach((off) => off());
  }, [
    applyBrowserState,
    applyShellState,
    setBookmarks,
    setDownloads,
    setAiState,
    addPrompt,
    addApproval,
    setApprovals,
    setPolicyLocked
  ]);

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

        {ai.status === 'paused' ? (
          <div className="shrink-0" style={{ height: LAYOUT.pauseBarHeight }}>
            <PauseResumeBar ai={ai} />
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
        <main className="relative min-h-0 flex-1 bg-shell-panel">
          {/* 승인은 도구 실행을 붙잡고 있는 게이트라 ask_user 물음보다 먼저 띄운다. */}
          {approvals[0] ? (
            <ApprovalDialog
              request={approvals[0]}
              locked={policyLocked}
              onAnswered={removeApproval}
            />
          ) : prompts[0] ? (
            <PromptDialog prompt={prompts[0]} onAnswered={removePrompt} />
          ) : null}
          {shell.panel === 'history' ? <HistoryPanel activeTabId={activeTabId} /> : null}
          {shell.panel === 'downloads' ? <DownloadsPanel downloads={downloads} /> : null}
          {shell.panel === 'bookmarks' ? (
            <BookmarksPanel bookmarks={bookmarks} activeTabId={activeTabId} />
          ) : null}
          {shell.panel === 'reader' ? <ReaderView activeTabId={activeTabId} /> : null}
          {shell.panel === 'undo' ? <UndoPanel /> : null}
          {shell.panel === 'audit' ? <StepLogPlayer /> : null}
          {shell.panel === 'policy' ? <PolicyPanel /> : null}
          {shell.panel === 'threads' ? <ThreadsPanel /> : null}
          {shell.panel === 'inbox' ? <InboxView /> : null}
          {shell.panel === 'notes' ? <NotesPanel /> : null}
          {shell.panel === 'results' ? <ResultsTable /> : null}
          {shell.panel === 'sessions' ? <SessionsPanel tabs={tabs} /> : null}
          {shell.panel === 'changes' ? <ChangesPanel /> : null}
          {shell.panel === 'workflows' ? <WorkflowsPanel /> : null}
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

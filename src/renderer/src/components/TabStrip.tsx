import { useState } from 'react';
import type { TabState, TabStripOrientation } from '../../../shared/types';
import { SessionBadge } from './control/SessionBadge';

interface Props {
  tabs: TabState[];
  activeTabId: number | null;
  orientation: TabStripOrientation;
  canRestoreClosedTab: boolean;
}

/**
 * 탭바. 세로/가로 전환, 드래그 정렬, 고정, 음소거, 유휴 언로드 표시를 담당한다.
 * 드래그는 HTML5 draggable 로 처리한다 — 셸은 우리 페이지라 dataTransfer 를 자유롭게 쓸 수 있다.
 */
export function TabStrip({ tabs, activeTabId, orientation, canRestoreClosedTab }: Props): JSX.Element {
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const vertical = orientation === 'vertical';

  const onDrop = (index: number): void => {
    if (dragId !== null) void window.helm.moveTab(dragId, index);
    setDragId(null);
    setDropIndex(null);
  };

  const tabItems = tabs.map((tab, index) => (
    <TabItem
      key={tab.id}
      tab={tab}
      index={index}
      vertical={vertical}
      active={tab.id === activeTabId}
      dragging={dragId === tab.id}
      dropTarget={dropIndex === index}
      onDragStart={() => setDragId(tab.id)}
      onDragOver={() => setDropIndex(index)}
      onDrop={() => onDrop(index)}
      onDragEnd={() => {
        setDragId(null);
        setDropIndex(null);
      }}
    />
  ));

  if (!vertical) {
    return (
      <div className="flex h-full w-full items-stretch gap-1 overflow-x-auto border-b border-shell-line bg-shell-bg px-2">
        {tabItems}
        <NewTabButton compact />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-r border-shell-line bg-shell-bg">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-shell-accent text-[12px] font-bold text-white">
          H
        </span>
        <span className="text-[13px] font-semibold tracking-tight">Helm</span>
        <button
          type="button"
          aria-label="가로 탭바로 전환"
          title="가로 탭바로 전환 (Ctrl+Shift+E)"
          className="ml-auto grid h-6 w-6 place-items-center rounded text-shell-muted hover:bg-shell-panel hover:text-shell-text"
          onClick={() => void window.helm.setOrientation('horizontal')}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2" y="3" width="12" height="4" rx="1" />
            <rect x="2" y="9" width="12" height="4" rx="1" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {tabItems}
        <NewTabButton />
      </div>

      <div className="shrink-0 border-t border-shell-line px-3 py-2 text-[11px] text-shell-muted">
        <div>탭 {tabs.length}개 · persist:helm</div>
        {canRestoreClosedTab ? (
          <button
            type="button"
            className="mt-1 text-shell-accent hover:underline"
            onClick={() => void window.helm.restoreClosedTab()}
          >
            닫은 탭 복구 (Ctrl+Shift+T)
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface TabItemProps {
  tab: TabState;
  index: number;
  vertical: boolean;
  active: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

function TabItem(props: TabItemProps): JSX.Element {
  const { tab, index, vertical, active, dragging, dropTarget } = props;

  const base = vertical
    ? 'mb-1 flex h-9 w-full items-center gap-2 rounded-md px-2'
    : 'my-1 flex h-7 min-w-[140px] max-w-[220px] items-center gap-2 rounded-md px-2';

  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-index={index}
      data-pinned={tab.pinned}
      title={`${tab.title}\n${tab.url}`}
      draggable
      onDragStart={props.onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        props.onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop();
      }}
      onDragEnd={props.onDragEnd}
      onMouseDown={() => void window.helm.selectTab(tab.id)}
      onAuxClick={(e) => {
        // 가운데 버튼으로 탭 닫기 (크롬 동작)
        if (e.button === 1 && !tab.pinned) void window.helm.closeTab(tab.id);
      }}
      className={[
        base,
        'group cursor-default text-[13px]',
        active ? 'bg-shell-panel text-shell-text' : 'text-shell-muted hover:bg-shell-panel/60 hover:text-shell-text',
        dragging ? 'opacity-40' : '',
        dropTarget ? 'ring-1 ring-shell-accent' : ''
      ].join(' ')}
    >
      <StatusDot tab={tab} active={active} />

      {tab.pinned ? (
        <span aria-label="고정된 탭" title="고정된 탭" className="shrink-0 text-[10px]">
          📌
        </span>
      ) : null}

      <span
        data-tab-title
        className={['min-w-0 truncate', tab.pinned && !vertical ? 'hidden' : 'flex-1'].join(' ')}
      >
        {tab.title}
      </span>

      <SessionBadge sessionName={tab.sessionName} compact={!vertical} />

      {tab.audible || tab.muted ? (
        <button
          type="button"
          aria-label={tab.muted ? `${tab.title} 음소거 해제` : `${tab.title} 음소거`}
          className="shrink-0 text-[10px]"
          onMouseDown={(e) => {
            e.stopPropagation();
            void window.helm.setMuted(tab.id, !tab.muted);
          }}
        >
          {tab.muted ? '🔇' : '🔊'}
        </button>
      ) : null}

      <button
        type="button"
        aria-label={`${tab.title} 탭 ${tab.pinned ? '고정 해제' : '고정'}`}
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-[10px] opacity-0 hover:bg-shell-line group-hover:opacity-100"
        onMouseDown={(e) => {
          e.stopPropagation();
          void window.helm.setPinned(tab.id, !tab.pinned);
        }}
      >
        {tab.pinned ? '↧' : '↥'}
      </button>

      {/* 고정 탭에는 닫기 버튼을 두지 않는다 (크롬 동작) */}
      {tab.pinned ? null : (
        <button
          type="button"
          aria-label={`${tab.title} 탭 닫기`}
          className="grid h-5 w-5 shrink-0 place-items-center rounded opacity-0 hover:bg-shell-line group-hover:opacity-100"
          onMouseDown={(e) => {
            e.stopPropagation();
            void window.helm.closeTab(tab.id);
          }}
        >
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** 로딩·유휴 언로드·활성 상태를 점 하나로 보여준다. */
function StatusDot({ tab, active }: { tab: TabState; active: boolean }): JSX.Element {
  const color = tab.loading
    ? 'bg-shell-accent animate-pulse'
    : tab.suspended
      ? 'bg-amber-500/70'
      : active
        ? 'bg-shell-muted'
        : 'bg-transparent';

  return (
    <span
      aria-label={tab.suspended ? '유휴 언로드됨' : undefined}
      title={tab.suspended ? '유휴 상태로 메모리에서 내려갔습니다. 선택하면 다시 불러옵니다.' : undefined}
      className={['h-1.5 w-1.5 shrink-0 rounded-full', color].join(' ')}
    />
  );
}

function NewTabButton({ compact = false }: { compact?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      aria-label="새 탭"
      title="새 탭 (Ctrl+T)"
      className={[
        'flex items-center gap-2 rounded-md text-[13px] text-shell-muted hover:bg-shell-panel/60 hover:text-shell-text',
        compact ? 'my-1 h-7 shrink-0 px-2' : 'h-9 w-full px-2'
      ].join(' ')}
      onClick={() => void window.helm.createTab()}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
      </svg>
      {compact ? null : '새 탭'}
    </button>
  );
}

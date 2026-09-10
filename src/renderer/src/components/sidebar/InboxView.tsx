import { useEffect, useState } from 'react';
import type { InboxItemView, InboxStateView } from '../../../../shared/types';
import { PanelFrame } from '../panels/PanelFrame';

/**
 * 받은편지함 — 결과와 요청이 모이는 곳.
 *
 * 장시간·헤드리스 작업의 출력은 화면이 아니다. 사람이 자리에 없는 동안 쌓이고, 돌아와서
 * 읽지 않은 것만 보면 된다. 그래서 미읽음이 기본 필터고, 읽음 표시는 명시적인 동작이다
 * (열었다는 이유로 읽음이 되면 "아직 안 본 것" 이라는 정보가 사라진다).
 */

const KIND_LABEL: Record<InboxItemView['kind'], string> = {
  result: '결과',
  approval: '승인 요청',
  login_required: '로그인 필요',
  done: '완료',
  failed: '실패'
};

const KIND_STYLE: Record<InboxItemView['kind'], string> = {
  result: 'bg-shell-line text-shell-muted',
  approval: 'bg-amber-500/20 text-amber-500',
  login_required: 'bg-amber-500/20 text-amber-500',
  done: 'bg-shell-accent/15 text-shell-accent',
  failed: 'bg-red-500/15 text-red-400'
};

export function InboxView(): JSX.Element {
  const [state, setState] = useState<InboxStateView>({ unread: 0, items: [] });
  const [unreadOnly, setUnreadOnly] = useState(false);

  useEffect(() => {
    const off = window.helm.onInboxChanged(setState);
    void window.helm.getInbox().then(setState);
    return off;
  }, []);

  const items = unreadOnly ? state.items.filter((item) => item.readAt === null) : state.items;

  return (
    <PanelFrame
      title="받은편지함"
      count={state.unread}
      actions={
        <>
          <label className="flex items-center gap-1 text-[12px] text-shell-muted">
            <input
              type="checkbox"
              data-inbox-unread-only
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
            />
            안 읽은 것만
          </label>
          <button
            type="button"
            data-inbox-read-all
            className="h-7 rounded border border-shell-line px-2 text-[12px] text-shell-muted hover:text-shell-text disabled:opacity-40"
            disabled={state.unread === 0}
            onClick={() => void window.helm.markInboxAllRead()}
          >
            모두 읽음
          </button>
        </>
      }
    >
      {items.length === 0 ? (
        <p className="p-6 text-[13px] text-shell-muted">
          {unreadOnly ? '안 읽은 항목이 없습니다.' : '받은 항목이 없습니다.'}
        </p>
      ) : (
        <ul data-inbox-count={items.length} className="divide-y divide-shell-line">
          {items.map((item) => (
            <li
              key={item.id}
              data-inbox-id={item.id}
              data-inbox-kind={item.kind}
              data-inbox-unread={item.readAt === null}
              className="flex items-start gap-3 px-4 py-2 text-[13px]"
            >
              <span
                className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] ${KIND_STYLE[item.kind]}`}
              >
                {KIND_LABEL[item.kind]}
              </span>

              <span className="min-w-0 flex-1">
                <span className={item.readAt === null ? 'font-semibold' : ''}>{item.title}</span>
                {item.summary ? (
                  <span className="mt-0.5 block text-[12px] text-shell-muted">{item.summary}</span>
                ) : null}
                <span className="mt-0.5 block text-[11px] text-shell-muted">
                  {new Date(item.createdAt).toLocaleString('ko-KR')}
                  {item.threadId ? ` · ${item.threadId}` : ''}
                  {item.evidencePath ? ` · ${item.evidencePath}` : ''}
                </span>
              </span>

              {item.readAt === null ? (
                <button
                  type="button"
                  data-inbox-read={item.id}
                  className="h-6 shrink-0 rounded border border-shell-line px-2 text-[11px] text-shell-muted hover:text-shell-text"
                  onClick={() => void window.helm.markInboxRead(item.id)}
                >
                  읽음
                </button>
              ) : null}

              <button
                type="button"
                data-inbox-remove={item.id}
                aria-label={`${item.title} 삭제`}
                className="h-6 shrink-0 rounded border border-shell-line px-2 text-[11px] text-shell-muted hover:text-shell-text"
                onClick={() => void window.helm.removeInboxItem(item.id)}
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

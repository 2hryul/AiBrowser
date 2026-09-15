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

/**
 * 로그인 획득 경로 3종(M4c). 선택은 사람이 한다 — AI 는 "로그인이 필요하다" 까지만 알리고,
 * 어떤 경로로 로그인할지는 이 카드의 버튼이 유일한 입구다.
 */
const LOGIN_METHODS = [
  ['inapp', '앱에서 로그인'],
  ['oauth_modal', 'OAuth 모달'],
  ['external', '외부 브라우저']
] as const;

/** login_required 항목의 요약에는 밀려난 주소가 들어 있다. 거기서 로그인 대상 주소를 읽는다. */
const URL_IN_TEXT = /((?:app|https?):\/\/[^\s"'<>)\]]+)/;

function loginUrlOf(item: InboxItemView): string | null {
  return URL_IN_TEXT.exec(`${item.summary} ${item.title}`)?.[1] ?? null;
}

export function InboxView(): JSX.Element {
  const [state, setState] = useState<InboxStateView>({ unread: 0, items: [] });
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loginBusy, setLoginBusy] = useState<number | null>(null);
  const [loginNotes, setLoginNotes] = useState<Record<number, string>>({});

  const startLogin = (item: InboxItemView, method: (typeof LOGIN_METHODS)[number][0]): void => {
    const url = loginUrlOf(item);
    if (url === null || loginBusy !== null) return;

    setLoginBusy(item.id);
    void window.helm
      .loginStart(url, method)
      .then(async (result) => {
        if (result?.status === 'logged_in') {
          // 로그인이 섰으면 스레드를 마지막 체크포인트에서 이어간다(M4a 연동).
          if (item.threadId) await window.helm.resumeThread(item.threadId);
          await window.helm.markInboxRead(item.id);
          setLoginNotes((notes) => ({ ...notes, [item.id]: '로그인됨 — 스레드를 이어갑니다' }));
        } else {
          setLoginNotes((notes) => ({
            ...notes,
            [item.id]: result?.reason ?? '로그인에 실패했습니다'
          }));
        }
      })
      .finally(() => setLoginBusy(null));
  };

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

                {/* 로그인 필요 카드 — 경로 선택 버튼(M4c). 읽음 처리 전까지만 보인다. */}
                {item.kind === 'login_required' &&
                item.readAt === null &&
                loginUrlOf(item) !== null ? (
                  <span data-login-card={item.id} className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {LOGIN_METHODS.map(([method, label]) => (
                      <button
                        key={method}
                        type="button"
                        data-login-method={method}
                        disabled={loginBusy !== null}
                        className="h-6 rounded border border-shell-line px-2 text-[11px] text-shell-muted hover:text-shell-text disabled:opacity-40"
                        onClick={() => startLogin(item, method)}
                      >
                        {loginBusy === item.id ? '로그인 대기…' : label}
                      </button>
                    ))}
                    {loginNotes[item.id] ? (
                      <span data-login-note className="text-[11px] text-shell-muted">
                        {loginNotes[item.id]}
                      </span>
                    ) : null}
                  </span>
                ) : null}
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

import { useEffect, useState } from 'react';
import type { SessionStateView, TabState } from '../../../../shared/types';
import { PanelFrame } from './PanelFrame';

interface Props {
  tabs: TabState[];
}

/**
 * 이름 붙인 세션 — 쿠키·localStorage 묶음.
 *
 * 세션을 바꾸면 **다음에 만드는 탭**이 그 파티션에서 열린다. 이미 열린 탭은 그대로다 —
 * 보고 있는 화면의 계정이 뒤에서 바뀌는 것이 가장 위험하다. 그래서 "지금 세션" 과
 * "각 탭의 세션" 을 따로 보여 준다.
 *
 * 로그인 경로·시각은 표시하지만 비밀번호·토큰은 애초에 저장하지 않는다(불변 조건 9).
 */
export function SessionsPanel({ tabs }: Props): JSX.Element {
  const [state, setState] = useState<SessionStateView>({ current: 'default', sessions: [] });
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const load = (): void => {
    void window.helm.getSessions().then(setState);
  };

  useEffect(() => {
    const off = window.helm.onSessionsChanged(setState);
    load();
    return off;
  }, []);

  const use = (name: string): void => {
    void window.helm.useSession(name).then((info) => {
      if (!info) {
        setMessage(`쓸 수 없는 이름입니다: ${name} (소문자·숫자·-·_ 로 시작, 32자 이내)`);
        return;
      }
      setMessage(`다음에 만드는 탭은 "${info.name}" 세션에서 열립니다 (${info.partition})`);
      setDraft('');
      load();
    });
  };

  return (
    <PanelFrame
      title="세션"
      count={state.sessions.length}
      actions={
        <>
          <input
            data-session-input
            placeholder="새 세션 이름 (itsm, gw …)"
            className="h-7 w-[180px] rounded border border-shell-line bg-shell-panel px-2 text-[12px] outline-none focus:border-shell-accent"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim() !== '') use(draft.trim());
            }}
          />
          <button
            type="button"
            data-session-create
            className="h-7 rounded border border-shell-line px-2 text-[12px] text-shell-muted hover:text-shell-text disabled:opacity-40"
            disabled={draft.trim() === ''}
            onClick={() => use(draft.trim())}
          >
            만들고 쓰기
          </button>
        </>
      }
    >
      {message ? (
        <p
          data-session-message
          className="border-b border-shell-line bg-shell-panel px-4 py-2 text-[12px] break-all"
        >
          {message}
        </p>
      ) : null}

      <ul data-session-count={state.sessions.length} className="divide-y divide-shell-line">
        {state.sessions.map((info) => {
          const openTabs = tabs.filter((tab) => tab.sessionName === info.name);

          return (
            <li
              key={info.name}
              data-session-name={info.name}
              data-session-current={info.name === state.current}
              className="flex items-center gap-3 px-4 py-2 text-[13px]"
            >
              <span className="w-32 shrink-0 font-medium">
                {info.name}
                {info.name === state.current ? (
                  <span className="ml-1 rounded bg-shell-accent/15 px-1 text-[10px] text-shell-accent">
                    지금
                  </span>
                ) : null}
              </span>

              <span className="w-48 shrink-0 text-[11px] text-shell-muted">{info.partition}</span>

              <span className="w-24 shrink-0 text-[11px] text-shell-muted">
                탭 {openTabs.length}개
              </span>

              <span className="min-w-0 flex-1 text-[11px] text-shell-muted">
                {info.loginMethod
                  ? `로그인 ${info.loginMethod} · ${new Date(info.loggedInAt ?? 0).toLocaleString('ko-KR')}`
                  : '로그인 기록 없음'}
              </span>

              {info.name === state.current ? null : (
                <button
                  type="button"
                  data-session-use={info.name}
                  className="h-6 shrink-0 rounded border border-shell-line px-2 text-[11px] text-shell-muted hover:text-shell-text"
                  onClick={() => use(info.name)}
                >
                  이 세션 쓰기
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <p className="px-4 py-3 text-[11px] text-shell-muted">
        세션을 바꿔도 이미 열린 탭은 그대로입니다. 비밀번호·토큰은 저장하지 않습니다 — 각 사이트에서
        한 번 로그인하면 그 세션에 유지됩니다.
      </p>
    </PanelFrame>
  );
}

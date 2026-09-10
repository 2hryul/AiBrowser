import { useEffect, useState } from 'react';
import type { NoteStateView } from '../../../../shared/types';
import { PanelFrame } from '../panels/PanelFrame';

/**
 * 메모 — `thread:<id>` 와 `site:<host>` 두 범위.
 *
 * `site:` 메모는 다음에 그 사이트를 다룰 때 에이전트 프롬프트에 자동으로 실린다. 그래서
 * 여기 적는 것은 "다음 번 AI 에게 주는 쪽지" 다 — 자격증명·개인정보가 들어가면 거부되고,
 * 왜 거부됐는지 화면에 나온다(조용히 저장 안 되는 것이 최악이다).
 */

const REASON_LABEL: Record<string, string> = {
  scope: '범위 형식이 잘못됐습니다',
  credential: '자격증명으로 보이는 값이 있어 저장하지 않았습니다',
  pii: '개인정보로 보이는 값이 있어 저장하지 않았습니다'
};

export function NotesPanel(): JSX.Element {
  const [scopes, setScopes] = useState<string[]>([]);
  const [scope, setScope] = useState('');
  const [state, setState] = useState<NoteStateView | null>(null);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);

  const loadScopes = (): void => {
    void window.helm.getNoteScopes().then((list) => {
      setScopes(list);
      setScope((current) => (current === '' ? list[0] ?? '' : current));
    });
  };

  const loadNote = (target: string): void => {
    if (target === '') {
      setState(null);
      return;
    }
    void window.helm.getNote(target).then(setState);
  };

  useEffect(loadScopes, []);
  useEffect(() => loadNote(scope), [scope]);

  const append = (): void => {
    if (scope.trim() === '' || draft.trim() === '') return;

    void window.helm.appendNote(scope, draft).then((result) => {
      if (result.ok) {
        setDraft('');
        setRejected(false);
        setMessage(
          result.truncated
            ? '저장했습니다. 2KB 상한을 넘어 오래된 앞부분이 잘렸습니다.'
            : '저장했습니다.'
        );
        loadScopes();
        loadNote(scope);
        return;
      }

      setRejected(true);
      setMessage(
        `${REASON_LABEL[result.reason] ?? result.message}${
          result.matches && result.matches.length > 0 ? ` (${result.matches.join(', ')})` : ''
        }`
      );
    });
  };

  return (
    <PanelFrame
      title="메모"
      count={scopes.length}
      actions={
        <input
          data-note-scope-input
          placeholder="site:portal-a 또는 thread:t-1"
          className="h-7 w-[240px] rounded border border-shell-line bg-shell-panel px-2 text-[12px] outline-none focus:border-shell-accent"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        />
      }
    >
      <div className="flex h-full min-h-0">
        <ul
          data-note-scope-count={scopes.length}
          className="min-h-0 w-[220px] shrink-0 overflow-y-auto border-r border-shell-line text-[12px]"
        >
          {scopes.length === 0 ? (
            <li className="p-4 text-shell-muted">메모가 없습니다.</li>
          ) : (
            scopes.map((item) => (
              <li key={item}>
                <button
                  type="button"
                  data-note-scope={item}
                  aria-current={item === scope}
                  className={[
                    'w-full truncate px-3 py-2 text-left',
                    item === scope ? 'bg-shell-panel' : 'hover:bg-shell-panel/60'
                  ].join(' ')}
                  onClick={() => setScope(item)}
                >
                  {item}
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="flex min-h-0 flex-1 flex-col">
          {message ? (
            <p
              data-note-message
              data-note-rejected={rejected}
              className={[
                'shrink-0 border-b border-shell-line px-4 py-2 text-[12px]',
                rejected ? 'bg-red-500/10 text-red-400' : 'bg-shell-panel'
              ].join(' ')}
            >
              {message}
            </p>
          ) : null}

          <pre
            data-note-text
            className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-all px-4 py-3 text-[12px]"
          >
            {state?.note?.text ?? '(비어 있음)'}
          </pre>

          {state && state.history.length > 0 ? (
            <div
              data-note-versions={state.history.length}
              className="shrink-0 border-t border-shell-line px-4 py-2 text-[11px] text-shell-muted"
            >
              버전{' '}
              {state.history.map((version) => (
                <button
                  key={version.version}
                  type="button"
                  data-note-restore={version.version}
                  title={`v${version.version} 로 되돌리기`}
                  className="mr-1 rounded border border-shell-line px-1.5 hover:text-shell-text"
                  onClick={() => {
                    void window.helm.restoreNote(scope, version.version).then((result) => {
                      setMessage(
                        result.ok ? `v${version.version} 내용으로 되돌렸습니다.` : result.message
                      );
                      setRejected(!result.ok);
                      loadNote(scope);
                    });
                  }}
                >
                  v{version.version}
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex shrink-0 items-center gap-2 border-t border-shell-line px-4 py-2">
            <input
              data-note-input
              placeholder="이 사이트를 다룰 때의 요령을 적어 두면 다음 작업이 참고합니다"
              className="h-8 min-w-0 flex-1 rounded border border-shell-line bg-shell-panel px-2 text-[12px] outline-none focus:border-shell-accent"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') append();
              }}
            />
            <button
              type="button"
              data-note-append
              className="h-8 rounded bg-shell-accent px-3 text-[12px] text-white hover:opacity-90 disabled:opacity-40"
              disabled={draft.trim() === '' || scope.trim() === ''}
              onClick={append}
            >
              덧붙이기
            </button>
          </div>
        </div>
      </div>
    </PanelFrame>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { TabState } from '../../../shared/types';
import { useShellStore } from '../store';

interface Props {
  tab: TabState | null;
}

export function Omnibox({ tab }: Props): JSX.Element {
  const draft = useShellStore((s) => s.omniboxDraft);
  const error = useShellStore((s) => s.omniboxError);
  const setDraft = useShellStore((s) => s.setDraft);
  const setError = useShellStore((s) => s.setError);
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  // Ctrl+L: 메인이 보낸 포커스 요청을 받아 주소창 전체를 선택한다.
  useEffect(() => {
    return window.helm.onFocusOmnibox(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const value = draft ?? tab?.url ?? '';

  const submit = (): void => {
    if (!tab || draft === null) return;
    void window.helm.navigate(tab.id, draft).then((ok) => {
      if (!ok) setError(true);
      else inputRef.current?.blur();
    });
  };

  return (
    <div
      className={[
        'flex h-8 flex-1 items-center gap-2 rounded-md border px-3 text-[13px]',
        error
          ? 'border-red-500/70 bg-red-500/10'
          : focused
            ? 'border-shell-accent bg-shell-bg'
            : 'border-shell-line bg-shell-panel'
      ].join(' ')}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-shell-muted" fill="currentColor">
        <path d="M8 1a4 4 0 0 0-4 4v1H3.5A1.5 1.5 0 0 0 2 7.5v6A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12.5 6H12V5a4 4 0 0 0-4-4Zm2.5 5h-5V5a2.5 2.5 0 0 1 5 0v1Z" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        spellCheck={false}
        aria-label="주소창"
        placeholder="주소 입력 (예: app://home/)"
        className="min-w-0 flex-1 bg-transparent text-shell-text outline-none placeholder:text-shell-muted"
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setFocused(false);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') {
            setDraft(null);
            inputRef.current?.blur();
          }
        }}
      />
      {tab ? (
        <span className="shrink-0 rounded bg-shell-line px-1.5 py-0.5 text-[10px] text-shell-muted">
          {tab.sessionName}
        </span>
      ) : null}
    </div>
  );
}

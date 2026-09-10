import { useEffect, useRef, useState } from 'react';
import type { OmniboxSuggestion, TabState } from '../../../shared/types';
import { useShellStore } from '../store';

interface Props {
  tab: TabState | null;
}

const KIND_ICON: Record<OmniboxSuggestion['kind'], string> = {
  url: '↵',
  bookmark: '★',
  history: '🕘',
  search: '🔍'
};

const KIND_LABEL: Record<OmniboxSuggestion['kind'], string> = {
  url: '주소',
  bookmark: '북마크',
  history: '방문 기록',
  search: '검색'
};

export function Omnibox({ tab }: Props): JSX.Element {
  const draft = useShellStore((s) => s.omniboxDraft);
  const error = useShellStore((s) => s.omniboxError);
  const suggestions = useShellStore((s) => s.suggestions);
  const suggestionIndex = useShellStore((s) => s.suggestionIndex);
  const setDraft = useShellStore((s) => s.setDraft);
  const setError = useShellStore((s) => s.setError);
  const setSuggestions = useShellStore((s) => s.setSuggestions);
  const moveSuggestion = useShellStore((s) => s.moveSuggestion);
  const resetOmnibox = useShellStore((s) => s.resetOmnibox);

  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  // Ctrl+L: 메인이 보낸 포커스 요청을 받아 주소창 전체를 선택한다.
  useEffect(() => {
    return window.helm.onFocusOmnibox(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  // 타이핑할 때마다 제안을 다시 받는다. 마지막 요청 결과만 반영해 순서가 뒤집히지 않게 한다.
  useEffect(() => {
    if (draft === null || draft.trim() === '') {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void window.helm.suggest(draft).then((result) => {
        if (!cancelled) setSuggestions(result);
      });
    }, 60);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, setSuggestions]);

  const value = draft ?? tab?.url ?? '';
  const open = focused && draft !== null && suggestions.length > 0;

  const go = (target: string): void => {
    if (!tab) return;
    void window.helm.navigate(tab.id, target).then((ok) => {
      if (!ok) {
        setError(true);
        return;
      }
      resetOmnibox();
      inputRef.current?.blur();
    });
  };

  const submit = (): void => {
    if (draft === null) return;
    const picked = suggestionIndex >= 0 ? suggestions[suggestionIndex] : null;
    go(picked ? picked.url : draft);
  };

  return (
    <div className="relative flex-1">
      <div
        className={[
          'flex h-8 items-center gap-2 rounded-md border px-3 text-[13px]',
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
          role="combobox"
          aria-expanded={open}
          aria-controls="omnibox-suggestions"
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
            // 제안 클릭이 blur 보다 먼저 처리되도록 초안 정리는 다음 틱에 한다.
            setTimeout(() => setDraft(null), 120);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              moveSuggestion(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              moveSuggestion(-1);
            } else if (e.key === 'Escape') {
              resetOmnibox();
              inputRef.current?.blur();
            }
          }}
        />

        {tab && tab.zoomFactor !== 1 ? (
          <button
            type="button"
            title="확대 배율 초기화 (Ctrl+0)"
            aria-label="확대 배율 초기화"
            className="shrink-0 rounded bg-shell-line px-1.5 py-0.5 text-[10px] text-shell-text"
            onClick={() => void window.helm.setZoom(1)}
          >
            {Math.round(tab.zoomFactor * 100)}%
          </button>
        ) : null}

        {tab ? (
          <span className="shrink-0 rounded bg-shell-line px-1.5 py-0.5 text-[10px] text-shell-muted">
            {tab.sessionName}
          </span>
        ) : null}
      </div>

      {open ? (
        <ul
          id="omnibox-suggestions"
          role="listbox"
          className="absolute left-0 right-0 top-9 z-20 overflow-hidden rounded-md border border-shell-line bg-shell-panel shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={`${suggestion.kind}:${suggestion.url}`}
              role="option"
              aria-selected={index === suggestionIndex}
              data-suggestion-rank={index}
              className={[
                'flex cursor-default items-center gap-2 px-3 py-1.5 text-[13px]',
                index === suggestionIndex ? 'bg-shell-accent/20' : 'hover:bg-shell-bg/60'
              ].join(' ')}
              onMouseDown={(e) => {
                e.preventDefault();
                go(suggestion.url);
              }}
            >
              <span aria-hidden className="w-4 shrink-0 text-center text-[11px] text-shell-muted">
                {KIND_ICON[suggestion.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate">{suggestion.primary}</span>
              <span className="max-w-[45%] shrink-0 truncate text-[11px] text-shell-muted">
                {suggestion.secondary}
              </span>
              <span className="sr-only">{KIND_LABEL[suggestion.kind]}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

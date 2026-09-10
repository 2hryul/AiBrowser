import { useEffect, useRef, useState } from 'react';
import type { FindState } from '../../../shared/types';

interface Props {
  find: FindState;
}

/** 페이지 내 찾기 바. 일치 수와 현재 위치를 보여준다. */
export function FindBar({ find }: Props): JSX.Element {
  const [query, setQuery] = useState(find.query);
  const inputRef = useRef<HTMLInputElement>(null);

  // 찾기바가 뜨는 순간 바로 입력할 수 있게 한다(Ctrl+F 흐름).
  useEffect(() => {
    const focus = (): void => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    focus();
    // 이미 열려 있는 상태에서 Ctrl+F 를 다시 눌렀을 때도 입력란으로 포커스를 돌린다.
    return window.helm.onFocusFindBar(focus);
  }, []);

  /** advance=true 는 "이미 연 검색 세션에서 다음/이전 일치로 이동". 새 검색은 false. */
  const search = (advance: boolean, forward = true): void => {
    void window.helm.find(query, advance, forward);
  };

  const buttonClass =
    'grid h-6 w-6 place-items-center rounded text-shell-muted enabled:hover:bg-shell-panel ' +
    'enabled:hover:text-shell-text disabled:opacity-30';

  return (
    <div
      role="search"
      aria-label="페이지에서 찾기"
      className="flex h-full w-full items-center gap-2 border-b border-shell-line bg-shell-bg px-3"
    >
      <input
        ref={inputRef}
        type="text"
        aria-label="찾을 내용"
        placeholder="페이지에서 찾기"
        className="h-7 w-64 rounded border border-shell-line bg-shell-panel px-2 text-[13px] text-shell-text outline-none focus:border-shell-accent"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          void window.helm.find(e.target.value, false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            search(true, !e.shiftKey);
          } else if (e.key === 'Escape') {
            void window.helm.stopFind();
          }
        }}
      />

      <span
        data-find-matches={find.matches}
        className={[
          'min-w-[72px] text-[12px]',
          find.query !== '' && find.matches === 0 ? 'text-red-400' : 'text-shell-muted'
        ].join(' ')}
      >
        {find.query === ''
          ? ''
          : find.matches === 0
            ? '결과 없음'
            : `${find.activeMatchOrdinal}/${find.matches}`}
      </span>

      <button
        type="button"
        aria-label="이전 일치"
        className={buttonClass}
        disabled={find.matches === 0}
        onClick={() => search(true, false)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="다음 일치"
        className={buttonClass}
        disabled={find.matches === 0}
        onClick={() => search(true, true)}
      >
        ↓
      </button>
      <button
        type="button"
        aria-label="찾기 닫기"
        className={`${buttonClass} ml-auto`}
        onClick={() => void window.helm.stopFind()}
      >
        ✕
      </button>
    </div>
  );
}

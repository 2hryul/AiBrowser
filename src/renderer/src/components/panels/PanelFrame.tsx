import type { ReactNode } from 'react';

interface Props {
  title: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * 내부 화면(히스토리·다운로드·북마크·읽기 모드)의 공통 껍데기.
 *
 * 이 화면들은 웹 페이지가 아니라 브라우저 크롬의 일부다 — 셸이 그린다(ADR 0005).
 * 웹 콘텐츠 뷰에 preload 를 붙이지 않는다는 보안 기본값을 지키려면 이 방식이어야 한다.
 */
export function PanelFrame({ title, count, actions, children }: Props): JSX.Element {
  return (
    <section
      role="region"
      aria-label={title}
      className="flex h-full w-full flex-col bg-shell-bg"
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-shell-line px-4">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {typeof count === 'number' ? (
          <span className="rounded bg-shell-line px-1.5 py-0.5 text-[11px] text-shell-muted">
            {count}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">{actions}</div>
        <button
          type="button"
          aria-label={`${title} 닫기`}
          className="grid h-7 w-7 place-items-center rounded text-shell-muted hover:bg-shell-panel hover:text-shell-text"
          onClick={() => void window.helm.openPanel('none')}
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

import type { TabState } from '../../../shared/types';

interface Props {
  tab: TabState | null;
}

const buttonClass =
  'grid h-8 w-8 place-items-center rounded-md text-shell-muted transition-colors ' +
  'enabled:hover:bg-shell-panel enabled:hover:text-shell-text disabled:opacity-30';

export function NavButtons({ tab }: Props): JSX.Element {
  const id = tab?.id ?? null;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="뒤로"
        title="뒤로 (Alt+←)"
        className={buttonClass}
        disabled={!tab?.canGoBack}
        onClick={() => id !== null && void window.helm.goBack(id)}
      >
        <Chevron direction="left" />
      </button>
      <button
        type="button"
        aria-label="앞으로"
        title="앞으로 (Alt+→)"
        className={buttonClass}
        disabled={!tab?.canGoForward}
        onClick={() => id !== null && void window.helm.goForward(id)}
      >
        <Chevron direction="right" />
      </button>
      <button
        type="button"
        aria-label="새로고침"
        title="새로고침 (F5)"
        className={buttonClass}
        disabled={!tab}
        onClick={() => id !== null && void window.helm.reload(id)}
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.16" strokeLinecap="round" />
          <path d="M13.5 1.5V4H11" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

function Chevron({ direction }: { direction: 'left' | 'right' }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d={direction === 'left' ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

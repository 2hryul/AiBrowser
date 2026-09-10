import type { AiState } from '../../../../shared/types';

interface Props {
  ai: AiState;
}

/**
 * 사람이 AI 소유 탭을 건드리면 뜨는 띠.
 *
 * 불변 조건 3: 사람이 우선권을 가진다. "이어서" 는 호출자에게 개입 사실을 알리고 계속하고,
 * "여기까지" 는 스레드를 끝내고 탭 소유권을 사람에게 넘긴다.
 */
export function PauseResumeBar({ ai }: Props): JSX.Element {
  return (
    <div
      role="alert"
      aria-label="AI 작업 일시정지"
      data-ai-status={ai.status}
      className="flex h-full w-full items-center gap-3 border-b border-amber-500/40 bg-amber-500/15 px-3 text-[13px]"
    >
      <span aria-hidden className="text-[14px]">
        ⏸
      </span>
      <span className="font-medium">AI 작업을 멈췄습니다</span>
      <span className="min-w-0 flex-1 truncate text-shell-muted">
        {ai.pauseReason ?? '사람이 개입했습니다'}
        {ai.pausedTabId !== null ? ` · 탭 ${ai.pausedTabId}` : ''}
      </span>

      <button
        type="button"
        data-ai-resume
        className="h-7 rounded bg-shell-accent px-3 text-white hover:opacity-90"
        onClick={() => void window.helm.resumeAi()}
      >
        이어서
      </button>
      <button
        type="button"
        data-ai-takeover
        className="h-7 rounded border border-shell-line px-3 hover:bg-shell-panel"
        onClick={() => void window.helm.takeOverAi()}
      >
        여기까지
      </button>
    </div>
  );
}

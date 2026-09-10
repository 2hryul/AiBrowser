import { useEffect, useRef, useState } from 'react';
import type { PendingPrompt } from '../../../../shared/types';

interface Props {
  prompt: PendingPrompt;
  onAnswered: (id: string) => void;
}

/**
 * ask_user / request_access 다이얼로그.
 *
 * AI 가 진행할 수 없는 지점(로그인·캡차·판단)과 아직 허용되지 않은 도메인 접근을 사람에게 묻는다.
 * M2 는 묻고 답을 전달하는 것까지다 — 승인 범위(once/thread/domain)와 기록은 M3 다.
 */
export function PromptDialog({ prompt, onAnswered }: Props): JSX.Element {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [prompt.id]);

  const answer = (value: string): void => {
    void window.helm.answerPrompt(prompt.id, value).then(() => onAnswered(prompt.id));
  };

  const isAccess = prompt.kind === 'request_access';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isAccess ? '도메인 접근 요청' : 'AI 질문'}
      data-prompt-kind={prompt.kind}
      data-prompt-id={prompt.id}
      className="absolute inset-0 z-30 grid place-items-center bg-black/40 p-6"
    >
      <div className="w-full max-w-[520px] rounded-lg border border-shell-line bg-shell-bg p-5 shadow-xl">
        <h2 className="mb-1 text-[15px] font-semibold">
          {isAccess ? `${prompt.host ?? ''} 접근 허용?` : 'AI 가 묻습니다'}
        </h2>

        <p className="mb-4 whitespace-pre-line text-[13px] text-shell-muted">{prompt.question}</p>

        {prompt.options.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {prompt.options.map((option) => (
              <button
                key={option}
                type="button"
                data-prompt-option={option}
                className="h-8 rounded bg-shell-accent px-3 text-[13px] text-white hover:opacity-90"
                onClick={() => answer(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              aria-label="답변"
              data-prompt-input
              className="h-8 min-w-0 flex-1 rounded border border-shell-line bg-shell-panel px-2 text-[13px] outline-none focus:border-shell-accent"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') answer(text);
              }}
            />
            <button
              type="button"
              data-prompt-submit
              className="h-8 rounded bg-shell-accent px-3 text-[13px] text-white hover:opacity-90"
              onClick={() => answer(text)}
            >
              보내기
            </button>
          </div>
        )}

        {isAccess ? (
          <p className="mt-3 text-[11px] text-shell-muted">
            이번 한 번만 허용됩니다. 범위 있는 승인(이 스레드 / 이 도메인 항상)은 다음 단계에서 붙습니다.
          </p>
        ) : null}
      </div>
    </div>
  );
}

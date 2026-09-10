import type { ApprovalRequestView, GrantScope } from '../../../../shared/types';

interface Props {
  request: ApprovalRequestView;
  /** 잠금 상태에서는 thread·domain 범위를 남길 수 없다. */
  locked: boolean;
  onAnswered: (id: string) => void;
}

/** 되돌릴 수 없는 작업의 고정 문구. 메인의 IRREVERSIBLE_NOTICE 와 같은 문장이다. */
const IRREVERSIBLE_NOTICE = '이 작업은 되돌릴 수 없습니다';

const ACTION_LABEL: Record<ApprovalRequestView['action'], string> = {
  write_click: '쓰기 동작 클릭',
  form_submit: '폼 제출',
  download: '파일 내려받기',
  upload: '파일 올리기',
  javascript: '스크립트 실행',
  site_first_visit: '사이트 첫 접근',
  tool: '도구 실행'
};

const SCOPE_LABEL: Record<GrantScope, string> = {
  once: '이번 한 번',
  thread: '이 작업 동안',
  domain: '이 도메인에서 항상'
};

const SCOPE_HINT: Record<GrantScope, string> = {
  once: '이 호출에만 적용됩니다',
  thread: '지금 진행 중인 작업이 끝나면 사라집니다',
  domain: '설정에서 회수할 때까지 유지됩니다'
};

/**
 * 승인 다이얼로그 — 3단계 범위.
 *
 * "묻지 않기" 같은 자동 승인 선택지는 없다(GOAL-M3 FIXED DECISIONS). 사람이 범위를 고르는 것이
 * 유일한 확장 경로이고, 그 선택은 정책 파일에 시각과 함께 기록된다.
 */
export function ApprovalDialog({ request, locked, onAnswered }: Props): JSX.Element {
  const answer = (scope: GrantScope | null): void => {
    void window.helm.answerApproval(request.id, scope).then(() => onAnswered(request.id));
  };

  const scopes: GrantScope[] = locked ? ['once'] : ['once', 'thread', 'domain'];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="승인 요청"
      data-approval-id={request.id}
      data-approval-action={request.action}
      data-approval-irreversible={request.irreversible}
      className="absolute inset-0 z-40 grid place-items-center bg-black/50 p-6"
    >
      <div className="w-full max-w-[560px] rounded-lg border border-shell-line bg-shell-bg p-5 shadow-xl">
        <div className="mb-1 flex items-center gap-2">
          <span aria-hidden className="text-[15px]">
            🔐
          </span>
          <h2 className="text-[15px] font-semibold">승인이 필요합니다</h2>
          <span className="ml-auto rounded bg-shell-line px-1.5 py-0.5 text-[11px] text-shell-muted">
            {ACTION_LABEL[request.action]}
          </span>
        </div>

        <p className="mb-3 text-[13px]">{request.reason}</p>

        <dl className="mb-4 grid grid-cols-[80px_1fr] gap-y-1 text-[12px]">
          <dt className="text-shell-muted">도구</dt>
          <dd data-approval-tool>{request.tool}</dd>
          <dt className="text-shell-muted">사이트</dt>
          <dd data-approval-host>{request.host}</dd>
          {request.targetText ? (
            <>
              <dt className="text-shell-muted">대상</dt>
              <dd data-approval-target className="truncate">
                {request.targetText}
              </dd>
            </>
          ) : null}
        </dl>

        {request.irreversible ? (
          <p
            data-approval-notice
            className="mb-4 rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-[12px] font-medium text-red-400"
          >
            ⚠ {IRREVERSIBLE_NOTICE}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {scopes.map((scope) => (
            <button
              key={scope}
              type="button"
              data-approval-scope={scope}
              title={SCOPE_HINT[scope]}
              className="h-8 rounded bg-shell-accent px-3 text-[13px] text-white hover:opacity-90"
              onClick={() => answer(scope)}
            >
              {SCOPE_LABEL[scope]}
            </button>
          ))}

          <button
            type="button"
            data-approval-deny
            className="ml-auto h-8 rounded border border-shell-line px-3 text-[13px] hover:bg-shell-panel"
            onClick={() => answer(null)}
          >
            거부
          </button>
        </div>

        {locked ? (
          <p className="mt-3 text-[11px] text-shell-muted">
            관리자 잠금 상태입니다. 범위 있는 승인(이 작업 동안 / 이 도메인에서 항상)은 남길 수 없습니다.
          </p>
        ) : null}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { AuditEntryView } from '../../../../shared/types';
import { PanelFrame } from '../panels/PanelFrame';

/**
 * 감사 로그 재생 — AI 가 무엇을 했는지 단계별로 되짚는다.
 *
 * 타임라인에서 단계를 고르면 그때의 화면(스크린샷)과 판정 결과를 보여주고,
 * 그 단계의 URL 을 새 탭으로 열 수 있다. 스크린샷은 이미 마스킹된 이미지다.
 */
const DECISION_LABEL: Record<AuditEntryView['policyDecision'], string> = {
  allow: '허용',
  ask: '승인',
  deny: '거부'
};

const DECISION_STYLE: Record<AuditEntryView['policyDecision'], string> = {
  allow: 'text-shell-muted',
  ask: 'text-amber-500',
  deny: 'text-red-400'
};

export function StepLogPlayer(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntryView[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  const load = (): void => {
    void window.helm.readAudit().then((payload) => {
      setEntries(payload.entries);
      setFile(payload.file);
    });
  };

  useEffect(load, []);

  const current = entries[selected] ?? null;

  return (
    <PanelFrame
      title="단계 로그"
      count={entries.length}
      actions={
        <button
          type="button"
          data-audit-reload
          className="h-7 rounded border border-shell-line px-2 text-[12px] text-shell-muted hover:text-shell-text"
          onClick={load}
        >
          새로 읽기
        </button>
      }
    >
      {entries.length === 0 ? (
        <p className="p-6 text-[13px] text-shell-muted">기록된 단계가 없습니다.</p>
      ) : (
        <div className="flex h-full min-h-0">
          {/* 타임라인 */}
          <ul
            data-audit-count={entries.length}
            className="min-h-0 w-[320px] shrink-0 overflow-y-auto border-r border-shell-line"
          >
            {entries.map((entry, index) => (
              <li key={`${entry.ts}-${index}`}>
                <button
                  type="button"
                  data-audit-step={index}
                  aria-current={index === selected}
                  className={[
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]',
                    index === selected ? 'bg-shell-panel' : 'hover:bg-shell-panel/60'
                  ].join(' ')}
                  onClick={() => setSelected(index)}
                >
                  <span className="w-6 shrink-0 tabular-nums text-shell-muted">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{entry.tool}</span>
                  <span className={`shrink-0 ${DECISION_STYLE[entry.policyDecision]}`}>
                    {DECISION_LABEL[entry.policyDecision]}
                  </span>
                  {entry.review ? (
                    <span title="개인정보가 마스킹되었습니다" className="shrink-0 text-amber-500">
                      ●
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          {/* 단계 상세 */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[12px]">
            {current ? (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-[14px] font-semibold">{current.tool}</span>
                  <span className={DECISION_STYLE[current.policyDecision]}>
                    {DECISION_LABEL[current.policyDecision]}
                    {current.grantScope ? ` (${current.grantScope})` : ''}
                  </span>
                  <span className="ml-auto text-shell-muted">{current.durationMs}ms</span>
                </div>

                <dl className="mb-3 grid grid-cols-[72px_1fr] gap-y-1">
                  <dt className="text-shell-muted">시각</dt>
                  <dd>{new Date(current.ts).toLocaleString('ko-KR')}</dd>
                  <dt className="text-shell-muted">호출자</dt>
                  <dd>{current.source}</dd>
                  <dt className="text-shell-muted">주소</dt>
                  <dd className="min-w-0 break-all" data-audit-url>
                    {current.url ?? '—'}
                  </dd>
                  {current.targetText ? (
                    <>
                      <dt className="text-shell-muted">대상</dt>
                      <dd className="break-all">{current.targetText}</dd>
                    </>
                  ) : null}
                  {current.error ? (
                    <>
                      <dt className="text-shell-muted">결과</dt>
                      <dd className="text-red-400">{current.error}</dd>
                    </>
                  ) : null}
                </dl>

                {current.url ? (
                  <button
                    type="button"
                    data-audit-open-url
                    className="mb-4 h-7 rounded border border-shell-line px-2 text-[12px] text-shell-muted hover:text-shell-text"
                    onClick={() => {
                      if (current.url) void window.helm.openAuditUrl(current.url);
                    }}
                  >
                    그 URL 새 탭으로 열기
                  </button>
                ) : null}

                {current.screenshotPath ? (
                  <img
                    data-audit-screenshot
                    alt={`${current.tool} 실행 직후 화면`}
                    src={`file://${current.screenshotPath.replace(/\\/g, '/')}`}
                    className="max-w-full rounded border border-shell-line"
                  />
                ) : (
                  <p className="text-shell-muted">이 단계에는 화면 기록이 없습니다(읽기 도구).</p>
                )}

                <details className="mt-4">
                  <summary className="cursor-pointer text-shell-muted">인자 · 결과 (마스킹됨)</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-shell-panel p-2 text-[11px]">
                    {JSON.stringify({ args: current.args, result: current.result }, null, 2)}
                  </pre>
                </details>
              </>
            ) : null}
          </div>
        </div>
      )}

      {file ? (
        <p className="border-t border-shell-line px-4 py-2 text-[11px] text-shell-muted">{file}</p>
      ) : null}
    </PanelFrame>
  );
}

import { useEffect, useState } from 'react';
import type {
  ScheduleView,
  WorkflowCheckView,
  WorkflowListItem,
  WorkflowRunView
} from '../../../../shared/api';
import { useShellStore } from '../../store';
import { PanelFrame } from './PanelFrame';

/**
 * 워크플로우 — 승격 · 실행 · 예약 (M5).
 *
 * 화면이 세 칸인 이유가 이 계층의 이야기다:
 *
 *   1. **승격**: 스레드에서 뽑아 낸 초안 YAML 을 보여 준다. 오라클 칸은 비어 있고,
 *      사람이 채우기 전에는 저장 버튼이 막혀 있다 — 무엇이 "맞다" 인지는 기록에 없다
 *   2. **목록·실행**: 저장된 워크플로우를 날짜를 넣어 한 번 돌린다
 *   3. **판정**: 판정과 근거 오라클, 그리고 실제 획득 경로(`network`/`dom`)를 보여 준다.
 *      폴백이 일어났으면 그 자리에서 드러난다
 *
 * 저장 검사는 메인의 실제 로더를 부른다(`checkWorkflow`). 화면용 검사기를 따로 두면
 * 둘이 어긋나 "화면에서는 통과, 저장하면 실패" 가 된다.
 */

const VERDICT_STYLE: Record<string, string> = {
  PASS: 'text-emerald-500',
  REVIEW: 'text-amber-500',
  FAIL: 'text-red-400',
  ADAPTER_BROKEN: 'text-fuchsia-400'
};

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function WorkflowsPanel(): JSX.Element {
  const promoteThreadId = useShellStore((state) => state.promoteThreadId);
  const setPromoteThreadId = useShellStore((state) => state.setPromoteThreadId);

  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [runs, setRuns] = useState<WorkflowRunView[]>([]);
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);

  const [selected, setSelected] = useState<string | null>(null);
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [draft, setDraft] = useState<string | null>(null);
  const [todo, setTodo] = useState<string[]>([]);
  const [check, setCheck] = useState<WorkflowCheckView | null>(null);

  const [cron, setCron] = useState('0 7 * * 1-5');

  const reload = (): void => {
    void window.helm.getWorkflows().then((list) => {
      setWorkflows(list);
      setSelected((current) => current ?? list.find((item) => item.error === null)?.id ?? null);
    });
    void window.helm.getSchedules().then(setSchedules);
  };

  useEffect(() => {
    const off = window.helm.onWorkflowRunsChanged(setRuns);
    reload();
    void window.helm.getWorkflowRuns().then(setRuns);
    return off;
  }, []);

  // 스레드 패널에서 넘어온 승격 요청을 초안으로 바꾼다.
  useEffect(() => {
    if (promoteThreadId === null) return;

    void window.helm.promoteThread(promoteThreadId).then((result) => {
      setPromoteThreadId(null);

      if (!result) {
        setMessage('스레드를 찾지 못했습니다');
        return;
      }

      setDraft(result.yaml);
      setTodo(result.todo);
      setCheck(null);
      setMessage(
        result.skipped.length === 0
          ? `초안을 만들었습니다 (${result.workflowId})`
          : `초안을 만들었습니다 (${result.workflowId}) — 어댑터로 묶이지 않은 호출 ${result.skipped.length}건은 빠졌습니다`
      );
    });
  }, [promoteThreadId, setPromoteThreadId]);

  const runNow = (): void => {
    if (selected === null) return;

    setBusy(true);
    setMessage(`${selected} 실행 중…`);

    void window.helm
      .runWorkflow(selected, { date })
      .then((result) => {
        setMessage(
          result === null
            ? '실행이 결과를 돌려주지 않았습니다 (로그를 확인하세요)'
            : `${result.workflowId} ${date} → ${result.verdict} · 증거 ${result.evidencePath}`
        );
        void window.helm.getWorkflowRuns().then(setRuns);
      })
      .finally(() => setBusy(false));
  };

  const verify = (): void => {
    if (draft === null) return;
    void window.helm.checkWorkflow(draft).then(setCheck);
  };

  const save = (): void => {
    if (draft === null) return;

    void window.helm.saveWorkflow(draft).then((result) => {
      setCheck({
        ok: result.ok,
        issues: result.issues,
        id: result.id,
        version: result.version,
        oracles: result.oracles
      });

      if (result.ok) {
        setMessage(`${result.id} v${result.version ?? 1} 저장 — ${result.file}`);
        setDraft(null);
        setTodo([]);
        reload();
      }
    });
  };

  return (
    <PanelFrame title="워크플로우" count={workflows.length}>
      <div className="flex h-full min-h-0">
        {/* ── 목록 · 실행 · 예약 ── */}
        <div className="flex min-h-0 w-[320px] shrink-0 flex-col border-r border-shell-line">
          <ul data-workflow-count={workflows.length} className="min-h-0 flex-1 overflow-y-auto text-[12px]">
            {workflows.length === 0 ? (
              <li className="p-4 text-shell-muted">
                저장된 워크플로우가 없습니다. 스레드에서 승격해 만듭니다.
              </li>
            ) : (
              workflows.map((item) => (
                <li key={item.file}>
                  <button
                    type="button"
                    data-workflow-id={item.id}
                    disabled={item.error !== null}
                    aria-current={item.id === selected}
                    className={[
                      'w-full px-3 py-2 text-left disabled:opacity-50',
                      item.id === selected ? 'bg-shell-panel' : 'hover:bg-shell-panel/60'
                    ].join(' ')}
                    onClick={() => setSelected(item.id)}
                  >
                    <span className="block truncate font-semibold">
                      {item.id} <span className="text-shell-muted">v{item.version}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-shell-muted">
                      {item.error === null ? (item.description ?? item.file) : `로드 실패 — ${item.error}`}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>

          <div className="shrink-0 space-y-2 border-t border-shell-line p-3 text-[12px]">
            <label className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-shell-muted">날짜</span>
              <input
                data-workflow-date
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="h-7 min-w-0 flex-1 rounded border border-shell-line bg-transparent px-2"
              />
            </label>

            <button
              type="button"
              data-workflow-run
              disabled={selected === null || busy}
              className="h-7 w-full rounded bg-shell-accent text-[12px] text-white hover:opacity-90 disabled:opacity-40"
              onClick={runNow}
            >
              {busy ? '실행 중…' : '한 번 실행'}
            </button>

            <label className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-shell-muted">cron</span>
              <input
                data-workflow-cron
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                className="h-7 min-w-0 flex-1 rounded border border-shell-line bg-transparent px-2 font-mono"
              />
            </label>

            <button
              type="button"
              data-workflow-schedule
              disabled={selected === null}
              className="h-7 w-full rounded border border-shell-line text-[12px] hover:bg-shell-panel disabled:opacity-40"
              onClick={() => {
                if (selected === null) return;
                void window.helm
                  .addSchedule({ id: `${selected}-daily`, workflowId: selected, cron })
                  .then((result) => {
                    setMessage(
                      'error' in result ? `예약 실패 — ${result.error}` : `예약됨 — ${result.cron}`
                    );
                    void window.helm.getSchedules().then(setSchedules);
                  });
              }}
            >
              예약 걸기
            </button>

            {schedules.length > 0 ? (
              <ul data-schedule-count={schedules.length} className="space-y-1 text-[11px] text-shell-muted">
                {schedules.map((item) => (
                  <li key={item.id} className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate">
                      {item.id} · <span className="font-mono">{item.cron}</span>
                      {item.lastVerdict === null ? '' : ` · 최근 ${item.lastVerdict}`}
                    </span>
                    <button
                      type="button"
                      className="rounded border border-shell-line px-1 hover:bg-shell-panel"
                      onClick={() => {
                        void window.helm.removeSchedule(item.id).then(() => {
                          void window.helm.getSchedules().then(setSchedules);
                        });
                      }}
                    >
                      해제
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        {/* ── 승격 초안 · 판정 ── */}
        <div className="flex min-h-0 flex-1 flex-col">
          {message === null ? null : (
            <p data-workflow-message className="shrink-0 border-b border-shell-line px-4 py-2 text-[12px]">
              {message}
            </p>
          )}

          {draft === null ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <table className="w-full text-left text-[12px]">
                <thead className="sticky top-0 bg-shell-panel text-shell-muted">
                  <tr>
                    <th className="px-3 py-2">실행</th>
                    <th className="px-3 py-2">판정</th>
                    <th className="px-3 py-2">근거</th>
                    <th className="px-3 py-2">획득 경로</th>
                    <th className="px-3 py-2">증거</th>
                  </tr>
                </thead>
                <tbody data-run-count={runs.length}>
                  {runs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-shell-muted">
                        아직 실행 기록이 없습니다.
                      </td>
                    </tr>
                  ) : (
                    runs.map((run) => (
                      <tr key={run.runId} className="border-t border-shell-line align-top">
                        <td className="px-3 py-2">
                          <span className="block truncate">{run.workflowId}</span>
                          <span className="block text-[11px] text-shell-muted">
                            {String(run.inputs['date'] ?? '')} · {run.durationMs}ms
                          </span>
                        </td>
                        <td
                          data-run-verdict={run.verdict}
                          className={`px-3 py-2 font-semibold ${VERDICT_STYLE[run.verdict] ?? ''}`}
                        >
                          {run.verdict}
                        </td>
                        <td className="px-3 py-2 text-[11px]">
                          {run.oracles.filter((oracle) => !oracle.ok).length === 0
                            ? `오라클 ${run.oracles.length}개 통과`
                            : run.oracles
                                .filter((oracle) => !oracle.ok)
                                .map((oracle) => `${oracle.rule} v${oracle.ruleVersion}`)
                                .join(', ')}
                        </td>
                        <td className="px-3 py-2 text-[11px]">
                          {run.sources.map((step) => (
                            <span key={step.step} className="block">
                              {step.adapter}: <span className="font-mono">{step.source}</span>
                            </span>
                          ))}
                        </td>
                        <td className="px-3 py-2 text-[11px] text-shell-muted">
                          <span className="break-all">{run.evidencePath}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 border-b border-shell-line px-4 py-2 text-[12px]">
                <p className="font-semibold">승격 초안 — 저장하려면 오라클을 채워야 합니다</p>
                <ul data-promote-todo={todo.length} className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-amber-500">
                  {todo.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              <textarea
                data-promote-draft
                value={draft}
                spellCheck={false}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setCheck(null);
                }}
                className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[12px] outline-none"
              />

              {check === null ? null : (
                <div
                  data-promote-check={check.ok ? 'ok' : 'error'}
                  className={[
                    'shrink-0 border-t border-shell-line px-4 py-2 text-[11px]',
                    check.ok ? 'text-emerald-500' : 'text-red-400'
                  ].join(' ')}
                >
                  {check.ok ? (
                    `검사 통과 — ${check.id} v${check.version} · 오라클 ${check.oracles}개`
                  ) : (
                    <ul className="list-disc space-y-0.5 pl-4">
                      {check.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="flex shrink-0 items-center gap-2 border-t border-shell-line px-4 py-2">
                <button
                  type="button"
                  data-promote-check-run
                  className="h-7 rounded border border-shell-line px-3 text-[12px] hover:bg-shell-panel"
                  onClick={verify}
                >
                  검사
                </button>
                <button
                  type="button"
                  data-promote-save
                  className="h-7 rounded bg-shell-accent px-3 text-[12px] text-white hover:opacity-90"
                  onClick={save}
                >
                  workflows/ 에 저장
                </button>
                <button
                  type="button"
                  data-promote-cancel
                  className="h-7 rounded border border-shell-line px-3 text-[12px] hover:bg-shell-panel"
                  onClick={() => {
                    setDraft(null);
                    setTodo([]);
                    setCheck(null);
                  }}
                >
                  닫기
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </PanelFrame>
  );
}

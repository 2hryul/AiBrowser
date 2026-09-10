import { useEffect, useState } from 'react';
import type { UndoRecordView } from '../../../../shared/types';
import { PanelFrame } from '../panels/PanelFrame';

/**
 * 되돌리기 목록.
 *
 * AI 의 `undo` 도구와 **같은 스택**을 본다. 봉인된 항목은 왜 되돌릴 수 없는지 사유와 함께
 * 보여준다 — 버튼만 비활성으로 두면 사용자는 이유를 알 수 없다.
 */
export function UndoPanel(): JSX.Element {
  const [records, setRecords] = useState<UndoRecordView[]>([]);
  const [runId, setRunId] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const off = window.helm.onUndoChanged((payload) => {
      setRunId(payload.runId);
      setRecords(payload.records);
    });

    void window.helm.getUndo().then((payload) => {
      setRunId(payload.runId);
      setRecords(payload.records);
    });

    return off;
  }, []);

  const undoable = records.filter((record) => !record.undone && !record.sealed).length;

  const apply = (id?: string): void => {
    void window.helm.applyUndo(runId, id).then((outcome) => {
      setMessage(outcome.ok ? null : outcome.message);
    });
  };

  return (
    <PanelFrame
      title="되돌리기"
      count={undoable}
      actions={
        <button
          type="button"
          data-undo-latest
          className="h-7 rounded border border-shell-line px-2 text-[12px] text-shell-muted hover:text-shell-text disabled:opacity-40"
          disabled={undoable === 0}
          onClick={() => apply()}
        >
          최근 작업 되돌리기
        </button>
      }
    >
      {message ? (
        <p data-undo-message className="border-b border-shell-line bg-amber-500/10 px-4 py-2 text-[12px]">
          {message}
        </p>
      ) : null}

      {records.length === 0 ? (
        <p className="p-6 text-[13px] text-shell-muted">되돌릴 작업이 없습니다.</p>
      ) : (
        <ul data-undo-count={records.length} className="divide-y divide-shell-line">
          {records.map((record) => (
            <li
              key={record.id}
              data-undo-id={record.id}
              data-undo-sealed={record.sealed}
              data-undo-undone={record.undone}
              className="flex items-center gap-3 px-4 py-2 text-[13px]"
            >
              <span className="w-28 shrink-0 text-[11px] text-shell-muted">{record.tool}</span>
              <span className="min-w-0 flex-1">
                <span className={record.undone ? 'line-through opacity-60' : ''}>{record.describe}</span>
                {record.sealed ? (
                  <span className="mt-0.5 block text-[11px] text-amber-500">
                    봉인됨 — {record.sealedReason ?? '제출 후에는 되돌릴 수 없습니다'}
                  </span>
                ) : null}
              </span>

              <button
                type="button"
                data-undo-apply={record.id}
                className="h-6 shrink-0 rounded border border-shell-line px-2 text-[11px] text-shell-muted hover:text-shell-text disabled:opacity-40"
                disabled={record.undone || record.sealed}
                onClick={() => apply(record.id)}
              >
                되돌리기
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

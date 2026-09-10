import { useEffect, useState } from 'react';
import type { ThreadView } from '../../../../shared/types';
import { PanelFrame } from '../panels/PanelFrame';

/**
 * 결과표 — 수집한 행을 출처와 함께 보여주고 파일로 내보낸다.
 *
 * 출처(URL)와 단계 번호를 열로 그대로 남기는 것이 중요하다. "이 값은 어디서 왔나" 에
 * 답할 수 없는 표는 보고서에 쓸 수 없다.
 *
 * 내보내기는 다운로드 폴더에 쓴다. 도구가 접근할 수 있는 유일한 쓰기 경로이고,
 * 사용자에게도 이미 "가져갈 것들" 자리다.
 */

const FORMATS: { id: 'csv' | 'md' | 'json'; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'md', label: 'Markdown' },
  { id: 'json', label: 'JSON' }
];

export function ResultsTable(): JSX.Element {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [threadId, setThreadId] = useState<string>('');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.helm.getThreads().then((list) => {
      setThreads(list);
      setThreadId((current) => (current === '' ? list[0]?.id ?? '' : current));
    });
  }, []);

  useEffect(() => {
    if (threadId === '') {
      setRows([]);
      return;
    }

    void window.helm.getResults(threadId).then((value) => {
      setRows(
        value.filter(
          (row): row is Record<string, unknown> => row !== null && typeof row === 'object'
        )
      );
    });
  }, [threadId]);

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];

  const cell = (row: Record<string, unknown>, column: string): string => {
    const value = row[column];
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  };

  return (
    <PanelFrame
      title="결과표"
      count={rows.length}
      actions={
        <>
          <select
            data-results-thread
            className="h-7 rounded border border-shell-line bg-shell-panel px-2 text-[12px]"
            value={threadId}
            onChange={(event) => setThreadId(event.target.value)}
          >
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.title || thread.id}
              </option>
            ))}
          </select>

          {FORMATS.map((format) => (
            <button
              key={format.id}
              type="button"
              data-results-export={format.id}
              className="h-7 rounded border border-shell-line px-2 text-[12px] text-shell-muted hover:text-shell-text disabled:opacity-40"
              disabled={rows.length === 0}
              onClick={() => {
                void window.helm.exportResults(threadId, format.id).then((result) => {
                  setMessage(
                    result
                      ? `${result.rows}행을 ${result.filePath} 에 저장했습니다 (${result.bytes}바이트)`
                      : '내보내기에 실패했습니다'
                  );
                });
              }}
            >
              {format.label}
            </button>
          ))}
        </>
      }
    >
      {message ? (
        <p
          data-results-message
          className="border-b border-shell-line bg-shell-panel px-4 py-2 text-[12px] break-all"
        >
          {message}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="p-6 text-[13px] text-shell-muted">
          아직 수집된 결과가 없습니다. 작업이 체크포인트에 결과를 남기면 여기 보입니다.
        </p>
      ) : (
        <div className="overflow-auto">
          <table data-results-rows={rows.length} className="w-full text-[12px]">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column}
                    data-results-column={column}
                    className="sticky top-0 border-b border-shell-line bg-shell-panel px-3 py-1.5 text-left font-semibold"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} data-results-row={index} className="border-b border-shell-line">
                  {columns.map((column) => (
                    <td key={column} className="px-3 py-1 align-top break-all">
                      {cell(row, column)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelFrame>
  );
}

import type { DownloadItem } from '../../../../shared/types';
import { PanelFrame } from './PanelFrame';

interface Props {
  downloads: DownloadItem[];
}

const STATE_LABEL: Record<DownloadItem['state'], string> = {
  progressing: '받는 중',
  paused: '일시정지',
  completed: '완료',
  cancelled: '취소됨',
  interrupted: '중단됨'
};

/** 다운로드 관리자 (Ctrl+J). 진행률·취소·폴더 열기를 제공한다. */
export function DownloadsPanel({ downloads }: Props): JSX.Element {
  const smallButton =
    'h-6 rounded border border-shell-line px-2 text-[11px] text-shell-muted hover:text-shell-text disabled:opacity-30';

  return (
    <PanelFrame
      title="다운로드"
      count={downloads.length}
      actions={
        <button
          type="button"
          className="h-7 rounded border border-shell-line px-2 text-[12px] text-shell-muted hover:text-shell-text"
          onClick={() => void window.helm.downloadClearCompleted()}
        >
          완료 항목 지우기
        </button>
      }
    >
      {downloads.length === 0 ? (
        <p className="p-6 text-[13px] text-shell-muted">받은 파일이 없습니다.</p>
      ) : (
        <ul data-downloads-count={downloads.length} className="divide-y divide-shell-line">
          {downloads.map((item) => {
            const done = item.state === 'completed';
            const percent =
              item.totalBytes > 0
                ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100))
                : done
                  ? 100
                  : 0;

            return (
              <li
                key={item.id}
                data-download-id={item.id}
                data-download-state={item.state}
                data-download-file={item.fileName}
                className="flex flex-col gap-1.5 px-4 py-3 text-[13px]"
              >
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium" title={item.savePath}>
                    {item.fileName}
                  </span>
                  <span className="shrink-0 text-[11px] text-shell-muted">
                    {STATE_LABEL[item.state]} · {formatBytes(item.receivedBytes)}
                    {item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : ''}
                  </span>
                </div>

                {/* 진행률 — 완료 후에도 100% 로 남겨 결과를 눈으로 확인할 수 있게 한다. */}
                <div className="h-1 w-full overflow-hidden rounded bg-shell-line">
                  <div
                    className={done ? 'h-full bg-emerald-500' : 'h-full bg-shell-accent'}
                    style={{ width: `${percent}%` }}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-shell-muted">
                    {item.url}
                  </span>

                  {item.state === 'progressing' ? (
                    <>
                      <button type="button" className={smallButton} onClick={() => void window.helm.downloadPause(item.id)}>
                        일시정지
                      </button>
                      <button type="button" className={smallButton} onClick={() => void window.helm.downloadCancel(item.id)}>
                        취소
                      </button>
                    </>
                  ) : null}

                  {item.state === 'paused' ? (
                    <>
                      <button type="button" className={smallButton} onClick={() => void window.helm.downloadResume(item.id)}>
                        계속
                      </button>
                      <button type="button" className={smallButton} onClick={() => void window.helm.downloadCancel(item.id)}>
                        취소
                      </button>
                    </>
                  ) : null}

                  <button
                    type="button"
                    className={smallButton}
                    disabled={!done}
                    onClick={() => void window.helm.downloadOpen(item.id)}
                  >
                    열기
                  </button>
                  <button
                    type="button"
                    className={smallButton}
                    disabled={!done}
                    onClick={() => void window.helm.downloadShowInFolder(item.id)}
                  >
                    폴더 열기
                  </button>
                  <button
                    type="button"
                    aria-label={`${item.fileName} 목록에서 제거`}
                    className={smallButton}
                    onClick={() => void window.helm.downloadRemove(item.id)}
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </PanelFrame>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

import { useEffect, useState } from 'react';
import type { PageDiffView, SnapshotView, TrackedUrlView } from '../../../../shared/types';
import { PanelFrame } from './PanelFrame';

/**
 * 변경 이력 — 북마크한 페이지가 지난번과 무엇이 달라졌는지.
 *
 * 스냅샷은 북마크된 주소를 방문할 때 자동으로 쌓인다(모든 방문을 남기면 DB 가 방문 기록의
 * 사본이 된다). 비교는 낱말 단위이고, 차이가 너무 커서 정렬을 포기했으면 그 사실을
 * 화면에 밝힌다 — 정확해 보이는 거짓 diff 보다 낫다.
 */

const KIND_STYLE: Record<string, string> = {
  added: 'bg-emerald-500/15 text-emerald-500',
  removed: 'bg-red-500/15 text-red-400 line-through',
  same: 'text-shell-muted'
};

export function ChangesPanel(): JSX.Element {
  const [urls, setUrls] = useState<TrackedUrlView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotView[]>([]);
  const [diff, setDiff] = useState<PageDiffView | null>(null);

  useEffect(() => {
    const off = window.helm.onTrackedUrlsChanged(setUrls);
    void window.helm.getTrackedUrls().then((list) => {
      setUrls(list);
      setSelected((current) => current ?? list[0]?.url ?? null);
    });
    return off;
  }, []);

  useEffect(() => {
    if (selected === null) {
      setSnapshots([]);
      setDiff(null);
      return;
    }

    void window.helm.getPageHistory(selected).then(setSnapshots);
    void window.helm.getPageDiff(selected).then(setDiff);
  }, [selected]);

  return (
    <PanelFrame title="변경 이력" count={urls.length}>
      <div className="flex h-full min-h-0">
        <ul
          data-changes-url-count={urls.length}
          className="min-h-0 w-[300px] shrink-0 overflow-y-auto border-r border-shell-line text-[12px]"
        >
          {urls.length === 0 ? (
            <li className="p-4 text-shell-muted">
              북마크한 페이지를 방문하면 본문 스냅샷이 쌓입니다.
            </li>
          ) : (
            urls.map((item) => (
              <li key={item.url}>
                <button
                  type="button"
                  data-changes-url={item.url}
                  aria-current={item.url === selected}
                  className={[
                    'w-full px-3 py-2 text-left',
                    item.url === selected ? 'bg-shell-panel' : 'hover:bg-shell-panel/60'
                  ].join(' ')}
                  onClick={() => setSelected(item.url)}
                >
                  <span className="block truncate">{item.title || item.url}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-shell-muted">
                    스냅샷 {item.snapshots}개 · {new Date(item.lastAt).toLocaleString('ko-KR')}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[12px]">
          {selected === null ? null : (
            <>
              <p data-changes-snapshots={snapshots.length} className="mb-2 text-shell-muted">
                스냅샷 {snapshots.length}개
                {snapshots.some((snapshot) => snapshot.truncated)
                  ? ' · 200KB 상한으로 잘린 스냅샷이 있습니다'
                  : ''}
              </p>

              {diff === null ? (
                <p className="text-shell-muted">
                  비교할 스냅샷이 둘 이상 필요합니다. 이 페이지를 다시 방문하면 비교가 생깁니다.
                </p>
              ) : (
                <>
                  <p data-changes-summary className="mb-3">
                    바뀐 낱말 <strong>{diff.changedWords}</strong>개 (추가 {diff.addedWords} ·
                    삭제 {diff.removedWords})
                    {diff.coarse ? (
                      <span data-changes-coarse className="ml-2 text-amber-500">
                        차이가 커서 전체 교체로 봤습니다 — 전문을 다시 읽는 편이 정확합니다
                      </span>
                    ) : null}
                  </p>

                  <p className="mb-3 text-[11px] text-shell-muted">
                    {new Date(diff.from.capturedAt).toLocaleString('ko-KR')} →{' '}
                    {new Date(diff.to.capturedAt).toLocaleString('ko-KR')}
                  </p>

                  <div data-changes-hunks className="leading-relaxed">
                    {diff.hunks.map((hunk, index) => (
                      <span
                        key={index}
                        data-hunk-kind={hunk.kind}
                        className={`rounded px-0.5 ${KIND_STYLE[hunk.kind] ?? ''}`}
                      >
                        {hunk.text}{' '}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </PanelFrame>
  );
}

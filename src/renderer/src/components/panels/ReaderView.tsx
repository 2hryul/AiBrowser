import { useEffect, useState } from 'react';
import type { ReaderFailure, ReaderPayload } from '../../../../shared/types';
import { PanelFrame } from './PanelFrame';

interface Props {
  activeTabId: number | null;
}

const FAILURE_MESSAGE: Record<ReaderFailure, string> = {
  'not-readerable': '이 페이지에서는 본문을 찾지 못했습니다.',
  'extract-failed': '본문 추출에 실패했습니다.',
  'empty-html': '페이지가 아직 비어 있습니다.',
  'no-tab': '활성 탭이 없습니다.'
};

/**
 * 읽기 모드 화면.
 * 추출은 메인의 Reader(@mozilla/readability + linkedom)가 하고, 여기서는 결과만 그린다.
 */
export function ReaderView({ activeTabId }: Props): JSX.Element {
  const [payload, setPayload] = useState<ReaderPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (activeTabId === null) {
      setPayload({ tabId: -1, url: '', article: null, reason: 'no-tab' });
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void window.helm.readTab(activeTabId).then((result) => {
      if (cancelled) return;
      setPayload(result);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [activeTabId]);

  const article = payload?.article ?? null;

  return (
    <PanelFrame
      title="읽기 모드"
      actions={
        article ? (
          <span className="text-[11px] text-shell-muted">{article.length.toLocaleString()}자</span>
        ) : null
      }
    >
      {loading ? (
        <p className="p-6 text-[13px] text-shell-muted">본문을 추출하는 중…</p>
      ) : article ? (
        <article
          data-reader-length={article.length}
          className="mx-auto max-w-[720px] px-8 py-10 text-[15px] leading-[1.85] text-shell-text"
        >
          <h1 className="mb-2 text-[24px] font-semibold leading-snug">{article.title}</h1>
          <p className="mb-8 text-[12px] text-shell-muted">
            {[article.byline, article.siteName, payload?.url].filter(Boolean).join(' · ')}
          </p>
          {/*
            추출된 본문은 readability 가 정제한 HTML 이다(스크립트·광고 제거됨).
            셸 CSP 가 script-src 'self' 이므로 삽입된 마크업의 스크립트는 실행되지 않는다.
          */}
          <div
            className="reader-body space-y-4 [&_a]:text-shell-accent [&_a]:underline [&_h2]:mt-8 [&_h2]:text-[18px] [&_h2]:font-semibold [&_img]:my-4 [&_img]:max-w-full"
            dangerouslySetInnerHTML={{ __html: article.content }}
          />
        </article>
      ) : (
        <div className="p-6 text-[13px] text-shell-muted">
          <p>{FAILURE_MESSAGE[payload?.reason ?? 'extract-failed']}</p>
          {payload?.url ? <p className="mt-2 text-[11px]">{payload.url}</p> : null}
        </div>
      )}
    </PanelFrame>
  );
}

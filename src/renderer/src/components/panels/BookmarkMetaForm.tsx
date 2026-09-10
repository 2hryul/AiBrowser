import { useEffect, useState } from 'react';
import type { BookmarkMetaView } from '../../../../shared/types';

interface Props {
  bookmarkId: number;
}

/**
 * 북마크에 붙는 AI 힌트 편집기.
 *
 * 사람에게 북마크는 "다시 갈 곳" 이지만 에이전트에게는 "무엇을 해야 하는 곳" 이다.
 * 여기 적은 의도·기대 콘텐츠·핵심 필드·요령은 `bookmark_list` 로 에이전트에게 전달된다 —
 * 즉 **프롬프트에 실린다**. 그래서 메모와 같은 규칙으로 자격증명·개인정보를 거부하고,
 * 거부됐다는 사실을 화면에 밝힌다.
 */
const REASON_LABEL: Record<string, string> = {
  scope: '잘못된 입력입니다',
  credential: '자격증명으로 보이는 값이 있어 저장하지 않았습니다',
  pii: '개인정보로 보이는 값이 있어 저장하지 않았습니다'
};

export function BookmarkMetaForm({ bookmarkId }: Props): JSX.Element {
  const [meta, setMeta] = useState<BookmarkMetaView | null>(null);
  const [intent, setIntent] = useState('');
  const [expectedContent, setExpectedContent] = useState('');
  const [keyFields, setKeyFields] = useState('');
  const [agentHints, setAgentHints] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    void window.helm.getBookmarkMeta(bookmarkId).then((value) => {
      setMeta(value);
      setIntent(value?.intent ?? '');
      setExpectedContent(value?.expectedContent ?? '');
      setKeyFields((value?.keyFields ?? []).join(', '));
      setAgentHints(value?.agentHints ?? '');
    });
  }, [bookmarkId]);

  const field =
    'h-7 w-full rounded border border-shell-line bg-shell-panel px-2 text-[12px] outline-none focus:border-shell-accent';

  const save = (): void => {
    void window.helm
      .setBookmarkMeta(bookmarkId, {
        intent,
        expectedContent,
        agentHints,
        keyFields: keyFields
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '')
      })
      .then((result) => {
        if (result.ok) {
          setMeta(result.meta);
          setRejected(false);
          setMessage('저장했습니다.');
          return;
        }

        setRejected(true);
        setMessage(
          `${REASON_LABEL[result.reason] ?? result.message}${
            result.matches && result.matches.length > 0 ? ` (${result.matches.join(', ')})` : ''
          }`
        );
      });
  };

  return (
    <div
      data-bookmark-meta-form={bookmarkId}
      className="grid gap-2 border-t border-shell-line bg-shell-panel/40 px-4 py-3"
    >
      {message ? (
        <p
          data-meta-message
          data-meta-rejected={rejected}
          className={[
            'rounded px-2 py-1 text-[12px]',
            rejected ? 'bg-red-500/10 text-red-400' : 'bg-shell-panel'
          ].join(' ')}
        >
          {message}
        </p>
      ) : null}

      <label className="grid gap-1 text-[11px] text-shell-muted">
        의도 — 이 북마크로 무엇을 하려는가
        <input
          data-meta-intent
          className={field}
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
        />
      </label>

      <label className="grid gap-1 text-[11px] text-shell-muted">
        기대 콘텐츠 — 열면 무엇이 보여야 하는가
        <input
          data-meta-expected
          className={field}
          value={expectedContent}
          onChange={(event) => setExpectedContent(event.target.value)}
        />
      </label>

      <label className="grid gap-1 text-[11px] text-shell-muted">
        핵심 필드 — 쉼표로 구분
        <input
          data-meta-fields
          className={field}
          value={keyFields}
          onChange={(event) => setKeyFields(event.target.value)}
        />
      </label>

      <label className="grid gap-1 text-[11px] text-shell-muted">
        요령 — 이 사이트를 다룰 때 주의할 점
        <input
          data-meta-hints
          className={field}
          value={agentHints}
          onChange={(event) => setAgentHints(event.target.value)}
        />
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-meta-save
          className="h-7 rounded bg-shell-accent px-3 text-[12px] text-white hover:opacity-90"
          onClick={save}
        >
          저장
        </button>
        <span className="text-[11px] text-shell-muted">
          {meta
            ? `마지막 수정 ${new Date(meta.updatedAt).toLocaleString('ko-KR')}`
            : '아직 힌트가 없습니다'}
        </span>
      </div>
    </div>
  );
}

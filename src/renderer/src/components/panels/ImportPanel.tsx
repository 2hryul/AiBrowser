import { useEffect, useState } from 'react';
import type { DiscoveredProfileInfo } from '../../../../shared/api';
import type { ProfileImportResult } from '../../../../shared/types';

/**
 * 크롬/엣지 프로필 가져오기 — 1단계(비암호화 데이터)만.
 *
 * 북마크 관리자 안에 접힌 채로 붙는다. 3단계 마법사는 M4c 범위라 여기서는
 * "무엇을 가져오고 무엇을 가져오지 않는지"를 분명히 보여주는 최소 UI 로 둔다.
 */
export function ImportPanel(): JSX.Element {
  const [profiles, setProfiles] = useState<DiscoveredProfileInfo[] | null>(null);
  const [results, setResults] = useState<ProfileImportResult[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.helm.discoverProfiles().then(setProfiles);
  }, []);

  const run = (dir: string): void => {
    setBusy(true);
    void window.helm.runImport(dir).then((result) => {
      setBusy(false);
      if (result) setResults((previous) => [result, ...previous]);
    });
  };

  return (
    <section
      data-import-panel
      aria-label="다른 브라우저에서 가져오기"
      className="border-t border-shell-line px-4 py-3 text-[12px]"
    >
      <h3 className="mb-1 text-[13px] font-semibold">다른 브라우저에서 가져오기</h3>
      <p className="mb-3 text-shell-muted">
        북마크 · 방문 기록 · 자동완성만 가져옵니다. 저장된 비밀번호와 로그인 세션(쿠키·토큰)은
        가져오지 않습니다 — 각 사이트에서 한 번 로그인하면 유지됩니다.
      </p>

      {profiles === null ? (
        <p className="text-shell-muted">프로필을 찾는 중…</p>
      ) : profiles.length === 0 ? (
        <p className="text-shell-muted">가져올 수 있는 크롬·엣지 프로필을 찾지 못했습니다.</p>
      ) : (
        <ul className="mb-3 grid gap-1">
          {profiles.map((profile) => (
            <li
              key={profile.dir}
              data-import-profile={`${profile.browser}/${profile.name}`}
              className="flex items-center gap-3"
            >
              <span className="w-28 shrink-0 font-medium">
                {profile.browser === 'chrome' ? 'Chrome' : 'Edge'} · {profile.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-shell-muted" title={profile.dir}>
                {profile.available.join(', ')}
              </span>
              <button
                type="button"
                className="h-6 shrink-0 rounded border border-shell-line px-2 hover:text-shell-text disabled:opacity-40"
                disabled={busy}
                onClick={() => run(profile.dir)}
              >
                가져오기
              </button>
            </li>
          ))}
        </ul>
      )}

      {results.map((result, index) => (
        <div
          key={`${result.sourceProfile}-${index}`}
          data-import-result={result.sourceProfile}
          className="mt-2 rounded border border-shell-line p-2"
        >
          <div className="font-medium">{result.sourceProfile} 가져오기 완료</div>
          <div className="text-shell-muted">
            북마크 {result.bookmarks}건 · 방문 기록 {result.history}건 · 자동완성 {result.autofill}건
          </div>
          <div className="mt-1 text-shell-muted">
            가져오지 않은 파일 {result.skippedCredentialFiles.length}개 (자격증명·세션)
          </div>
          {result.errors.length > 0 ? (
            <ul className="mt-1 text-red-400">
              {result.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </section>
  );
}

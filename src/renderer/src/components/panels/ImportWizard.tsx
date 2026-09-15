import { useEffect, useState } from 'react';
import type { DiscoveredProfileInfo, PasswordImportView } from '../../../../shared/api';
import type { PolicyView, ProfileImportResult } from '../../../../shared/types';

/**
 * 최초 구동 임포트 마법사 — 3단계 (M4c).
 *
 * 단계를 나눈 것이 이 화면의 전부다. 사용자가 "다 가져와" 를 한 번 누르고 끝내는 대신,
 * **무엇이 어느 칸에 속하는지** 보게 만든다.
 *
 *   1. 가져온다        — 북마크·방문 기록·자동완성. 편의 데이터다
 *   2. 동의하면 가져온다 — 저장된 비밀번호. 정책이 켜 두었고 사용자가 한 번 더 동의할 때만
 *   3. 가져오지 않는다  — 세션 쿠키·인증 토큰. 선택지가 아니라 **고정 안내**다
 *
 * 3단계에 체크박스가 없는 것이 의도다. 끌 수 있는 것처럼 보이면 "켜면 되는데 왜 안 켜지?"
 * 가 되고, 실제로는 ABE·DBSC 때문에 기술적으로 불가능하며 시도 자체가 금지다(불변 조건 9).
 */

type Stage = 1 | 2 | 3;

interface Props {
  /** 마법사를 닫는다. 설정에서 다시 열 수 있다. */
  onClose?: () => void;
}

export function ImportWizard({ onClose }: Props): JSX.Element {
  const [stage, setStage] = useState<Stage>(1);
  const [profiles, setProfiles] = useState<DiscoveredProfileInfo[] | null>(null);
  const [policy, setPolicy] = useState<PolicyView | null>(null);

  const [chosen, setChosen] = useState<string | null>(null);
  const [wants, setWants] = useState({ bookmarks: true, history: true, autofill: true });
  const [result, setResult] = useState<ProfileImportResult | null>(null);

  const [consent, setConsent] = useState(false);
  const [csvPath, setCsvPath] = useState('');
  const [passwords, setPasswords] = useState<PasswordImportView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.helm.discoverProfiles().then((list) => {
      setProfiles(list);
      setChosen((current) => current ?? list[0]?.dir ?? null);
    });
    void window.helm.getPolicy().then(setPolicy);
  }, []);

  // 정책이 꺼 두었으면 2단계는 존재하지 않는다 — 건너뛰고 3단계로.
  const passwordsAllowed = policy?.allowPasswordImport === true;

  const runImport = (): void => {
    if (chosen === null) return;

    setBusy(true);
    void window.helm
      .runImport(chosen)
      .then((imported) => {
        setResult(imported);
        setMessage(
          imported === null
            ? '가져오기에 실패했습니다'
            : `북마크 ${imported.bookmarks}건 · 기록 ${imported.history}건 · 자동완성 ${imported.autofill}건`
        );
      })
      .finally(() => setBusy(false));
  };

  const runPasswords = (): void => {
    if (!consent || csvPath.trim() === '') return;

    setBusy(true);
    void window.helm
      .importPasswords(csvPath.trim())
      .then((imported) => {
        setPasswords(imported);
        setMessage(
          imported === null
            ? '비밀번호 가져오기에 실패했습니다'
            : `${imported.imported}건을 Windows 자격증명 관리자로 옮겼습니다` +
                (imported.sourceRemoved ? ' · 원본 CSV 삭제됨' : ' · 원본 CSV 삭제 실패')
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <section
      data-import-wizard
      data-wizard-stage={stage}
      aria-label="다른 브라우저에서 가져오기"
      className="flex h-full min-h-0 flex-col text-[13px]"
    >
      {/* 단계 표시. 정책이 꺼도 2단계는 남는다 — 안 보이면 "왜 없지?" 가 되고,
          보이면 "관리자 정책으로 비활성" 이라는 답이 화면에 있다. */}
      <ol className="flex shrink-0 gap-2 border-b border-shell-line px-4 py-2 text-[12px]">
        {([1, 2, 3] as Stage[]).map((step) => (
          <li
            key={step}
            data-wizard-step={step}
            className={[
              'rounded px-2 py-0.5',
              stage === step ? 'bg-shell-accent text-white' : 'text-shell-muted'
            ].join(' ')}
          >
            {step}. {step === 1 ? '가져온다' : step === 2 ? '동의하면 가져온다' : '가져오지 않는다'}
          </li>
        ))}
      </ol>

      {message === null ? null : (
        <p data-wizard-message className="shrink-0 border-b border-shell-line px-4 py-2 text-[12px]">
          {message}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* ── 1단계 ── */}
        {stage === 1 ? (
          <div data-wizard-panel="1">
            <h3 className="mb-1 font-semibold">가져올 것을 고르세요</h3>
            <p className="mb-3 text-[12px] text-shell-muted">
              북마크 · 방문 기록 · 자동완성은 암호화되지 않은 편의 데이터입니다.
            </p>

            {profiles === null ? (
              <p className="text-shell-muted">프로필을 찾는 중…</p>
            ) : profiles.length === 0 ? (
              <p data-wizard-no-profile className="text-shell-muted">
                가져올 수 있는 크롬·엣지 프로필을 찾지 못했습니다.
              </p>
            ) : (
              <>
                <ul data-wizard-profiles={profiles.length} className="mb-3 grid gap-1">
                  {profiles.map((profile) => (
                    <li key={profile.dir}>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="profile"
                          data-wizard-profile={`${profile.browser}/${profile.name}`}
                          checked={chosen === profile.dir}
                          onChange={() => setChosen(profile.dir)}
                        />
                        <span>
                          {profile.browser} · {profile.name}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>

                <ul className="mb-3 grid gap-1">
                  {(
                    [
                      ['bookmarks', '북마크'],
                      ['history', '방문 기록'],
                      ['autofill', '자동완성']
                    ] as const
                  ).map(([key, label]) => (
                    <li key={key}>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          data-wizard-want={key}
                          checked={wants[key]}
                          onChange={(event) =>
                            setWants((previous) => ({ ...previous, [key]: event.target.checked }))
                          }
                        />
                        <span>{label}</span>
                      </label>
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  data-wizard-import
                  disabled={busy || chosen === null}
                  className="h-7 rounded bg-shell-accent px-3 text-[12px] text-white disabled:opacity-40"
                  onClick={runImport}
                >
                  {busy ? '가져오는 중…' : '가져오기'}
                </button>

                {result === null ? null : (
                  <p data-wizard-result className="mt-2 text-[12px] text-shell-muted">
                    가져오지 않은 파일 {result.skippedCredentialFiles.length}개는 건드리지 않았습니다.
                  </p>
                )}
              </>
            )}
          </div>
        ) : null}

        {/* ── 2단계 ── */}
        {stage === 2 ? (
          <div data-wizard-panel="2">
            {!passwordsAllowed ? (
              <p data-wizard-passwords-disabled className="text-shell-muted">
                저장된 비밀번호 가져오기는 <strong>관리자 정책으로 비활성</strong>되어 있습니다.
              </p>
            ) : (
              <>
                <h3 className="mb-1 font-semibold">저장된 비밀번호</h3>
                <p className="mb-3 text-[12px] text-shell-muted">
                  Chrome 의 <strong>비밀번호 내보내기</strong>로 만든 CSV 파일을 고르세요. 가져온
                  비밀번호는 Windows 자격증명 관리자로 옮기고, 원본 CSV 는 즉시 지웁니다. Helm 은
                  비밀번호를 자체 파일에 저장하지 않습니다.
                </p>

                <label className="mb-2 flex items-start gap-2">
                  <input
                    type="checkbox"
                    data-wizard-consent
                    checked={consent}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  <span>
                    내보낸 CSV 에 평문 비밀번호가 들어 있다는 것을 알고 있으며, 자격증명 관리자로
                    옮기는 데 동의합니다.
                  </span>
                </label>

                <label className="mb-2 flex items-center gap-2">
                  <span className="shrink-0 text-shell-muted">CSV 경로</span>
                  <input
                    data-wizard-csv
                    value={csvPath}
                    onChange={(event) => setCsvPath(event.target.value)}
                    placeholder="C:\\Users\\...\\Chrome Passwords.csv"
                    className="h-7 min-w-0 flex-1 rounded border border-shell-line bg-transparent px-2"
                  />
                </label>

                <button
                  type="button"
                  data-wizard-import-passwords
                  disabled={busy || !consent || csvPath.trim() === ''}
                  className="h-7 rounded bg-shell-accent px-3 text-[12px] text-white disabled:opacity-40"
                  onClick={runPasswords}
                >
                  {busy ? '옮기는 중…' : '자격증명 관리자로 옮기기'}
                </button>

                {passwords === null ? null : (
                  <p data-wizard-password-result={passwords.imported} className="mt-2 text-[12px]">
                    {passwords.imported}건 저장 · 건너뜀 {passwords.skipped}건 ·{' '}
                    {passwords.hosts.join(', ')}
                  </p>
                )}
              </>
            )}
          </div>
        ) : null}

        {/* ── 3단계 — 선택지가 아니다 ── */}
        {stage === 3 ? (
          <div data-wizard-panel="3">
            <h3 className="mb-1 font-semibold">가져오지 않는 것</h3>
            <p data-wizard-never className="mb-3 text-[12px]">
              <strong>세션 쿠키와 인증 토큰은 보안 정책상 가져오지 않습니다.</strong> 각 사이트에서
              한 번 로그인하면 이후 유지됩니다.
            </p>
            <p className="text-[12px] text-shell-muted">
              Chrome 127 이후의 앱 바인딩 암호화(ABE)와 기기 바인딩 세션(DBSC)으로 다른 앱이 세션을
              복호화하는 것은 불가능하고, 시도하는 코드는 인포스틸러와 구별되지 않아 보안 솔루션에
              차단됩니다. 그래서 이 항목에는 켜고 끄는 선택지가 없습니다.
            </p>
          </div>
        ) : null}
      </div>

      {/* 이동 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-shell-line px-4 py-2">
        <button
          type="button"
          data-wizard-back
          disabled={stage === 1}
          className="h-7 rounded border border-shell-line px-3 text-[12px] disabled:opacity-40"
          onClick={() => setStage((current) => (current - 1) as Stage)}
        >
          이전
        </button>

        {stage < 3 ? (
          <button
            type="button"
            data-wizard-next
            className="h-7 rounded border border-shell-line px-3 text-[12px] hover:bg-shell-panel"
            onClick={() => setStage((current) => (current + 1) as Stage)}
          >
            다음
          </button>
        ) : (
          <button
            type="button"
            data-wizard-done
            className="h-7 rounded bg-shell-accent px-3 text-[12px] text-white"
            onClick={() => onClose?.()}
          >
            마침
          </button>
        )}
      </div>
    </section>
  );
}

import { useEffect, useState } from 'react';
import type { PolicyView } from '../../../../shared/types';
import { PanelFrame } from './PanelFrame';

/**
 * 정책 설정 — grants 조회·회수, 거부 목록 편집, 잠금 상태 표시.
 *
 * 관리자 잠금(`locked: true`)이면 렌더러에서 아무것도 바꿀 수 없다. 버튼을 숨기는 대신
 * 비활성으로 두고 이유를 함께 보여준다 — 왜 못 바꾸는지 알아야 담당자에게 문의할 수 있다.
 */
const SCOPE_LABEL: Record<string, string> = {
  once: '이번 한 번',
  thread: '이 작업 동안',
  domain: '이 도메인에서 항상'
};

export function PolicyPanel(): JSX.Element {
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [denyHosts, setDenyHosts] = useState('');
  const [denyTools, setDenyTools] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const load = (): void => {
    void window.helm.getPolicy().then((value) => {
      setPolicy(value);
      if (value) {
        setDenyHosts(value.deny.hosts.join(', '));
        setDenyTools(value.deny.tools.join(', '));
      }
    });
  };

  useEffect(load, []);

  const locked = policy?.locked ?? false;

  const saveDeny = (): void => {
    const parse = (value: string): string[] =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');

    void window.helm.setPolicyDeny(parse(denyHosts), parse(denyTools)).then((ok) => {
      setMessage(ok ? '거부 목록을 저장했습니다.' : '관리자 잠금 상태라 저장하지 못했습니다.');
      load();
    });
  };

  return (
    <PanelFrame
      title="정책"
      actions={
        <span
          data-policy-locked={locked}
          className={[
            'rounded px-2 py-0.5 text-[11px]',
            locked ? 'bg-amber-500/20 text-amber-500' : 'bg-shell-line text-shell-muted'
          ].join(' ')}
        >
          {locked ? '관리자 잠금' : '편집 가능'}
        </span>
      }
    >
      {message ? (
        <p className="border-b border-shell-line bg-shell-panel px-4 py-2 text-[12px]">{message}</p>
      ) : null}

      <section className="border-b border-shell-line px-4 py-3">
        <h3 className="mb-2 text-[13px] font-semibold">승인 기록 (grants)</h3>

        {policy && policy.grants.length > 0 ? (
          <ul data-grant-count={policy.grants.length} className="grid gap-1 text-[12px]">
            {policy.grants.map((grant, index) => (
              <li
                key={`${grant.subject}-${grant.host}-${grant.grantedAt}`}
                data-grant-subject={grant.subject}
                className="flex items-center gap-3"
              >
                <span className="w-40 shrink-0 truncate">{grant.subject}</span>
                <span className="min-w-0 flex-1 truncate text-shell-muted">{grant.host}</span>
                <span className="shrink-0 rounded bg-shell-line px-1.5 py-0.5 text-[11px]">
                  {SCOPE_LABEL[grant.scope] ?? grant.scope}
                </span>
                <span className="w-32 shrink-0 text-[11px] text-shell-muted">
                  {new Date(grant.grantedAt).toLocaleString('ko-KR')}
                </span>
                <button
                  type="button"
                  data-grant-revoke={index}
                  className="h-6 shrink-0 rounded border border-shell-line px-2 text-[11px] text-shell-muted hover:text-shell-text disabled:opacity-40"
                  disabled={locked}
                  onClick={() => {
                    void window.helm.revokeGrant(index).then((ok) => {
                      setMessage(ok ? '승인을 회수했습니다.' : '회수하지 못했습니다(잠금).');
                      load();
                    });
                  }}
                >
                  회수
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-shell-muted">기록된 승인이 없습니다.</p>
        )}
      </section>

      <section className="border-b border-shell-line px-4 py-3">
        <h3 className="mb-2 text-[13px] font-semibold">거부 목록</h3>
        <p className="mb-2 text-[12px] text-shell-muted">
          여기 적힌 도메인·도구는 승인 여부와 무관하게 막힙니다. 쉼표로 구분합니다.
        </p>

        <div className="grid gap-2 text-[12px]">
          <label className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-shell-muted">도메인</span>
            <input
              data-deny-hosts
              className="h-7 min-w-0 flex-1 rounded border border-shell-line bg-shell-panel px-2 outline-none focus:border-shell-accent disabled:opacity-50"
              disabled={locked}
              value={denyHosts}
              onChange={(event) => setDenyHosts(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-shell-muted">도구</span>
            <input
              data-deny-tools
              className="h-7 min-w-0 flex-1 rounded border border-shell-line bg-shell-panel px-2 outline-none focus:border-shell-accent disabled:opacity-50"
              disabled={locked}
              value={denyTools}
              onChange={(event) => setDenyTools(event.target.value)}
            />
          </label>
          <div>
            <button
              type="button"
              data-deny-save
              className="h-7 rounded bg-shell-accent px-3 text-[12px] text-white hover:opacity-90 disabled:opacity-40"
              disabled={locked}
              onClick={saveDeny}
            >
              저장
            </button>
          </div>
        </div>
      </section>

      <section className="px-4 py-3 text-[12px]">
        <h3 className="mb-2 text-[13px] font-semibold">사이트 기본 판정</h3>
        <p className="text-shell-muted">
          기본값 <strong>{policy?.sites.default ?? 'ask'}</strong> · 개별 지정{' '}
          {Object.keys(policy?.sites.hosts ?? {}).length}건 · 로그 보존{' '}
          {policy?.retentionDays ?? 30}일
        </p>
        {locked ? (
          <p className="mt-2 text-amber-500">
            관리자가 정책을 잠갔습니다. 변경이 필요하면 정보보호 담당자에게 문의하세요.
          </p>
        ) : null}
      </section>
    </PanelFrame>
  );
}

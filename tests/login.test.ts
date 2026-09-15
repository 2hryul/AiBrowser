import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type HelmDatabase } from '../src/main/persistence/Database';
import { SessionStore } from '../src/main/sessions/SessionStore';
import {
  LoginBroker,
  looksLoggedIn,
  stripElectronToken,
  type LoginDeps,
  type LoginProbe
} from '../src/main/sessions/LoginBroker';

/**
 * LoginBroker 단위 — 로그인 획득 경로 3종 (M4c 성공 조건 2의 판정 부분).
 *
 * Electron 없이 본다. 창을 띄우는 일은 주입으로 갈라 두었고, 여기서 보려는 것은
 * **무엇을 근거로 "로그인됐다" 고 말하는가** 와 **언제 거부하는가** 이다.
 * 진짜 창·진짜 IdP 는 `npm run test:login` 이 본다.
 */

let dir: string;
let db: HelmDatabase;
let sessions: SessionStore;

/** safeStorage 대역 — 단위 테스트는 Electron 없이 돈다. */
const crypt = {
  available: () => false,
  encrypt: (plain: string) => Buffer.from(plain, 'utf-8'),
  decrypt: (encrypted: Buffer) => encrypted.toString('utf-8')
};

const OK_PROBE: LoginProbe = {
  finalUrl: 'app://idp-form/app',
  hasLoginForm: false,
  hasSessionCookie: true,
  loginRequired: false
};

const FAIL_PROBE: LoginProbe = {
  finalUrl: 'app://idp-form/login',
  hasLoginForm: true,
  hasSessionCookie: false,
  loginRequired: true
};

interface Recorder {
  opened: string[];
  external: string[];
  modals: { url: string; partition: string; userAgent: string }[];
  audit: { event: string; host: string; method: string | null; detail?: string }[];
  asked: string[];
}

function makeDeps(
  overrides: Partial<LoginDeps> = {},
  answers: string[] = ['로그인함']
): { deps: LoginDeps; rec: Recorder } {
  const rec: Recorder = { opened: [], external: [], modals: [], audit: [], asked: [] };
  const queue = [...answers];

  const deps: LoginDeps = {
    sessions,
    externalLoginHosts: () => ['idp-form'],
    openInTab: async (url) => {
      rec.opened.push(url);
    },
    openModal: async (input) => {
      rec.modals.push(input);
      return { completed: true, finalUrl: 'app://idp-oauth/callback?code=x' };
    },
    openExternal: async (url) => {
      rec.external.push(url);
    },
    ask: async (question) => {
      rec.asked.push(question);
      return queue.shift() ?? '로그인함';
    },
    probe: async () => OK_PROBE,
    defaultUserAgent: () =>
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Helm/1.0 Chrome/142.0.0.0 Electron/44.3.0 Safari/537.36',
    audit: (entry) => rec.audit.push(entry),
    ...overrides
  };

  return { deps, rec };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-login-'));
  db = openDatabase(dir);
  sessions = new SessionStore(db, crypt);
  sessions.ensure('default');
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('User-Agent — 스푸핑이 아니라 토큰 제거', () => {
  it('Electron·제품 토큰만 떼고 나머지는 그대로 둔다', () => {
    const ua = stripElectronToken(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Helm/1.0 Chrome/142.0.0.0 Electron/44.3.0 Safari/537.36'
    );

    expect(ua).not.toContain('Electron/');
    expect(ua).not.toContain('Helm/');

    // 사실인 부분은 남는다 — 우리는 Chromium 이 맞다.
    expect(ua).toContain('Chrome/142.0.0.0');
    expect(ua).toContain('Windows NT 10.0');
    expect(ua).toContain('Safari/537.36');
  });

  it('다른 브라우저로 위장하지 않는다 — 없는 문자열을 만들어 넣지 않는다', () => {
    const ua = stripElectronToken('Mozilla/5.0 Chrome/142.0.0.0 Electron/44.3.0');

    expect(ua).not.toMatch(/Firefox|Edg\/|OPR\//);
    // 원문에 없던 토큰이 생기지 않는다.
    expect(ua.split(/\s+/).every((token) => 'Mozilla/5.0 Chrome/142.0.0.0'.includes(token))).toBe(true);
  });

  it('공백이 겹치지 않는다', () => {
    expect(stripElectronToken('A Electron/1.0 B')).toBe('A B');
  });
});

describe('로그인 판정 — 신호 하나로 정하지 않는다', () => {
  it('서버가 로그인 필요라고 하면 아니다', () => {
    expect(looksLoggedIn({ ...OK_PROBE, loginRequired: true })).toBe(false);
  });

  it('로그인 폼이 남아 있으면 아니다', () => {
    expect(looksLoggedIn({ ...OK_PROBE, hasLoginForm: true })).toBe(false);
  });

  it('쿠키가 없어도 로그인 화면이 사라졌으면 섰다고 본다', () => {
    // app:// 는 쿠키를 가질 수 없다(모의 포털). 쿠키만으로 판정하면 fixture 가 영영 실패한다.
    expect(looksLoggedIn({ ...OK_PROBE, hasSessionCookie: false })).toBe(true);
  });
});

describe('inapp', () => {
  it('탭에서 열고 사람을 기다린 뒤 세션 메타에 경로를 남긴다', async () => {
    const { deps, rec } = makeDeps();
    const result = await new LoginBroker(deps).start('app://idp-form/login', 'inapp', 'default');

    expect(result.status).toBe('logged_in');
    expect(rec.opened).toEqual(['app://idp-form/login']);

    // 우리가 대신 입력하지 않는다 — 사람에게 물었다는 기록이 있어야 한다.
    expect(rec.asked).toHaveLength(1);

    const info = sessions.get('default');
    expect(info?.loginMethod).toBe('inapp');
    expect(info?.loggedInAt).toBeGreaterThan(0);
  });

  it('사람이 취소하면 세션에 아무것도 남기지 않는다', async () => {
    const { deps } = makeDeps({}, ['취소']);
    const result = await new LoginBroker(deps).start('app://idp-form/login', 'inapp', 'default');

    expect(result.status).toBe('cancelled');
    expect(sessions.get('default')?.loginMethod).toBeNull();
  });

  it('검증에 실패하면 로그인됐다고 말하지 않는다', async () => {
    const { deps } = makeDeps({ probe: async () => FAIL_PROBE });
    const result = await new LoginBroker(deps).start('app://idp-form/login', 'inapp', 'default');

    expect(result.status).toBe('failed');
    expect(sessions.get('default')?.loginMethod).toBeNull();
  });
});

describe('oauth_modal', () => {
  it('서비스와 같은 partition 을 쓰고 UA 에서 Electron 을 뗀다', async () => {
    const { deps, rec } = makeDeps();
    const result = await new LoginBroker(deps).start(
      'app://idp-oauth/authorize',
      'oauth_modal',
      'default'
    );

    expect(result.status).toBe('logged_in');
    expect(rec.modals).toHaveLength(1);

    // 같은 partition 이 아니면 로그인해도 서비스 쪽에 쿠키가 안 생긴다.
    expect(rec.modals[0]?.partition).toBe(sessions.partitionOf('default'));
    expect(rec.modals[0]?.userAgent).not.toContain('Electron/');

    expect(sessions.get('default')?.loginMethod).toBe('oauth_modal');
  });

  it('모달이 완료 전에 닫히면 취소다', async () => {
    const { deps } = makeDeps({
      openModal: async () => ({ completed: false, finalUrl: 'app://idp-oauth/authorize' })
    });

    const result = await new LoginBroker(deps).start(
      'app://idp-oauth/authorize',
      'oauth_modal',
      'default'
    );

    expect(result.status).toBe('cancelled');
    expect(sessions.get('default')?.loginMethod).toBeNull();
  });
});

describe('external — 화이트리스트가 먼저다', () => {
  it('목록 밖 호스트는 브라우저를 열기 전에 거부한다', async () => {
    const { deps, rec } = makeDeps();
    const result = await new LoginBroker(deps).start('https://evil.example.com/login', 'external', 'default');

    expect(result.status).toBe('denied');

    // 열기 전에 막아야 한다 — 열고 나서 후회하면 늦다.
    expect(rec.external).toEqual([]);
    expect(rec.audit.some((entry) => entry.event === 'login_denied')).toBe(true);
  });

  it('목록 안 호스트는 실제 브라우저를 열고 돌아와 검증한다', async () => {
    const { deps, rec } = makeDeps({}, ['완료']);
    const result = await new LoginBroker(deps).start('app://idp-form/login', 'external', 'default');

    expect(result.status).toBe('logged_in');
    expect(rec.external).toEqual(['app://idp-form/login']);
    expect(sessions.get('default')?.loginMethod).toBe('external');
  });

  it('외부에서 했다 해도 Helm 세션이 안 섰으면 inapp 으로 되돌린다', async () => {
    /**
     * 이 경로의 한계를 드러내는 테스트다 — 외부 브라우저에서 로그인해도 그 쿠키는
     * 그 브라우저 것이다. "했으니 됐겠지" 로 넘기면 사용자는 로그인했다고 믿고 계속 실패한다.
     */
    let probes = 0;

    const { deps, rec } = makeDeps(
      {
        probe: async () => {
          probes += 1;
          // 외부 뒤 첫 검증은 실패, inapp 으로 되돌린 뒤에는 성공.
          return probes === 1 ? FAIL_PROBE : OK_PROBE;
        }
      },
      ['완료', '로그인함']
    );

    const result = await new LoginBroker(deps).start('app://idp-form/login', 'external', 'default');

    expect(result.status).toBe('logged_in');
    expect(result.fellBackFrom).toBe('external');
    expect(result.method).toBe('inapp');

    // 되돌린 흔적이 감사 로그에 남아야 한다.
    expect(rec.audit.some((entry) => entry.event === 'login_fallback')).toBe(true);
    expect(rec.opened).toEqual(['app://idp-form/login']);
    expect(sessions.get('default')?.loginMethod).toBe('inapp');
  });

  it('화이트리스트가 비어 있으면 external 은 아무 호스트도 통과하지 못한다', async () => {
    const { deps, rec } = makeDeps({ externalLoginHosts: () => [] });
    const result = await new LoginBroker(deps).start('app://idp-form/login', 'external', 'default');

    expect(result.status).toBe('denied');
    expect(rec.external).toEqual([]);
  });
});

describe('감사 로그', () => {
  it('비밀번호가 기록에 섞이지 않는다', async () => {
    const { deps, rec } = makeDeps();
    await new LoginBroker(deps).start('app://idp-form/login?pw=helm-fixture-pw', 'inapp', 'default');

    const blob = JSON.stringify(rec.audit);
    expect(blob).not.toContain('helm-fixture-pw');
  });
});

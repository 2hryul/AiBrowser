import type { LoginMethod, SessionStore } from './SessionStore';

/**
 * LoginBroker — 로그인을 **획득**하는 세 경로 (M4c).
 *
 * 이 파일의 존재 이유는 불변 조건 9 다: **인증정보를 다른 브라우저에서 이관하지 않는다.**
 * Chrome/Edge 의 세션 쿠키·토큰은 ABE(Chrome 127+)·DBSC 로 복호화가 불가능하고, 시도 자체가
 * 인포스틸러 패턴이라 EDR 에 걸린다. 그래서 "가져오는" 대신 **각 사이트에서 한 번 로그인**한다.
 * 그 한 번을 덜 아프게 만드는 것이 이 세 경로다.
 *
 *   - `inapp`     대상 로그인 페이지를 Helm 탭에서 연다. 대부분 이걸로 끝난다
 *   - `oauth_modal` 임베디드 웹뷰를 거부하는 IdP 용. 서비스와 **같은 partition** 을 쓰는
 *                 모달 창에서 표준 redirect OAuth 를 끝낸다
 *   - `external`  실제 Chrome/Edge 를 띄워 인증만 마치게 하고, 돌아와서 Helm 세션이
 *                 실제로 섰는지 **검증**한다. 검증 실패면 `inapp` 으로 되돌린다
 *
 * ## UA 에 대하여 — 스푸핑이 아니다
 *
 * `oauth_modal` 은 Electron 기본 UA 에서 **`Electron/x.y` 토큰만 뗀** 표준 Chromium UA 를 쓴다.
 * 우리가 Chromium 인 것은 사실이고 거짓말을 보태지 않는다. 다른 브라우저인 척하는 문자열을
 * 만들지 않는다(FIXED DECISIONS). 이 구분이 무너지면 봇 탐지 우회가 되고, 그건 금지다.
 *
 * ## 이 파일이 만지지 않는 것
 *
 * 비밀번호·토큰은 읽지도 쓰지도 않는다. 로그인의 결과는 **partition 안의 쿠키**로만 남고,
 * 우리가 기록하는 것은 "어느 경로로 언제 로그인했는가" 뿐이다(SessionStore 메타).
 */

export interface LoginTarget {
  url: string;
  host: string;
}

/** 로그인이 실제로 섰는지 보는 신호. 한 가지로는 못 정한다. */
export interface LoginProbe {
  /** 확인차 열어 본 최종 주소 — 로그인 화면으로 되밀렸는지 본다 */
  finalUrl: string;
  /** 페이지에 로그인 폼이 남아 있는가 */
  hasLoginForm: boolean;
  /** partition 에 이 호스트 쿠키가 생겼는가 */
  hasSessionCookie: boolean;
  /** 서버가 "로그인이 필요하다" 고 말했는가(헤더·본문 표시) */
  loginRequired: boolean;
}

export interface LoginDeps {
  sessions: SessionStore;
  /** 정책의 외부 폴백 화이트리스트. 비어 있으면 external 은 쓰지 않는다는 뜻이다. */
  externalLoginHosts: () => readonly string[];
  /** 대상 주소를 현재 세션 탭에서 연다(inapp). */
  openInTab: (url: string) => Promise<void>;
  /** 서비스와 같은 partition 을 쓰는 모달 창을 열고, 닫힐 때까지 기다린다. */
  openModal: (input: { url: string; partition: string; userAgent: string }) => Promise<ModalResult>;
  /** 실제 기본 브라우저를 연다(external). */
  openExternal: (url: string) => Promise<void>;
  /** 사람에게 묻는다 — external 은 "다 했다" 를 사람만 안다. */
  ask: (question: string, options: string[]) => Promise<string>;
  /** 로그인이 섰는지 확인한다. */
  probe: (target: LoginTarget) => Promise<LoginProbe>;
  /** Electron 기본 UA. 여기서 Electron 토큰만 뗀다. */
  defaultUserAgent: () => string;
  audit: (entry: { event: string; host: string; method: LoginMethod | null; detail?: string }) => void;
}

export interface ModalResult {
  /** 모달이 redirect 를 끝내고 닫혔는가 */
  completed: boolean;
  /** 마지막으로 머문 주소 */
  finalUrl: string;
}

export type LoginStatus = 'logged_in' | 'denied' | 'failed' | 'cancelled';

export interface LoginResult {
  status: LoginStatus;
  method: LoginMethod;
  host: string;
  /** 처음 고른 경로가 막혀 다른 경로로 갔다면 그 사실 */
  fellBackFrom?: LoginMethod;
  reason: string;
}

/**
 * Electron 토큰만 떼어 낸 표준 Chromium UA.
 *
 * `Helm/1.0 Electron/44.3.0` 처럼 붙어 있는 **제품 토큰만** 지운다. Chrome 버전이나
 * 플랫폼 문자열은 그대로 둔다 — 그것들은 사실이다.
 */
export function stripElectronToken(userAgent: string): string {
  return userAgent
    .replace(/\s*Electron\/[\d.]+/gi, '')
    .replace(/\s*Helm\/[\d.]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 로그인이 섰다고 볼 수 있는가. 신호 하나로는 정하지 않는다. */
export function looksLoggedIn(probe: LoginProbe): boolean {
  if (probe.loginRequired) return false;
  if (probe.hasLoginForm) return false;

  // 쿠키가 생겼으면 확실하다. 없더라도 로그인 화면이 사라졌으면 섰다고 본다 —
  // `app://` 처럼 쿠키를 가질 수 없는 스킴이 있다(모의 포털).
  return true;
}

export class LoginBroker {
  private readonly deps: LoginDeps;

  constructor(deps: LoginDeps) {
    this.deps = deps;
  }

  async start(url: string, method: LoginMethod, sessionName: string): Promise<LoginResult> {
    const host = hostOf(url);

    if (host === '') {
      return { status: 'failed', method, host, reason: '주소에서 호스트를 읽을 수 없습니다' };
    }

    const target: LoginTarget = { url, host };

    if (method === 'external') return this.external(target, sessionName);
    if (method === 'oauth_modal') return this.oauthModal(target, sessionName);
    return this.inapp(target, sessionName);
  }

  // ── inapp — 기본 경로 ──
  private async inapp(target: LoginTarget, sessionName: string): Promise<LoginResult> {
    this.deps.audit({ event: 'login_start', host: target.host, method: 'inapp' });

    await this.deps.openInTab(target.url);

    // 사람이 직접 입력할 때까지 기다린다. 우리가 대신 치지 않는다.
    const answer = await this.deps.ask(`${target.host} 에 로그인한 뒤 알려 주세요.`, [
      '로그인함',
      '취소'
    ]);

    if (answer === '취소') {
      this.deps.audit({ event: 'login_cancelled', host: target.host, method: 'inapp' });
      return { status: 'cancelled', method: 'inapp', host: target.host, reason: '사람이 취소했습니다' };
    }

    return this.settle(target, 'inapp', sessionName);
  }

  // ── oauth_modal — 임베디드를 거부하는 IdP ──
  private async oauthModal(target: LoginTarget, sessionName: string): Promise<LoginResult> {
    this.deps.audit({ event: 'login_start', host: target.host, method: 'oauth_modal' });

    const partition = this.deps.sessions.partitionOf(sessionName);
    const userAgent = stripElectronToken(this.deps.defaultUserAgent());

    const modal = await this.deps.openModal({ url: target.url, partition, userAgent });

    if (!modal.completed) {
      this.deps.audit({
        event: 'login_failed',
        host: target.host,
        method: 'oauth_modal',
        detail: '모달이 완료 전에 닫혔습니다'
      });
      return {
        status: 'cancelled',
        method: 'oauth_modal',
        host: target.host,
        reason: '모달이 완료 전에 닫혔습니다'
      };
    }

    return this.settle(target, 'oauth_modal', sessionName);
  }

  // ── external — 실제 브라우저로 인증만 ──
  private async external(target: LoginTarget, sessionName: string): Promise<LoginResult> {
    /**
     * 화이트리스트 밖이면 **열기 전에** 거부한다.
     *
     * 외부 브라우저를 여는 것은 우리 통제 밖으로 사용자를 내보내는 일이다. 어느 사이트로든
     * 열 수 있게 두면 피싱 주소를 그럴듯하게 띄우는 통로가 된다. 그래서 목록에 적힌 호스트만.
     */
    const allowed = this.deps.externalLoginHosts();

    if (!allowed.includes(target.host)) {
      this.deps.audit({
        event: 'login_denied',
        host: target.host,
        method: 'external',
        detail: 'externalLoginHosts 화이트리스트 밖'
      });

      return {
        status: 'denied',
        method: 'external',
        host: target.host,
        reason: `${target.host} 은(는) 외부 브라우저 로그인이 허용된 호스트가 아닙니다`
      };
    }

    this.deps.audit({ event: 'login_start', host: target.host, method: 'external' });
    await this.deps.openExternal(target.url);

    const answer = await this.deps.ask(
      `기본 브라우저에서 ${target.host} 로그인을 마친 뒤 알려 주세요.`,
      ['완료', '취소']
    );

    if (answer === '취소') {
      this.deps.audit({ event: 'login_cancelled', host: target.host, method: 'external' });
      return { status: 'cancelled', method: 'external', host: target.host, reason: '사람이 취소했습니다' };
    }

    const settled = await this.settle(target, 'external', sessionName);
    if (settled.status === 'logged_in') return settled;

    /**
     * 외부에서 로그인해도 **Helm 세션은 서지 않는다** — 쿠키는 그 브라우저 것이다.
     * 이것이 이 경로의 한계이고, 그래서 검증에 실패하면 조용히 두지 않고 `inapp` 으로 되돌린다.
     * "외부에서 했으니 됐겠지" 로 넘기면 사용자는 로그인했다고 믿고 계속 실패한다.
     */
    this.deps.audit({
      event: 'login_fallback',
      host: target.host,
      method: 'inapp',
      detail: 'external 검증 실패 → inapp'
    });

    const fallback = await this.inapp(target, sessionName);
    return { ...fallback, fellBackFrom: 'external' };
  }

  /** 공통 마무리 — 정말 로그인이 섰는지 확인하고, 섰으면 세션 메타에 남긴다. */
  private async settle(
    target: LoginTarget,
    method: LoginMethod,
    sessionName: string
  ): Promise<LoginResult> {
    const probe = await this.deps.probe(target);

    if (!looksLoggedIn(probe)) {
      this.deps.audit({
        event: 'login_failed',
        host: target.host,
        method,
        detail: `검증 실패 (${probe.finalUrl})`
      });

      return {
        status: 'failed',
        method,
        host: target.host,
        reason: '로그인 상태를 확인하지 못했습니다'
      };
    }

    // 비밀번호·토큰이 아니라 "경로와 시각" 만 남는다.
    this.deps.sessions.recordLogin(sessionName, method, target.host);
    this.deps.audit({ event: 'login_ok', host: target.host, method });

    return { status: 'logged_in', method, host: target.host, reason: '로그인이 확인되었습니다' };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

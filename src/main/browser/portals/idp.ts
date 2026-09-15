import { esc, html, notFound, page } from './html';

/**
 * 모의 IdP 2종 — 로그인 획득 경로 3종(M4c)을 시험하기 위한 fixture.
 *
 * 두 개를 나눠 만든 이유가 M4c 의 전부다.
 *
 *   - `idp-form`: 평범한 폼 로그인. 앱 안에서 그대로 열면 된다(`inapp`)
 *   - `idp-oauth`: **임베디드 웹뷰를 거부하는** IdP. 실제 구글·MS 계정이 이렇게 군다.
 *     일반 탭에서 열면 "안전하지 않은 앱" 을 돌려주고, 모달 창에서만 표준 redirect 로
 *     code 를 내준다 → `oauth_modal` 경로가 필요한 이유
 *
 * 거부 판정은 **User-Agent 의 `Electron/` 토큰**과 `window.opener` 유무로 한다.
 * 이것을 뚫는 방법은 두 가지인데 하나만 허용된다:
 *   - 금지: 다른 브라우저인 척 UA 를 위조한다(불변 조건 9 — 봇 탐지 우회)
 *   - 허용: Electron 토큰만 떼어 낸 **표준 Chromium UA** 로 모달을 연다.
 *     우리가 Chromium 인 것은 사실이고, 거짓말을 보태지 않는다
 *
 * 세션은 fixture 내부 상태로 둔다 — `app://` 는 쿠키를 가질 수 없다(PortalProtocol 주석).
 */

/** 발급한 authorization code → 아직 교환되지 않았는가 */
const codes = new Map<string, { at: number; used: boolean }>();

/** 로그인이 안착한 계정. 실제 쿠키가 아니라 fixture 상태다. */
const sessions = new Set<string>();

const USER = 'hong@example.co.kr';
const PASSWORD = 'helm-fixture-pw';

export function idpReset(): void {
  codes.clear();
  sessions.clear();
}

export function idpHasSession(host: string): boolean {
  return sessions.has(host);
}

/**
 * 임베디드 웹뷰인가.
 *
 * `Electron/` 토큰이 남아 있으면 앱 안에 박힌 웹뷰로 본다. 실제 IdP 가 쓰는 신호와 같다.
 */
export function looksEmbedded(userAgent: string): boolean {
  return /Electron\//i.test(userAgent);
}

function loginForm(host: string, next: string, error: string): string {
  return page(
    '로그인',
    `<header>모의 IdP — 폼 로그인</header>
     <main>
       ${error === '' ? '' : `<p id="login-error" style="color:#c00">${esc(error)}</p>`}
       <form id="login-form" method="post" action="app://${esc(host)}/login">
         <input type="hidden" name="next" value="${esc(next)}" />
         <label>아이디 <input id="login-id" name="id" type="text" autocomplete="username" /></label>
         <label>비밀번호 <input id="login-pw" name="pw" type="password" autocomplete="current-password" /></label>
         <button id="login-submit" type="submit">로그인</button>
       </form>
       <p class="hint">fixture 계정: ${esc(USER)}</p>
     </main>`
  );
}

function landed(note: string): string {
  return page(
    '로그인 완료',
    `<header>모의 IdP</header>
     <main>
       <h1 id="signed-in">로그인됨</h1>
       <p id="signed-in-user">${esc(USER)}</p>
       <p>${esc(note)}</p>
     </main>`
  );
}

/**
 * 임베디드 거부 화면.
 *
 * 실제 IdP 가 그러듯 **에러가 아니라 200 으로 안내 페이지**를 준다. 그래서 도구 입장에서는
 * "성공한 것처럼 보이는데 로그인은 안 된" 상태가 된다 — `oauth_modal` 이 필요한 이유를
 * 실제로 재현하려면 이 모양이어야 한다.
 */
function unsafeApp(): string {
  return page(
    '안전하지 않은 앱',
    `<header>모의 IdP — OAuth</header>
     <main>
       <h1 id="embedded-blocked">안전하지 않은 앱</h1>
       <p>이 브라우저는 앱에 포함된 웹뷰로 보입니다. 보안을 위해 로그인할 수 없습니다.</p>
       <p>기본 브라우저나 별도 창에서 다시 시도하세요.</p>
     </main>`
  );
}

// ─────────────────────────────────────────────────────────────
// idp-form — 평범한 폼 로그인 (inapp / external 경로가 쓴다)
// ─────────────────────────────────────────────────────────────

export async function routeIdpForm(url: URL, request: GlobalRequest): Promise<Response> {
  const host = 'idp-form';

  if (url.pathname === '/' || url.pathname === '/login') {
    if (request.method === 'POST') {
      const body = await request.text();
      const form = new URLSearchParams(body);

      // 비밀번호는 비교만 하고 어디에도 남기지 않는다 — fixture 라도 같은 규칙을 지킨다.
      if (form.get('id') === USER && form.get('pw') === PASSWORD) {
        sessions.add(host);
        return html(landed('폼 로그인으로 들어왔습니다.'));
      }

      return html(loginForm(host, form.get('next') ?? '/', '아이디 또는 비밀번호가 다릅니다.'));
    }

    if (sessions.has(host)) return html(landed('이미 로그인되어 있습니다.'));
    return html(loginForm(host, url.searchParams.get('next') ?? '/', ''));
  }

  // 보호 자원 — 로그인 전에는 로그인 화면으로 되민다(세션 만료 휴리스틱의 재료).
  if (url.pathname === '/app') {
    if (!sessions.has(host)) {
      return html(loginForm(host, '/app', ''), 200, {
        // 리다이렉트 없이도 "로그인 화면으로 밀렸다" 를 알 수 있게 표시를 남긴다.
        'x-helm-login-required': '1'
      });
    }
    return html(landed('보호된 화면입니다.'));
  }

  if (url.pathname === '/logout') {
    sessions.delete(host);
    return html(loginForm(host, '/', '로그아웃되었습니다.'));
  }

  return notFound();
}

// ─────────────────────────────────────────────────────────────
// idp-oauth — 임베디드 웹뷰를 거부하는 OAuth
// ─────────────────────────────────────────────────────────────

export async function routeIdpOauth(url: URL, request: GlobalRequest): Promise<Response> {
  const host = 'idp-oauth';
  const userAgent = request.headers.get('user-agent') ?? '';

  if (url.pathname === '/authorize') {
    // 임베디드로 보이면 code 를 내주지 않는다. 모달은 UA 에서 Electron 토큰을 뗀 채 온다.
    if (looksEmbedded(userAgent)) return html(unsafeApp());

    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';

    if (redirectUri === '') return notFound();

    return html(
      page(
        '권한 허용',
        `<header>모의 IdP — OAuth</header>
         <main>
           <h1>Helm 이 계정에 접근하려 합니다</h1>
           <p id="oauth-user">${esc(USER)}</p>
           <form id="consent-form" method="get" action="app://${esc(host)}/grant">
             <input type="hidden" name="redirect_uri" value="${esc(redirectUri)}" />
             <input type="hidden" name="state" value="${esc(state)}" />
             <button id="oauth-allow" type="submit">허용</button>
           </form>
         </main>`
      )
    );
  }

  if (url.pathname === '/grant') {
    if (looksEmbedded(userAgent)) return html(unsafeApp());

    const code = `code-${Math.random().toString(36).slice(2, 10)}`;
    codes.set(code, { at: Date.now(), used: false });

    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const target = `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=${code}&state=${encodeURIComponent(state)}`;

    // 표준 redirect. 모달이 이 주소로 이동하는 것을 보고 완료를 판정한다.
    return new Response(null, { status: 302, headers: { location: target } });
  }

  /** 서비스 쪽 콜백 — code 를 한 번만 교환한다. */
  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code') ?? '';
    const entry = codes.get(code);

    if (!entry || entry.used) {
      return html(
        page('로그인 실패', '<main><h1 id="oauth-failed">코드가 유효하지 않습니다</h1></main>')
      );
    }

    entry.used = true;
    sessions.add(host);

    return html(landed('OAuth 모달로 들어왔습니다.'));
  }

  if (url.pathname === '/' || url.pathname === '/app') {
    if (!sessions.has(host)) {
      if (looksEmbedded(userAgent)) return html(unsafeApp());
      return html(
        page(
          '로그인 필요',
          `<main><h1 id="need-login">로그인이 필요합니다</h1>
           <a id="oauth-start" href="app://${esc(host)}/authorize?redirect_uri=app://${esc(host)}/callback&state=x">로그인</a>
           </main>`
        )
      );
    }
    return html(landed('보호된 화면입니다.'));
  }

  if (url.pathname === '/logout') {
    sessions.delete(host);
    return html(page('로그아웃', '<main><h1 id="signed-out">로그아웃되었습니다</h1></main>'));
  }

  return notFound();
}

/** 테스트가 fixture 상태를 직접 보는 통로. */
export const idpHooks = {
  reset: idpReset,
  hasSession: idpHasSession,
  looksEmbedded,
  user: USER,
  password: PASSWORD
};

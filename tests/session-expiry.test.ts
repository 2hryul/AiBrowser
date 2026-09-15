import { describe, expect, it } from 'vitest';
import { loginGateOf } from '../src/main/sessions/SessionExpiry';

/**
 * 세션 만료 판정(M4c) — 에이전트 밖에서 쓰는 로그인 게이트 휴리스틱.
 *
 * 에이전트의 `loginGate` 와 같은 M2 휴리스틱을 쓰되, 리다이렉트 없이 200 으로
 * 로그인 폼을 되돌려주는 사이트(모의 IdP 의 /app)도 잡아야 한다.
 */
describe('loginGateOf', () => {
  it('로그인 주소로 리다이렉트되면 게이트다', () => {
    expect(
      loginGateOf({
        requestedUrl: 'app://portal-a/list?page=2',
        finalUrl: 'app://portal-a/login?next=list',
        hasLoginForm: true
      })
    ).toBe('app://portal-a/login?next=list');
  });

  it('리다이렉트 없이 200 으로 로그인 폼이 나타나도 게이트다 (모의 IdP /app)', () => {
    expect(
      loginGateOf({
        requestedUrl: 'app://idp-form/app',
        finalUrl: 'app://idp-form/app',
        hasLoginForm: true
      })
    ).toBe('app://idp-form/app');
  });

  it('처음부터 로그인 주소로 간 이동은 게이트가 아니다 — login_start(inapp) 가 여는 탭', () => {
    expect(
      loginGateOf({
        requestedUrl: 'app://idp-form/login',
        finalUrl: 'app://idp-form/login',
        hasLoginForm: true
      })
    ).toBeNull();
  });

  it('로그인 폼이 없는 보통 페이지는 게이트가 아니다', () => {
    expect(
      loginGateOf({
        requestedUrl: 'app://portal-a/list',
        finalUrl: 'app://portal-a/list',
        hasLoginForm: false
      })
    ).toBeNull();
  });

  it('로그인 주소 자체에 폼이 있는 도착은 리다이렉트 규칙만 탄다 — 폼 규칙으로 중복 판정하지 않는다', () => {
    // 요청은 일반 주소, 도착은 로그인 주소: 1번 규칙(리다이렉트)이 잡는다.
    expect(
      loginGateOf({
        requestedUrl: 'app://portal-a/list',
        finalUrl: 'app://portal-a/login',
        hasLoginForm: true
      })
    ).toBe('app://portal-a/login');

    // 요청·도착이 같은 로그인 주소: 사람이 로그인하러 간 것 — 게이트 아님.
    expect(
      loginGateOf({
        requestedUrl: 'app://sso.example.co.kr/signin',
        finalUrl: 'app://sso.example.co.kr/signin',
        hasLoginForm: true
      })
    ).toBeNull();
  });
});

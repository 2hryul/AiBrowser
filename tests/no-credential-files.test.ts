import { RuleTester, type Rule } from 'eslint';
import { describe, it } from 'vitest';
import rules from '../eslint-rules/no-credential-files.mjs';

/**
 * 커스텀 lint 규칙 자체의 테스트.
 * 규칙이 통과한다는 사실만으로는 "규칙이 작동한다"를 증명하지 못한다 —
 * 실제 위반 코드를 잡는지, 정상 코드를 오탐하지 않는지 둘 다 본다.
 */

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' }
});

// 규칙은 .mjs(타입 없음)라 RuleTester 시그니처에 맞춰 좁혀 준다.
const rule = rules.rules['no-credential-files'] as unknown as Rule.RuleModule;

describe('no-credential-files 규칙', () => {
  it('위반은 잡고 정상 코드는 통과시킨다', () => {
    ruleTester.run('no-credential-files', rule, {
      valid: [
        // 가져와도 되는 파일 이름
        { code: "const f = 'Bookmarks';" },
        { code: "const f = 'History';" },
        { code: "const f = 'Web Data';" },
        { code: "const p = path.join(dir, 'Web Data');" },
        // Electron 정식 API — session.cookies 는 우리 쿠키 저장소다
        { code: 'await session.cookies.set({ url, name, value });' },
        { code: 'const jar = partition.cookies;' },
        { code: "const kind = 'cookies';" },
        // 무해한 단어
        { code: "const s = 'state';" },
        { code: "const s = 'local';" }
      ],
      invalid: [
        {
          code: "const p = 'C:/Users/x/AppData/Local/Google/Chrome/User Data/Default/Cookies';",
          errors: 1
        },
        { code: "const p = path.join(dir, 'Cookies');", errors: 1 },
        { code: "const p = 'Cookies';", errors: 1 },
        { code: "const p = 'Login Data';", errors: 1 },
        { code: "const p = 'login data for account';", errors: 1 },
        { code: "const p = 'Local State';", errors: 1 },
        { code: "const p = 'Affiliation Database';", errors: 1 },
        { code: 'const p = `${base}/Local State`;', errors: 1 },
        { code: "const k = 'os_crypt';", errors: 1 },
        { code: "const k = 'encrypted_key';", errors: 1 },
        { code: "const k = 'CryptUnprotectData';", errors: 1 },
        { code: "const k = 'app-bound-encryption';", errors: 1 },
        // 식별자 우회
        { code: 'const loginData = read();', errors: 1 },
        { code: 'const v = profile.localState;', errors: 1 },
        { code: 'const v = osCrypt.decrypt(x);', errors: 1 },
        // 주석만 있고 감사 호출이 없으면 예외가 열리지 않는다 — 주석 한 줄로 규칙을 무력화할 수 없다.
        { code: "// policy:password-import\nconst p = 'Login Data';", errors: 1 },
        // 감사 호출만 있고 정책 주석이 없어도 안 된다.
        { code: "audit({ what: 'x' });\nconst p = 'Login Data';", errors: 1 }
      ]
    });
  });

  /**
   * 좁은 예외 (GOAL-M4c FIXED DECISIONS) — `Login Data` 는 비밀번호 임포트 경로에서만,
   * 그것도 정책 주석과 감사 호출이 **둘 다** 있을 때만 통과한다.
   */
  it('비밀번호 임포트 경로에서만 Login Data 예외가 열린다', () => {
    const marked = (body: string): string =>
      `// policy:password-import\naudit({ what: 'password_import' });\n${body}`;

    ruleTester.run('no-credential-files', rule, {
      valid: [
        { code: marked("const p = 'Login Data';") },
        { code: marked("const p = path.join(dir, 'Login Data');") },
        { code: marked('const loginData = read();') }
      ],
      invalid: [
        // 예외는 Login Data 만 덮는다. 쿠키·Local State 는 그 경로에서도 막힌다.
        { code: marked("const p = 'Cookies';"), errors: 1 },
        { code: marked("const p = 'Local State';"), errors: 1 },
        // 복호화 관용구는 예외 밖이다 — 그래서 DPAPI 경로는 이 규칙 아래에서 쓸 수 없고,
        // 비밀번호 임포트는 Chrome 내보내기 CSV 로만 구현된다.
        { code: marked("const k = 'CryptUnprotectData';"), errors: 1 },
        { code: marked("const k = 'DPAPI';"), errors: 1 },
        { code: marked("const k = 'os_crypt';"), errors: 1 }
      ]
    });
  });
});

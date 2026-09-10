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
        { code: 'const v = osCrypt.decrypt(x);', errors: 1 }
      ]
    });
  });
});

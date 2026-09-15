import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * M4c 최초 구동 임포트 E2E — `npm run test:import`.
 *
 * 검증 대상(GOAL-M4c 성공 조건 3):
 *   - fixture Chrome·Edge 프로필에서 북마크·기록·자동완성 건수 일치
 *   - allowPasswordImport:false → 마법사에 비밀번호 항목 부재(DOM 검사, OCR 아님)
 *   - allowPasswordImport:true + 동의 → CSV 3건이 자격증명 대역(mock)에 저장,
 *     원본 CSV 부재, 감사 로그 count 3
 *   - 파일 접근 로그에 자격증명 파일(미끼) 접근 0건 — 이름 목록은
 *     fixtures/profiles/skip-names.json 의 **데이터**로만 존재한다(lint 규칙 유지)
 *   - 마법사 DOM 어디에도 fixture 비밀번호 문자열이 없다 + 스크린샷 증거
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm4c');
const PROFILE_OFF = path.join(ROOT, '.import-profile');
const PROFILE_ON = path.join(ROOT, '.import-profile-pw');
const FIXTURE_ROOT = path.join(ROOT, 'fixtures', 'profiles');
const PROFILE_FIXTURES = path.join(FIXTURE_ROOT, 'localappdata');

/** 가져오기가 절대 열면 안 되는 파일 이름 — 코드가 아니라 fixture 데이터에서 읽는다. */
const FORBIDDEN_NAMES = (
  JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'skip-names.json'), 'utf-8')) as {
    names: string[];
  }
).names.map((name) => name.toLowerCase());

const EXPECTED = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_ROOT, 'expected.json'), 'utf-8')
) as Record<string, { bookmarks: number; visits: number; autofill: number; decoys: number }>;

/** fixture CSV 의 비밀번호 값 조각 — 이 문자열이 마법사 DOM 에 보이면 실패다. */
const PASSWORD_MARKERS = ['gw-pw', 'with-comma', 'mail-pw-42', 'quoted', 'orphan-pw'];

const summary: Record<string, unknown> = {};

let app: ElectronApplication;

test.describe.configure({ mode: 'serial' });

function seedPolicy(profileDir: string, allowPasswordImport: boolean): void {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'policy.json'),
    `${JSON.stringify(
      {
        locked: false,
        sites: { default: 'ask', hosts: { home: 'allow', fixtures: 'allow' } },
        deny: { hosts: [], tools: [] },
        tools: { javascript: 'ask' },
        allowPasswordImport,
        externalLoginHosts: [],
        grants: [],
        retentionDays: 30
      },
      null,
      2
    )}\n`,
    'utf-8'
  );
}

function launchApp(profileDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      HELM_E2E: '1',
      HELM_USER_DATA_DIR: profileDir,
      // discoverProfiles 가 볼 %LOCALAPPDATA% 를 fixture 로 바꿔 끼운다.
      HELM_PROFILE_ROOT: PROFILE_FIXTURES
    }
  });
}

async function waitForWindow(target: ElectronApplication): Promise<void> {
  await expect
    .poll(
      () =>
        target.evaluate(({ BaseWindow }) => {
          const win = BaseWindow.getAllWindows()[0];
          return win ? win.isVisible() : false;
        }),
      { message: '메인 윈도우가 표시되기를 대기', timeout: 30_000 }
    )
    .toBe(true);
}

/** 셸 DOM 에서 표현식을 평가한다. */
function shellEval(expression: string): Promise<unknown> {
  return app.evaluate(async (_e, expr) => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[import-e2e] 셸 뷰 없음');
    return (await shell.webContents.executeJavaScript(expr)) as unknown;
  }, expression);
}

async function openWizard(): Promise<void> {
  await app.evaluate(() => globalThis.__helm?.setPanel('bookmarks'));
  await expect
    .poll(() => shellEval('!!document.querySelector("[data-import-wizard]")'), {
      message: '가져오기 마법사를 대기',
      timeout: 15_000
    })
    .toBe(true);
}

async function saveShellShot(fileName: string): Promise<void> {
  // DOM 판정 직후에는 컴포지터가 아직 안 그렸을 수 있다 — 증거 스크린샷이라 한 박자 기다린다.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const shot = await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) return '';
    const image = await shell.webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(ARTIFACTS, fileName), Buffer.from(shot, 'base64'));
}

test.beforeAll(async () => {
  fs.rmSync(PROFILE_OFF, { recursive: true, force: true });
  fs.rmSync(PROFILE_ON, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  seedPolicy(PROFILE_OFF, false);
  seedPolicy(PROFILE_ON, true);
  summary['ranAt'] = new Date().toISOString();

  app = await launchApp(PROFILE_OFF);
  await waitForWindow(app);
});

test.afterAll(async () => {
  fs.writeFileSync(
    path.join(ARTIFACTS, 'import-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf-8'
  );
  await app.close();
});

// ─────────────────────────────────────────────────────────────
// 건수 일치 + 자격증명 파일 접근 0건
// ─────────────────────────────────────────────────────────────

test('[M4c] 임포트 — fixture 건수가 일치하고 자격증명 파일은 열지 않는다', async () => {
  const profiles = await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[import-e2e] 셸 뷰 없음');
    return JSON.parse(
      (await shell.webContents.executeJavaScript(
        'window.helm.discoverProfiles().then((p) => JSON.stringify(p))'
      )) as string
    ) as { browser: string; name: string; dir: string }[];
  });

  expect(profiles.map((p) => `${p.browser}/${p.name}`).sort()).toEqual([
    'chrome/Default',
    'edge/Default'
  ]);

  const runImport = async (dir: string): Promise<Record<string, unknown>> => {
    const raw = await app.evaluate(async (_e, target) => {
      const shell = globalThis.__helm?.getShell();
      if (!shell) throw new Error('[import-e2e] 셸 뷰 없음');
      return (await shell.webContents.executeJavaScript(
        `window.helm.runImport(${JSON.stringify(target)}).then((r) => JSON.stringify(r))`
      )) as string;
    }, dir);
    return JSON.parse(raw) as Record<string, unknown>;
  };

  for (const browser of ['chrome', 'edge'] as const) {
    const profile = profiles.find((p) => p.browser === browser);
    expect(profile).toBeDefined();

    const result = await runImport(profile?.dir ?? '');
    const expected = EXPECTED[browser];

    expect(result['errors']).toEqual([]);
    expect(result['bookmarks']).toBe(expected?.bookmarks);
    expect(result['history']).toBe(expected?.visits);
    expect(result['autofill']).toBe(expected?.autofill);
    expect((result['skippedCredentialFiles'] as string[]).length).toBe(expected?.decoys);

    summary[`import-${browser}`] = result;
  }

  // 파일 접근 로그 — fixture 프로필 안에서 읽힌 파일과 금지 이름의 교집합은 0 이어야 한다.
  const accesses = await app.evaluate(() => globalThis.__helm?.fileAccesses() ?? []);
  const underFixtures = accesses.filter((file) =>
    file.toLowerCase().startsWith(PROFILE_FIXTURES.toLowerCase())
  );
  const forbidden = underFixtures.filter((file) =>
    FORBIDDEN_NAMES.includes(path.basename(file).toLowerCase())
  );

  // 기록 자체가 작동하는지 먼저 본다 — 0 건 판정이 "기록이 안 됐다" 의 다른 이름이면 안 된다.
  expect(underFixtures.length).toBeGreaterThan(0);
  expect(forbidden).toEqual([]);

  summary['fileAccess'] = {
    readUnderFixtures: underFixtures.map((file) => path.basename(file)),
    forbiddenTouched: forbidden.length
  };
});

// ─────────────────────────────────────────────────────────────
// 정책 꺼짐 → 비밀번호 항목 부재 (DOM 검사)
// ─────────────────────────────────────────────────────────────

test('[M4c] 마법사 — 정책이 꺼져 있으면 비밀번호 항목이 없다', async () => {
  await openWizard();

  // 2단계로 이동 — 단계는 보이되 내용은 "관리자 정책으로 비활성" 뿐이어야 한다.
  await shellEval('(() => { document.querySelector("[data-wizard-next]").click(); return true; })()');

  await expect
    .poll(() => shellEval('!!document.querySelector("[data-wizard-passwords-disabled]")'), {
      message: '비활성 안내를 대기',
      timeout: 10_000
    })
    .toBe(true);

  const dom = (await shellEval(
    `JSON.stringify({
       csvInput: !!document.querySelector('[data-wizard-csv]'),
       consent: !!document.querySelector('[data-wizard-consent]'),
       importButton: !!document.querySelector('[data-wizard-import-passwords]')
     })`
  )) as string;

  expect(JSON.parse(dom)).toEqual({ csvInput: false, consent: false, importButton: false });

  await saveShellShot('wizard-passwords-disabled.png');
  summary['wizardDisabled'] = { dom: JSON.parse(dom), screenshot: 'wizard-passwords-disabled.png' };
});

// ─────────────────────────────────────────────────────────────
// 정책 켜짐 + 동의 → CSV → 자격증명 대역, 원본 삭제, 로그
// ─────────────────────────────────────────────────────────────

test('[M4c] 마법사 — 동의 후 CSV 3건을 옮기고 원본과 화면에 비밀번호가 없다', async () => {
  await app.close();
  app = await launchApp(PROFILE_ON);
  await waitForWindow(app);

  // 임포트는 원본을 지운다(shred). fixture 를 지키기 위해 사본으로 진행한다.
  const csvCopy = path.join(PROFILE_ON, 'passwords-export.csv');
  fs.copyFileSync(path.join(FIXTURE_ROOT, 'passwords.csv'), csvCopy);

  await openWizard();
  await shellEval('(() => { document.querySelector("[data-wizard-next]").click(); return true; })()');

  await expect
    .poll(() => shellEval('!!document.querySelector("[data-wizard-csv]")'), {
      message: 'CSV 입력이 보이기를 대기',
      timeout: 10_000
    })
    .toBe(true);

  // React 제어 입력이라 네이티브 setter + input 이벤트로 채운다. 동의는 클릭.
  await shellEval(
    `(() => {
       const input = document.querySelector('[data-wizard-csv]');
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(input, ${JSON.stringify(csvCopy)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       document.querySelector('[data-wizard-consent]').click();
       return true;
     })()`
  );

  await shellEval(
    '(() => { document.querySelector("[data-wizard-import-passwords]").click(); return true; })()'
  );

  await expect
    .poll(
      () =>
        shellEval(
          '(document.querySelector("[data-wizard-password-result]") || {}).getAttribute ? document.querySelector("[data-wizard-password-result]").getAttribute("data-wizard-password-result") : null'
        ),
      { message: '비밀번호 임포트 결과를 대기', timeout: 20_000 }
    )
    .toBe('3');

  // 1) 자격증명 대역(mock)에 3건 — 값은 나오지 않는다.
  const stored = await app.evaluate(() => globalThis.__helm?.credentialTargets() ?? []);
  expect(stored.length).toBe(3);
  for (const entry of stored) {
    expect(entry.target.startsWith('Helm:')).toBe(true);
  }

  // 2) 원본 CSV 부재 — 0 으로 덮은 뒤 지운다.
  expect(fs.existsSync(csvCopy)).toBe(false);

  // 3) 감사 로그 — 건수·출처만 남는다.
  const auditEntry = await app.evaluate(
    () =>
      globalThis.__helm
        ?.getAudit()
        ?.read()
        .find((entry) => entry.tool === 'import_passwords') ?? null
  );
  expect(auditEntry).not.toBeNull();
  expect((auditEntry as { result: { count: number } }).result.count).toBe(3);

  // 4) 마법사 DOM 어디에도 비밀번호 문자열이 없다(값 입력란 포함).
  const domText = (await shellEval(
    `(() => {
       const texts = [document.body.innerText];
       for (const input of document.querySelectorAll('input')) texts.push(input.value);
       return texts.join('\\n');
     })()`
  )) as string;
  for (const marker of PASSWORD_MARKERS) {
    expect(domText.includes(marker)).toBe(false);
  }

  await saveShellShot('wizard-passwords-imported.png');

  summary['passwordImport'] = {
    stored,
    sourceRemoved: true,
    auditCount: 3,
    domMarkersChecked: PASSWORD_MARKERS.length,
    screenshot: 'wizard-passwords-imported.png'
  };
});

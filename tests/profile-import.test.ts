import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/main/persistence/Database';
import { History } from '../src/main/browser/History';
import { Bookmarks } from '../src/main/browser/Bookmarks';
import { Autofill } from '../src/main/browser/Autofill';
import {
  IMPORTABLE_FILE_NAMES,
  chromeTimeToUnixMs,
  discoverProfiles,
  importProfile,
  listSkippedFiles,
  parseChromeBookmarks,
  readAutofillDb,
  readHistoryDb,
  type DiscoveredProfile
} from '../src/main/browser/ProfileImport';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures', 'profiles');

interface ExpectedCounts {
  bookmarks: number;
  visits: number;
  distinctUrls: number;
  autofill: number;
  decoys: number;
}

const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf-8')) as Record<
  'chrome' | 'edge',
  ExpectedCounts
>;

const skipNames = (
  JSON.parse(fs.readFileSync(path.join(FIXTURES, 'skip-names.json'), 'utf-8')) as { names: string[] }
).names;

/** 미끼 파일 안에 심어둔 표식. 결과 어디에도 나타나면 안 된다. */
const DECOY_SENTINEL = 'HELM_FIXTURE_MUST_NOT_BE_READ';

function profileOf(browser: 'chrome' | 'edge'): DiscoveredProfile {
  const dir = path.join(FIXTURES, browser, 'Default');
  return {
    browser,
    dir,
    name: 'Default',
    available: IMPORTABLE_FILE_NAMES.filter((f) => fs.existsSync(path.join(dir, f)))
  };
}

/**
 * 프로필 디렉터리 안의 파일에 대한 fs 접근을 기록한다.
 *
 * ProfileImport 는 SQLite 원본을 임시 사본으로 복사한 뒤 사본을 열기 때문에,
 * 원본 프로필 디렉터리에 대한 접근은 전부 fs 를 거친다. 즉 이 로그가 곧 파일 접근 로그다.
 */
function installFsAccessLog(profileDir: string): { paths: string[]; restore: () => void } {
  const paths: string[] = [];
  const watched = ['existsSync', 'readFileSync', 'readdirSync', 'copyFileSync', 'openSync'] as const;
  const restores: (() => void)[] = [];

  const record = (target: unknown): void => {
    const value = typeof target === 'string' ? target : String(target);
    if (value.startsWith(profileDir)) paths.push(path.relative(profileDir, value) || '.');
  };

  for (const name of watched) {
    const original = fs[name] as (...args: unknown[]) => unknown;
    const spy = vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
      record(args[0]);
      return original(...args);
    }) as never);
    restores.push(() => spy.mockRestore());
  }

  return { paths, restore: () => restores.forEach((fn) => fn()) };
}

describe('ProfileImport — 파서 단위', () => {
  it('크롬 Bookmarks JSON 을 폴더 경로와 함께 평탄화한다', () => {
    const json = fs.readFileSync(path.join(FIXTURES, 'chrome', 'Default', 'Bookmarks'), 'utf-8');
    const parsed = parseChromeBookmarks(json);

    expect(parsed).toHaveLength(expected.chrome.bookmarks);
    expect(parsed.map((b) => b.url)).toContain('https://approval.example.co.kr/');

    const nested = parsed.find((b) => b.url === 'https://approval.example.co.kr/');
    expect(nested?.folder).toBe('북마크바/업무');
    expect(parsed.find((b) => b.url === 'https://portal.example.co.kr/')?.folder).toBe('북마크바');
  });

  it('깨진 JSON 은 사유가 담긴 에러를 던진다', () => {
    expect(() => parseChromeBookmarks('{not json')).toThrow(/parseChromeBookmarks/);
  });

  it('크롬 시각을 Unix 밀리초로 바꾼다', () => {
    // 1601 기준 마이크로초 → 1970 기준 밀리초
    expect(chromeTimeToUnixMs(11_644_473_600_000_000)).toBe(0);
    expect(chromeTimeToUnixMs(11_644_473_601_000_000)).toBe(1000);
    expect(chromeTimeToUnixMs(0)).toBe(0);
  });

  it('History DB 에서 방문마다 한 건씩 읽는다', () => {
    const visits = readHistoryDb(path.join(FIXTURES, 'chrome', 'Default', 'History'));
    expect(visits).toHaveLength(expected.chrome.visits);
    expect(new Set(visits.map((v) => v.url)).size).toBe(expected.chrome.distinctUrls);
    expect(visits.every((v) => v.visitedAt > 0)).toBe(true);
  });

  it('Web Data DB 에서 자동완성 항목을 읽는다', () => {
    const rows = readAutofillDb(path.join(FIXTURES, 'chrome', 'Default', 'Web Data'));
    expect(rows).toHaveLength(expected.chrome.autofill);
    expect(rows[0]?.useCount).toBeGreaterThanOrEqual(rows[1]?.useCount ?? 0);
  });

  it('허용 목록은 세 파일뿐이다', () => {
    expect([...IMPORTABLE_FILE_NAMES].sort()).toEqual(['Bookmarks', 'History', 'Web Data']);
  });

  it('가져오지 않는 파일을 여집합으로 보고한다', () => {
    const skipped = listSkippedFiles(path.join(FIXTURES, 'chrome', 'Default'));
    for (const name of skipNames) expect(skipped).toContain(name);
    for (const name of IMPORTABLE_FILE_NAMES) expect(skipped).not.toContain(name);
  });
});

describe('ProfileImport — 프로필 탐색', () => {
  let tempRoot = '';

  beforeEach(() => {
    // 크롬의 실제 배치(%LOCALAPPDATA%\Google\Chrome\User Data\Default)를 임시로 재현한다.
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-localappdata-'));
    const dest = path.join(tempRoot, 'Google', 'Chrome', 'User Data', 'Default');
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(path.join(FIXTURES, 'chrome', 'Default'), dest, { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'Google', 'Chrome', 'User Data', 'ShaderCache'), {
      recursive: true
    });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('Default 프로필을 찾고 프로필이 아닌 디렉터리는 건너뛴다', () => {
    const profiles = discoverProfiles(tempRoot);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.browser).toBe('chrome');
    expect(profiles[0]?.name).toBe('Default');
    expect([...(profiles[0]?.available ?? [])].sort()).toEqual(['Bookmarks', 'History', 'Web Data']);
  });

  it('LOCALAPPDATA 가 없으면 빈 목록', () => {
    expect(discoverProfiles('')).toEqual([]);
    expect(discoverProfiles(path.join(tempRoot, '없는경로'))).toEqual([]);
  });
});

describe.each(['chrome', 'edge'] as const)('ProfileImport — %s 프로필 가져오기', (browser) => {
  let dbDir = '';
  let db: ReturnType<typeof openDatabase>;
  let history: History;
  let bookmarks: Bookmarks;
  let autofill: Autofill;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-db-'));
    db = openDatabase(dbDir, 'test.db');
    history = new History(db);
    bookmarks = new Bookmarks(db);
    autofill = new Autofill(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('북마크·방문 기록·자동완성 건수가 일치한다', () => {
    const result = importProfile(profileOf(browser), {
      history,
      bookmarks,
      saveAutofill: (rows) => autofill.saveMany(rows)
    });

    expect(result.errors).toEqual([]);
    expect(result.bookmarks).toBe(expected[browser].bookmarks);
    expect(result.history).toBe(expected[browser].visits);
    expect(result.autofill).toBe(expected[browser].autofill);

    // DB 에 실제로 들어갔는지도 본다 — 반환값만 믿지 않는다.
    expect(bookmarks.count()).toBe(expected[browser].bookmarks);
    expect(history.count()).toBe(expected[browser].visits);
    expect(autofill.count()).toBe(expected[browser].autofill);
  });

  it('자격증명 파일은 파일 접근 로그에 나타나지 않는다', () => {
    const profile = profileOf(browser);
    const log = installFsAccessLog(profile.dir);

    let result;
    try {
      result = importProfile(profile, {
        history,
        bookmarks,
        saveAutofill: (rows) => autofill.saveMany(rows)
      });
    } finally {
      log.restore();
    }

    // 1) 디렉터리 열거(감사 목적)를 제외하면, 접근한 파일은 허용 목록뿐이다.
    const touchedFiles = log.paths.filter((p) => p !== '.' && p !== '');
    expect(touchedFiles.length).toBeGreaterThan(0);
    for (const touched of touchedFiles) {
      expect(IMPORTABLE_FILE_NAMES, `허용 목록 밖 파일 접근: ${touched}`).toContain(touched);
    }

    // 2) 미끼 파일 이름은 하나도 열리지 않았다.
    for (const name of skipNames) {
      expect(touchedFiles, `${name} 을 열었습니다`).not.toContain(name);
    }

    // 3) 미끼 내용이 결과로 새어 나오지 않았다.
    expect(JSON.stringify(result)).not.toContain(DECOY_SENTINEL);

    // 4) 가져오지 않은 파일은 감사 기록에 남는다.
    for (const name of skipNames) {
      expect(result.skippedCredentialFiles).toContain(name);
    }
  });

  it('두 번 가져와도 북마크가 중복되지 않는다', () => {
    const targets = { history, bookmarks, saveAutofill: (rows: Parameters<Autofill['saveMany']>[0]) => autofill.saveMany(rows) };
    importProfile(profileOf(browser), targets);
    const second = importProfile(profileOf(browser), targets);

    expect(second.bookmarks).toBe(0);
    expect(bookmarks.count()).toBe(expected[browser].bookmarks);
  });
});

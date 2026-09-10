import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { ProfileImportResult } from '../../shared/types';
import type { History } from './History';
import type { Bookmarks } from './Bookmarks';

/**
 * 크롬/엣지 프로필 가져오기 — 1단계(비암호화 데이터)만.
 *
 * 가져오는 것: 북마크, 방문 기록, 자동완성.
 * 가져오지 않는 것: 세션 쿠키·인증 토큰·저장된 비밀번호 (CLAUDE.md 불변 조건 9).
 *
 * 설계상 중요한 점: 이 모듈은 **허용 목록만** 안다. 자격증명 저장소 파일명을 상수로도 갖지
 * 않으므로 실수로 열 수 없고, `no-credential-files` lint 규칙에 예외가 필요 없다.
 * "가져오지 않은 파일"은 프로필 디렉터리 열거 결과에서 허용 목록을 뺀 여집합으로 보고한다.
 */

/** 읽어도 되는 파일. 이 목록에 없는 파일은 열지 않는다(화이트리스트 방식). */
const IMPORTABLE = {
  bookmarks: 'Bookmarks',
  history: 'History',
  autofill: 'Web Data'
} as const;

export const IMPORTABLE_FILE_NAMES: readonly string[] = Object.values(IMPORTABLE);

export type SourceBrowser = 'chrome' | 'edge';

/** 브라우저별 User Data 루트. %LOCALAPPDATA% 기준(Windows 11). */
const USER_DATA_SUBPATH: Record<SourceBrowser, readonly string[]> = {
  chrome: ['Google', 'Chrome', 'User Data'],
  edge: ['Microsoft', 'Edge', 'User Data']
};

export interface DiscoveredProfile {
  browser: SourceBrowser;
  /** 프로필 디렉터리 절대 경로 */
  dir: string;
  /** 'Default', 'Profile 1' 같은 표시 이름 */
  name: string;
  /** 이 프로필에서 실제로 가져올 수 있는 파일 */
  available: readonly string[];
}

/** 설치된 브라우저 프로필을 찾는다. 접근 불가는 오류가 아니라 "없음"으로 취급한다. */
export function discoverProfiles(localAppData = process.env['LOCALAPPDATA'] ?? ''): DiscoveredProfile[] {
  if (localAppData.trim() === '') return [];

  const found: DiscoveredProfile[] = [];

  for (const browser of Object.keys(USER_DATA_SUBPATH) as SourceBrowser[]) {
    const root = path.join(localAppData, ...USER_DATA_SUBPATH[browser]);
    if (!fs.existsSync(root)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      console.warn(`[discoverProfiles] 프로필 루트 읽기 실패 - 경로: ${root}`, error);
      continue;
    }

    // 프로필 디렉터리는 'Default' 또는 'Profile N' 이다. 그 외 디렉터리는 프로필이 아니다.
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== 'Default' && !/^Profile \d+$/.test(entry.name)) continue;

      const dir = path.join(root, entry.name);
      const available = IMPORTABLE_FILE_NAMES.filter((file) => fs.existsSync(path.join(dir, file)));
      if (available.length === 0) continue;

      found.push({ browser, dir, name: entry.name, available });
    }
  }

  return found;
}

/**
 * 프로필 디렉터리에서 가져오지 않는 파일 이름 목록.
 * 허용 목록의 여집합이라 자격증명 파일명을 코드에 적지 않고도 감사 기록을 남길 수 있다.
 */
export function listSkippedFiles(profileDir: string): string[] {
  try {
    return fs
      .readdirSync(profileDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !IMPORTABLE_FILE_NAMES.includes(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    console.warn(`[listSkippedFiles] 디렉터리 열거 실패 - 경로: ${profileDir}`, error);
    return [];
  }
}

export interface ParsedBookmark {
  url: string;
  title: string;
  folder: string;
}

/** 크롬 Bookmarks(JSON) 파서. 폴더 트리를 평탄화하되 원본 경로를 folder 에 보존한다. */
export function parseChromeBookmarks(json: string): ParsedBookmark[] {
  interface Node {
    type?: string;
    name?: string;
    url?: string;
    children?: Node[];
  }

  let parsed: { roots?: Record<string, Node> };
  try {
    parsed = JSON.parse(json) as { roots?: Record<string, Node> };
  } catch (error) {
    throw new Error(`[parseChromeBookmarks] JSON 파싱 실패 - ${(error as Error).message}`);
  }

  const out: ParsedBookmark[] = [];

  const walk = (node: Node, trail: string[]): void => {
    if (node.type === 'url' && typeof node.url === 'string') {
      out.push({ url: node.url, title: node.name ?? node.url, folder: trail.join('/') });
      return;
    }
    // 폴더 이름을 경로에 쌓는다. 루트 이름('북마크바' 등)은 맨 앞 구간이 된다.
    const nextTrail = node.name ? [...trail, node.name] : trail;
    for (const child of node.children ?? []) walk(child, nextTrail);
  };

  for (const root of Object.values(parsed.roots ?? {})) walk(root, []);
  return out;
}

export interface ParsedVisit {
  url: string;
  title: string;
  visitedAt: number;
}

/** 크롬 시각(1601-01-01 기준 마이크로초)을 Unix 밀리초로. */
export function chromeTimeToUnixMs(chromeTime: number): number {
  if (!Number.isFinite(chromeTime) || chromeTime <= 0) return 0;
  const EPOCH_DIFF_US = 11_644_473_600_000_000;
  return Math.round((chromeTime - EPOCH_DIFF_US) / 1000);
}

/**
 * 복사된 History DB 에서 방문 기록을 읽는다.
 * 원본이 아니라 사본을 열어야 한다 — 크롬이 실행 중이면 원본이 잠겨 있다.
 */
export function readHistoryDb(copiedDbPath: string): ParsedVisit[] {
  const db = new BetterSqlite3(copiedDbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT u.url AS url, u.title AS title, v.visit_time AS visitTime
           FROM visits v JOIN urls u ON u.id = v.url
          ORDER BY v.visit_time DESC`
      )
      .all() as { url: string; title: string | null; visitTime: number }[];

    return rows.map((row) => ({
      url: row.url,
      title: row.title ?? '',
      visitedAt: chromeTimeToUnixMs(row.visitTime)
    }));
  } finally {
    db.close();
  }
}

export interface ParsedAutofill {
  name: string;
  value: string;
  useCount: number;
}

/** 복사된 Web Data DB 에서 자동완성 항목을 읽는다. */
export function readAutofillDb(copiedDbPath: string): ParsedAutofill[] {
  const db = new BetterSqlite3(copiedDbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT name, value, count AS useCount FROM autofill ORDER BY count DESC')
      .all() as ParsedAutofill[];
  } finally {
    db.close();
  }
}

export interface ImportTargets {
  history: History;
  bookmarks: Bookmarks;
  /** 자동완성 저장 — Database 의 autofill 테이블에 넣는다. */
  saveAutofill: (rows: readonly ParsedAutofill[]) => number;
}

/**
 * 프로필 하나를 가져온다.
 *
 * SQLite 파일은 임시 디렉터리로 복사한 뒤 사본을 연다. 원본 잠금을 피하는 목적이면서,
 * 결과적으로 원본 프로필 디렉터리 접근이 전부 fs 호출을 거치게 되어 파일 접근 로그로 검증할 수 있다.
 */
export function importProfile(profile: DiscoveredProfile, targets: ImportTargets): ProfileImportResult {
  const errors: string[] = [];
  const skipped = listSkippedFiles(profile.dir);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-import-'));

  let bookmarkCount = 0;
  let historyCount = 0;
  let autofillCount = 0;

  try {
    // 1) 북마크 — 평문 JSON 이라 복사 없이 읽는다.
    const bookmarksSource = path.join(profile.dir, IMPORTABLE.bookmarks);
    if (fs.existsSync(bookmarksSource)) {
      try {
        const parsed = parseChromeBookmarks(fs.readFileSync(bookmarksSource, 'utf-8'));
        bookmarkCount = targets.bookmarks.addMany(parsed);
      } catch (error) {
        errors.push(`북마크 가져오기 실패: ${(error as Error).message}`);
      }
    }

    // 2) 방문 기록 — SQLite. 사본을 열어야 잠금을 피한다.
    historyCount = importSqlite(
      profile.dir,
      tempDir,
      IMPORTABLE.history,
      errors,
      '방문 기록',
      (copy) => targets.history.addMany(readHistoryDb(copy))
    );

    // 3) 자동완성 — SQLite.
    autofillCount = importSqlite(
      profile.dir,
      tempDir,
      IMPORTABLE.autofill,
      errors,
      '자동완성',
      (copy) => targets.saveAutofill(readAutofillDb(copy))
    );
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[importProfile] 임시 사본 삭제 실패 - 경로: ${tempDir}`, error);
    }
  }

  return {
    sourceBrowser: profile.browser,
    sourceProfile: `${profile.browser}/${profile.name}`,
    bookmarks: bookmarkCount,
    history: historyCount,
    autofill: autofillCount,
    skippedCredentialFiles: skipped,
    errors
  };
}

/** SQLite 원본을 임시 사본으로 복사해 읽는 공통 절차. */
function importSqlite(
  profileDir: string,
  tempDir: string,
  fileName: string,
  errors: string[],
  label: string,
  read: (copiedPath: string) => number
): number {
  const source = path.join(profileDir, fileName);
  if (!fs.existsSync(source)) return 0;

  const copy = path.join(tempDir, fileName.replace(/\s+/g, '_'));
  try {
    fs.copyFileSync(source, copy);
    return read(copy);
  } catch (error) {
    errors.push(`${label} 가져오기 실패: ${(error as Error).message}`);
    return 0;
  }
}

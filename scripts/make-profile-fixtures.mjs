/**
 * 프로필 가져오기 검증용 fixture 생성기.
 *
 * 크롬/엣지 프로필 폴더를 흉내낸 디렉터리를 만든다. 가져와야 하는 파일(Bookmarks / History /
 * Web Data)은 실제 형식대로 만들고, 열어서는 안 되는 파일은 미끼로 함께 둔다.
 * 미끼 이름은 fixtures/profiles/skip-names.json 에서 읽는다 — 이 스크립트에 이름을 적지 않아
 * no-credential-files lint 규칙이 저장소 전체에 예외 없이 적용된다.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

const ROOT = path.resolve(import.meta.dirname, '..', 'fixtures', 'profiles');
const skipNames = JSON.parse(readFileSync(path.join(ROOT, 'skip-names.json'), 'utf-8')).names;

/** Unix ms → 크롬 시각(1601 기준 마이크로초) */
const toChromeTime = (unixMs) => unixMs * 1000 + 11_644_473_600_000_000;

const BASE_MS = Date.UTC(2026, 7, 1, 9, 0, 0); // 2026-08-01 09:00 UTC

/** 프로필별 데이터. 단위 테스트가 이 건수를 기대값으로 쓴다. */
const PROFILES = {
  chrome: {
    bookmarks: {
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: '북마크바',
          children: [
            { type: 'url', name: '사내 포털', url: 'https://portal.example.co.kr/' },
            {
              type: 'folder',
              name: '업무',
              children: [
                { type: 'url', name: '전자결재', url: 'https://approval.example.co.kr/' },
                { type: 'url', name: 'ITSM', url: 'https://itsm.example.co.kr/tickets' }
              ]
            }
          ]
        },
        other: {
          type: 'folder',
          name: '기타 북마크',
          children: [{ type: 'url', name: '규정 포털', url: 'https://rules.example.co.kr/' }]
        }
      }
    },
    visits: [
      ['https://portal.example.co.kr/', '사내 포털', 0],
      ['https://portal.example.co.kr/', '사내 포털', 3_600_000],
      ['https://approval.example.co.kr/', '전자결재', 7_200_000],
      ['https://itsm.example.co.kr/tickets', 'ITSM 티켓', 10_800_000],
      ['https://rules.example.co.kr/', '규정 포털', 14_400_000]
    ],
    autofill: [
      ['email', 'hong@example.co.kr', 12],
      ['dept', '정보관리팀', 5],
      ['search_q', '문서 보관 규정', 2]
    ]
  },
  edge: {
    bookmarks: {
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: '즐겨찾기 모음',
          children: [
            { type: 'url', name: '인사 포털', url: 'https://hr.example.co.kr/' },
            { type: 'url', name: '메신저', url: 'https://msg.example.co.kr/' }
          ]
        }
      }
    },
    visits: [
      ['https://hr.example.co.kr/', '인사 포털', 0],
      ['https://msg.example.co.kr/', '메신저', 1_800_000]
    ],
    autofill: [['email', 'hong@example.co.kr', 3]]
  }
};

function writeHistoryDb(file, visits) {
  rmSync(file, { force: true });
  const db = new BetterSqlite3(file);
  db.exec(`
    CREATE TABLE urls (
      id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
      visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0,
      last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0
    );
    CREATE TABLE visits (
      id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL,
      from_visit INTEGER, transition INTEGER DEFAULT 0
    );
  `);

  // 같은 URL 은 urls 에 한 행, visits 에 방문마다 한 행 — 크롬 구조 그대로.
  const urlIds = new Map();
  const insertUrl = db.prepare(
    'INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, ?, ?)'
  );
  const insertVisit = db.prepare('INSERT INTO visits (url, visit_time) VALUES (?, ?)');

  for (const [url, title, offset] of visits) {
    const chromeTime = toChromeTime(BASE_MS + offset);
    if (!urlIds.has(url)) {
      urlIds.set(url, Number(insertUrl.run(url, title, 0, chromeTime).lastInsertRowid));
    }
    insertVisit.run(urlIds.get(url), chromeTime);
  }

  for (const [url, id] of urlIds) {
    const count = visits.filter(([u]) => u === url).length;
    db.prepare('UPDATE urls SET visit_count = ? WHERE id = ?').run(count, id);
  }

  db.close();
}

function writeWebDataDb(file, rows) {
  rmSync(file, { force: true });
  const db = new BetterSqlite3(file);
  db.exec(`
    CREATE TABLE autofill (
      name VARCHAR, value VARCHAR, value_lower VARCHAR,
      date_created INTEGER DEFAULT 0, date_last_used INTEGER DEFAULT 0,
      count INTEGER DEFAULT 1, PRIMARY KEY (name, value)
    );
  `);
  const insert = db.prepare(
    'INSERT INTO autofill (name, value, value_lower, count) VALUES (?, ?, ?, ?)'
  );
  for (const [name, value, count] of rows) insert.run(name, value, value.toLowerCase(), count);
  db.close();
}

const summary = {};

for (const [browser, data] of Object.entries(PROFILES)) {
  const dir = path.join(ROOT, browser, 'Default');
  rmSync(path.join(ROOT, browser), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  writeFileSync(path.join(dir, 'Bookmarks'), `${JSON.stringify(data.bookmarks, null, 2)}\n`, 'utf-8');
  writeHistoryDb(path.join(dir, 'History'), data.visits);
  writeWebDataDb(path.join(dir, 'Web Data'), data.autofill);

  // 열려서는 안 되는 미끼 파일. 내용이 읽히면 즉시 드러나도록 표식을 넣는다.
  for (const name of skipNames) {
    writeFileSync(
      path.join(dir, name),
      'HELM_FIXTURE_MUST_NOT_BE_READ 이 파일이 읽히면 불변 조건 9 위반입니다.\n',
      'utf-8'
    );
  }

  const urls = new Set(data.visits.map(([u]) => u));
  summary[browser] = {
    bookmarks: countBookmarks(data.bookmarks),
    visits: data.visits.length,
    distinctUrls: urls.size,
    autofill: data.autofill.length,
    decoys: skipNames.length
  };
}

function countBookmarks(tree) {
  let n = 0;
  const walk = (node) => {
    if (node.type === 'url') n += 1;
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of Object.values(tree.roots ?? {})) walk(root);
  return n;
}

/*
 * 앱을 통한 종단 검증용 배치.
 * discoverProfiles 는 %LOCALAPPDATA%\Google\Chrome\User Data\<Profile> 구조를 찾으므로,
 * 같은 모양의 트리를 만들어 두고 HELM_PROFILE_ROOT 로 가리킨다.
 */
const LOCALAPPDATA = path.join(ROOT, 'localappdata');
const LAYOUT = {
  chrome: ['Google', 'Chrome', 'User Data'],
  edge: ['Microsoft', 'Edge', 'User Data']
};

rmSync(LOCALAPPDATA, { recursive: true, force: true });
for (const browser of Object.keys(PROFILES)) {
  const dest = path.join(LOCALAPPDATA, ...LAYOUT[browser], 'Default');
  mkdirSync(dest, { recursive: true });
  cpSync(path.join(ROOT, browser, 'Default'), dest, { recursive: true });
}

writeFileSync(path.join(ROOT, 'expected.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
console.warn(`[make-profile-fixtures] 생성 완료: ${JSON.stringify(summary)}`);

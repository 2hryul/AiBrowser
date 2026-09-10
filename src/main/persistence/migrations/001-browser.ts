/**
 * v1 — M1: 방문 기록 · 북마크 · 자동완성
 *
 * 마이그레이션은 **추가만** 한다. 이미 배포된 항목의 SQL 을 고치면 기존 사용자의 DB 와
 * 새 사용자의 DB 가 달라진다 — 고칠 일이 생기면 새 번호 파일을 만든다.
 */
export const migration001 = `
CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT    NOT NULL,
  title      TEXT    NOT NULL DEFAULT '',
  visited_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_visited_at ON visits(visited_at DESC);
CREATE INDEX IF NOT EXISTS visits_url        ON visits(url);

CREATE TABLE IF NOT EXISTS bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  folder     TEXT    NOT NULL DEFAULT '',
  position   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_url ON bookmarks(url);

CREATE TABLE IF NOT EXISTS autofill (
  name       TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  use_count  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (name, value)
);
`;

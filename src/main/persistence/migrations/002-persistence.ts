/**
 * v2 — M4a: 이름 붙인 세션 · 스레드 · 체크포인트 · 받은편지함 · 메모 · 북마크 메타 · 변경 이력
 *
 * 중단이 정상인 장시간 작업을 위한 표들이다. 공통 규칙:
 *   - 시각은 모두 epoch ms(INTEGER)
 *   - 구조가 자유로운 값(체크포인트 내용, 핵심 필드 목록)은 JSON 문자열
 *   - 대용량 본문은 여기 두지 않는다. 예외는 `page_snapshots.text` 로, 200KB 상한을
 *     코드에서 강제한다(diff 대상이라 같은 트랜잭션에서 읽어야 해서 파일로 빼지 않았다)
 *
 * `trigger` 는 SQLite 예약어라 `trigger_kind` 로 둔다.
 */
export const migration002 = `
CREATE TABLE IF NOT EXISTS sessions (
  name          TEXT    PRIMARY KEY,
  partition     TEXT    NOT NULL,
  login_method  TEXT,
  logged_in_at  INTEGER,
  -- safeStorage 로 암호화한 메타(로그인 경로·시각). 비밀번호·토큰은 넣지 않는다.
  meta          BLOB,
  meta_encrypted INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id            TEXT    PRIMARY KEY,
  title         TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL,
  session_name  TEXT    NOT NULL DEFAULT 'default',
  step_count    INTEGER NOT NULL DEFAULT 0,
  step_limit    INTEGER NOT NULL DEFAULT 60,
  closed_reason TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_updated ON threads(updated_at DESC);
CREATE INDEX IF NOT EXISTS threads_status  ON threads(status);

CREATE TABLE IF NOT EXISTS thread_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT    NOT NULL,
  text       TEXT    NOT NULL DEFAULT '',
  tool       TEXT,
  args       TEXT,
  result     TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_messages_seq ON thread_messages(thread_id, seq);

CREATE TABLE IF NOT EXISTS checkpoints (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  note          TEXT    NOT NULL DEFAULT '',
  trigger_kind  TEXT    NOT NULL,
  message_index INTEGER NOT NULL,
  payload       TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_thread ON checkpoints(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,
  thread_id     TEXT,
  title         TEXT    NOT NULL,
  summary       TEXT    NOT NULL DEFAULT '',
  evidence_path TEXT,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_created ON inbox(created_at DESC);
CREATE INDEX IF NOT EXISTS inbox_unread  ON inbox(read_at);

CREATE TABLE IF NOT EXISTS notes (
  scope      TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, version)
);

CREATE TABLE IF NOT EXISTS bookmark_meta (
  bookmark_id      INTEGER PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
  intent           TEXT    NOT NULL DEFAULT '',
  expected_content TEXT    NOT NULL DEFAULT '',
  key_fields       TEXT    NOT NULL DEFAULT '[]',
  agent_hints      TEXT    NOT NULL DEFAULT '',
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS page_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT    NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  text        TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  truncated   INTEGER NOT NULL DEFAULT 0,
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS page_snapshots_url ON page_snapshots(url, captured_at DESC);
`;

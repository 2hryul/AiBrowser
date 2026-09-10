import path from 'node:path';
import BetterSqlite3, { type Database as Sqlite } from 'better-sqlite3';
import { MIGRATIONS } from './migrations';

/**
 * SQLite 연결과 스키마 마이그레이션.
 * 표 정의는 `migrations/` 의 번호 파일에 있고, 여기는 연결과 버전 올리기만 한다.
 *
 * better-sqlite3 13.x 는 N-API prebuild(win32-x64)를 함께 배포하므로 Electron ABI 에 맞춘
 * 네이티브 리빌드가 필요 없다 — 이 프로젝트 환경에 MSVC 툴체인이 없어 이 점이 전제 조건이다.
 */

export type HelmDatabase = Sqlite;

/**
 * DB 를 열고 스키마를 최신으로 맞춘다.
 *
 * @param userDataDir 앱 데이터 디렉터리(app.getPath('userData'))
 * @param fileName    파일명. 테스트가 임시 DB 를 쓸 때 바꾼다.
 */
export function openDatabase(userDataDir: string, fileName = 'helm.db'): HelmDatabase {
  const file = path.join(userDataDir, fileName);

  let db: HelmDatabase;
  try {
    db = new BetterSqlite3(file);
  } catch (error) {
    throw new Error(
      `[openDatabase] SQLite 열기 실패 - 경로: ${file} / 원인: ${(error as Error).message}`
    );
  }

  // WAL: 셸 조회와 백그라운드 기록이 겹쳐도 잠기지 않게. foreign_keys 는 향후 테이블 대비.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

function migrate(db: HelmDatabase): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;
    db.exec(sql);
    db.pragma(`user_version = ${version + 1}`);
  }
}

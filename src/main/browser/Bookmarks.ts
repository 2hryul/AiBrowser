import type { HelmDatabase } from '../persistence/Database';
import type { Bookmark } from '../../shared/types';
import { escapeLike } from './History';

/**
 * 사람용 북마크 CRUD.
 * M1 은 폴더 트리 UI 를 만들지 않는다. 다만 크롬 프로필에서 가져온 폴더 경로는
 * `folder` 컬럼에 문자열로 보존해 나중에 트리로 복원할 수 있게 한다.
 * AI 용 메타(intent·expectedContent 등)는 M4 BookmarkMeta 에서 별도 테이블로 붙는다.
 */
export class Bookmarks {
  private readonly db: HelmDatabase;

  constructor(db: HelmDatabase) {
    this.db = db;
  }

  list(): Bookmark[] {
    try {
      return this.db
        .prepare(
          'SELECT id, title, url, folder, position, created_at AS createdAt FROM bookmarks ORDER BY position ASC, id ASC'
        )
        .all() as Bookmark[];
    } catch (error) {
      console.error('[Bookmarks.list] 조회 실패', error);
      return [];
    }
  }

  search(query: string, limit = 5): Bookmark[] {
    const trimmed = query.trim();
    if (trimmed === '') return [];

    try {
      const like = `%${escapeLike(trimmed)}%`;
      return this.db
        .prepare(
          `SELECT id, title, url, folder, position, created_at AS createdAt FROM bookmarks
             WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
             ORDER BY position ASC LIMIT ?`
        )
        .all(like, like, limit) as Bookmark[];
    } catch (error) {
      console.error(`[Bookmarks.search] 검색 실패 - query: ${trimmed}`, error);
      return [];
    }
  }

  find(url: string): Bookmark | null {
    const row = this.db
      .prepare(
        'SELECT id, title, url, folder, position, created_at AS createdAt FROM bookmarks WHERE url = ?'
      )
      .get(url) as Bookmark | undefined;
    return row ?? null;
  }

  /**
   * 북마크 추가. 같은 URL 이 이미 있으면 제목만 갱신한다(크롬의 Ctrl+D 재실행 동작).
   * @returns 추가/갱신된 북마크
   */
  add(url: string, title: string, folder = ''): Bookmark | null {
    if (url.trim() === '') return null;

    try {
      const existing = this.find(url);
      if (existing) {
        this.db.prepare('UPDATE bookmarks SET title = ? WHERE id = ?').run(title, existing.id);
        return { ...existing, title };
      }

      const next = this.nextPosition();
      const now = Date.now();
      const result = this.db
        .prepare(
          'INSERT INTO bookmarks (title, url, folder, position, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(title, url, folder, next, now);

      return {
        id: Number(result.lastInsertRowid),
        title,
        url,
        folder,
        position: next,
        createdAt: now
      };
    } catch (error) {
      console.error(`[Bookmarks.add] 추가 실패 - url: ${url}`, error);
      return null;
    }
  }

  remove(id: number): boolean {
    try {
      return this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id).changes > 0;
    } catch (error) {
      console.error(`[Bookmarks.remove] 삭제 실패 - id: ${id}`, error);
      return false;
    }
  }

  removeByUrl(url: string): boolean {
    const existing = this.find(url);
    return existing ? this.remove(existing.id) : false;
  }

  rename(id: number, title: string): boolean {
    try {
      return this.db.prepare('UPDATE bookmarks SET title = ? WHERE id = ?').run(title, id).changes > 0;
    } catch (error) {
      console.error(`[Bookmarks.rename] 이름 변경 실패 - id: ${id}`, error);
      return false;
    }
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM bookmarks').get() as { n: number };
    return row.n;
  }

  private nextPosition(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM bookmarks').get() as {
      maxPos: number;
    };
    return row.maxPos + 1;
  }

  /** 프로필 가져오기용 일괄 삽입. 중복 URL 은 건너뛴다. */
  addMany(rows: readonly { url: string; title: string; folder: string }[]): number {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO bookmarks (title, url, folder, position, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    let inserted = 0;
    let position = this.nextPosition();
    const now = Date.now();

    const run = this.db.transaction((items: readonly typeof rows[number][]) => {
      for (const row of items) {
        if (row.url.trim() === '') continue;
        const result = insert.run(row.title, row.url, row.folder, position, now);
        if (result.changes > 0) {
          inserted += 1;
          position += 1;
        }
      }
    });

    run(rows);
    return inserted;
  }
}

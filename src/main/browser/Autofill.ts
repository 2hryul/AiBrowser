import type { HelmDatabase } from '../persistence/Database';

/**
 * 자동완성 항목 저장소.
 * M1 에서는 크롬 프로필에서 가져온 항목을 보관하는 역할만 한다.
 * 폼 필드에 실제로 채워 넣는 것은 Chromium 자체 기능이라 별도 연동이 필요하고, 그건 M1 범위가 아니다.
 */
export interface AutofillRow {
  name: string;
  value: string;
  useCount: number;
}

export class Autofill {
  private readonly db: HelmDatabase;

  constructor(db: HelmDatabase) {
    this.db = db;
  }

  /** 일괄 저장. 같은 (name, value) 는 사용 횟수만 큰 값으로 갱신한다. */
  saveMany(rows: readonly AutofillRow[]): number {
    const upsert = this.db.prepare(
      `INSERT INTO autofill (name, value, use_count) VALUES (?, ?, ?)
         ON CONFLICT(name, value) DO UPDATE SET use_count = MAX(use_count, excluded.use_count)`
    );

    let saved = 0;
    const run = this.db.transaction((items: readonly AutofillRow[]) => {
      for (const row of items) {
        if (row.name.trim() === '' || row.value.trim() === '') continue;
        upsert.run(row.name, row.value, row.useCount);
        saved += 1;
      }
    });

    run(rows);
    return saved;
  }

  list(limit = 200): AutofillRow[] {
    return this.db
      .prepare('SELECT name, value, use_count AS useCount FROM autofill ORDER BY use_count DESC LIMIT ?')
      .all(limit) as AutofillRow[];
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM autofill').get() as { n: number };
    return row.n;
  }
}

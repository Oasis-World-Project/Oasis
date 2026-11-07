// 检查用隔离浏览器的记录（check_browsers）：容器、算力冻结和结算结果，重启后据此停掉遗留的浏览器。
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { checkBrowsers } from './schema.ts';

export type BrowserRow = typeof checkBrowsers.$inferSelect;
type Patch = Partial<Omit<BrowserRow, 'id' | 'payerId' | 'taskId' | 'createdAt'>>;
const ACTIVE = ['starting', 'running', 'stopping'] as const;

export interface BrowserRepo {
  insert(row: Pick<BrowserRow, 'id' | 'payerId' | 'taskId'>): Promise<void>;
  get(id: string): Promise<BrowserRow | undefined>;
  update(id: string, patch: Patch): Promise<void>;
  /** 还没停好的浏览器 */
  unfinished(): Promise<BrowserRow[]>;
  /** 任务删除时真删除它已经结束的记录 */
  removeFinished(taskId: string): Promise<void>;
}

export function createBrowserRepo(pool: pg.Pool): BrowserRepo {
  const db = drizzle(pool);
  return {
    insert: async (row) => {
      await db.insert(checkBrowsers).values({ ...row, status: 'starting' });
    },
    get: async (id) => {
      const [row] = await db.select().from(checkBrowsers).where(eq(checkBrowsers.id, id));
      return row;
    },
    update: async (id, patch) => {
      await db.update(checkBrowsers).set(patch).where(eq(checkBrowsers.id, id));
    },
    unfinished: () =>
      db
        .select()
        .from(checkBrowsers)
        .where(inArray(checkBrowsers.status, [...ACTIVE])),
    removeFinished: async (taskId) => {
      await db
        .delete(checkBrowsers)
        .where(
          and(eq(checkBrowsers.taskId, taskId), notInArray(checkBrowsers.status, [...ACTIVE])),
        );
    },
  };
}

import * as v from 'valibot';
import { DatabaseSync } from 'node:sqlite';
import type { TwoStageDeploySessionState, TwoStageDeploySessionStorage } from '../src/two-stage-deploy-session';

/** When the object last asked to be woken, so a test can run its alarm passes. */
export interface TeardownAlarmSchedule { at: number | null }

/** Real SQLite exercises the SQL adapter, including transaction rollback and changes(). */
export function teardownSqliteFixture() {
  const database = new DatabaseSync(':memory:');
  const alarm: TeardownAlarmSchedule = { at: null };
  const storage: TwoStageDeploySessionStorage = {
    sql: {
      exec<Row extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): SqlStorageCursor<Row> {
        const values = bindings.map((value) => v.parse(v.union([v.string(), v.number(), v.null()]), value));
        const rows = database.prepare(query).all(...values);
        const cursor: SqlStorageCursor<Row> = Object.create(null);
        Object.defineProperties(cursor, {
          // SAFETY: the production adapter validates row shapes and this fixture
          // runs its exact SQL on SQLite; it never creates synthetic result rows.
          toArray: { value: () => rows as Row[] },
          rowsWritten: { value: 0 },
        });
        return cursor;
      },
    },
    transactionSync<T>(closure: () => T): T {
      database.exec('BEGIN IMMEDIATE');
      try { const result = closure(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    setAlarm: async (scheduledTime) => { alarm.at = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime; },
    deleteAlarm: async () => { alarm.at = null; },
    deleteAll: async () => { throw new Error('teardown_must_not_erase'); },
  };
  const state: TwoStageDeploySessionState = { storage, blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback() };
  return { storage, state, alarm, close: () => database.close() };
}

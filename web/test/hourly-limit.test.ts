// The rolling-hour limiter (db/hourly-limit.ts, ADR 0016) on a throwaway database: its prune
// never waits on, or deadlocks with, another key's prune of the same old rows, and the rows it
// skips don't count.
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

import { spendHourly, type Bucket } from "../db/hourly-limit";
import { hourlySpends } from "../db/schema";
import { freshDb } from "./pg";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const HOUR = 3_600_000;
const BUCKET: Bucket = { name: "test-bucket", perKey: 2 };
let t: Awaited<ReturnType<typeof freshDb>>;

beforeAll(async () => {
  t = await freshDb();
});
afterAll(() => t.drop());

test("old rows another transaction is pruning are skipped, not waited on, and not counted", async () => {
  await t.db.insert(hourlySpends).values([
    { bucket: BUCKET.name, key: "a", spentAt: new Date(NOW - 2 * HOUR) },
    { bucket: BUCKET.name, key: "a", spentAt: new Date(NOW - 2 * HOUR) },
  ]);
  // another key's prune, mid-way: holding the bucket's old rows
  const other = new pg.Client({ connectionString: t.url });
  await other.connect();
  try {
    await other.query("begin");
    await other.query("select 1 from hourly_spends where bucket = $1 for update", [BUCKET.name]);
    const spend = (key: string) =>
      t.db.transaction(async (tx) => {
        await tx.execute("set local lock_timeout = '2s'");
        return spendHourly(tx, BUCKET, key, NOW);
      });
    // "a"'s two old spends are still there but over an hour old: both of this hour's are free
    expect(await spend("a")).toBe(true);
    expect(await spend("a")).toBe(true);
    expect(await spend("a")).toBe(false);
    expect(await spend("b")).toBe(true);
  } finally {
    await other.query("rollback");
    await other.end();
  }
});

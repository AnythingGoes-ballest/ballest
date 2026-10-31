// The site's rolling-hour limits on writes anyone can repeat (ADR 0016): each Bucket counts what
// it allows in `hourly_spends`, per key (a player, an address) and, for some, in all. A spend is
// taken inside the caller's transaction under one lock per key (per Bucket when it caps all), so
// two at once can't both take the last, and a write that rolls back gives its spend back.
import { and, count, eq, gt, sql } from "drizzle-orm";

import type { Conn } from "./prefabs";
import { hourlySpends } from "./schema";

export const HOUR_MS = 3_600_000;

export interface Bucket {
  name: string;
  /* how many one key may spend in a rolling hour */
  perKey: number;
  /* how many every key together may, when there is a cap on all */
  all?: number;
}

/* spends one of `bucket`'s hour for `key` at `now` if there is one left, and says whether */
export async function spendHourly(
  tx: Conn,
  bucket: Bucket,
  key: string,
  now: number,
): Promise<boolean> {
  const lock = bucket.all === undefined ? `${bucket.name}:${key}` : bucket.name;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"hourly:" + lock}))`);
  const hourAgo = new Date(now - HOUR_MS);
  /* the bucket's spends over an hour old go, but only those no one else is pruning now: under
     a per-key lock two keys' prunes can reach the same rows, and taking them in different
     orders would deadlock. What is skipped is still over an hour old, so the counts below leave
     it out by time, not by its being gone */
  await tx.execute(sql`
    delete from hourly_spends where ctid in (
      select ctid from hourly_spends
      where bucket = ${bucket.name} and spent_at <= ${hourAgo.toISOString()}
      for update skip locked)`);
  const live = and(eq(hourlySpends.bucket, bucket.name), gt(hourlySpends.spentAt, hourAgo));
  if (bucket.all !== undefined) {
    const [{ n }] = await tx.select({ n: count() }).from(hourlySpends).where(live);
    if (n >= bucket.all) return false;
  }
  const [{ n }] = await tx
    .select({ n: count() })
    .from(hourlySpends)
    .where(and(live, eq(hourlySpends.key, key)));
  if (n >= bucket.perKey) return false;
  await tx.insert(hourlySpends).values({ bucket: bucket.name, key, spentAt: new Date(now) });
  return true;
}

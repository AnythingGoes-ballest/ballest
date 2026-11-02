// The longest-standing world records, dated from their ghost replays. Steam's Entry carries no
// date and the database's Score history starts on 5 Sep 2026, but the ghost attached to a record
// holds the moment it was set.
import { Effect, Option } from "effect";
import { GhostDates } from "../steam/ghosts.js";
import type { RecordCandidate } from "./report.js";
import { DAY_MS } from "./report.js";

export const OLDEST_RECORDS = 3;
/**
 * A record's ghost may be stamped a little before its Map's publish time (the creator's run is
 * driven before the upload completes), so a Map is only skipped once it is this much younger
 * than the oldest records found so far.
 */
export const RECORD_BEFORE_PUBLISH_SLACK = 7 * DAY_MS;
export interface DatedRecord extends RecordCandidate {
  readonly setAt: number;
}

/** A record's date, or None when its ghost's stamp is unset or the fetch failed (logged). */
const date = Effect.fn("Records.date")(function* (record: RecordCandidate) {
  const ghosts = yield* GhostDates;
  const setAt = yield* ghosts
    .setAt(record.ugcId)
    .pipe(
      Effect.catchTag("GhostUnavailable", (e) =>
        Effect.logWarning(`report: no date for a record (${e.reason})`).pipe(
          Effect.as(Option.none<number>()),
        ),
      ),
    );
  return Option.map(setAt, (at): DatedRecord => ({ ...record, setAt: at }));
});

/** The longest-standing Track records, oldest first. */
export const oldestTrackRecords = Effect.fn("Records.oldestTrackRecords")(function* (
  records: ReadonlyArray<RecordCandidate>,
) {
  const dated = yield* Effect.forEach(records, date);
  return dated
    .flatMap((d) => (Option.isSome(d) ? [d.value] : []))
    .sort((a, b) => a.setAt - b.setAt)
    .slice(0, OLDEST_RECORDS);
});

/**
 * The longest-standing Map records, oldest first. Dating costs two HTTP calls each, so instead of
 * dating every Map's record the walk goes oldest Map first and stops once every remaining Map was
 * published after the third-oldest record found (a record can't be much older than its Map).
 */
export const oldestMapRecords = Effect.fn("Records.oldestMapRecords")(function* (
  records: ReadonlyArray<RecordCandidate>,
) {
  const dated: Array<DatedRecord> = [];
  const walk = [...records].sort(
    (a, b) => (a.publishedAt ?? Infinity) - (b.publishedAt ?? Infinity),
  );
  for (const record of walk) {
    const nth = dated[OLDEST_RECORDS - 1];
    if (
      nth !== undefined &&
      (record.publishedAt ?? Infinity) - RECORD_BEFORE_PUBLISH_SLACK > nth.setAt
    )
      break;
    const d = yield* date(record);
    if (Option.isNone(d)) continue;
    dated.push(d.value);
    dated.sort((a, b) => a.setAt - b.setAt);
  }
  return dated.slice(0, OLDEST_RECORDS);
});

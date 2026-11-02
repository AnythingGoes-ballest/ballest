// The Workshop standings (GLOSSARY.md): Maps played, Author Medals, world records and top 5s,
// counted over the Maps the Workshop lists now, as they stand now and at a baseline, with
// shared places. The site owns these rules (docs/adr/0011); they moved unchanged from the
// Daily Report's counting in discord-bot/src/report/report.ts, and Multiballs reads the result
// from GET /api/standings. Times are Unix ms.
import { CREATOR_BEAT_MARGIN_TICKS } from "./rules";
import type {
  DailyWin,
  LatestDaily,
  StandingsPayload,
  StandingsStat,
  WorkshopStandingRow,
  WorkshopStandings,
} from "./rows";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/* the Daily Report's post, 16:00 UTC */
const REPORT_HOUR_UTC = 16;
/* the furthest back a baseline may be, so only a few are ever cached */
const OLDEST_MS = 7 * DAY_MS;

/* A Map the Workshop lists now, as the counting needs it */
export interface StandingsMap {
  board: string;
  /* the creator's Steam ID: their own Entries count only by beating the Author Medal */
  creator: string | null;
  /* the Author Medal in score ticks, or null for a Map that publishes no Medals */
  authorTicks: number | null;
  /* when it was published, or null if the database doesn't know */
  createdAt: number | null;
  /* when a Refresh first read its board, or null if never */
  firstReadAt: number | null;
}

/* An Entry on a listed Map's board that is open now or was open at the baseline */
export interface StandingsEntry {
  board: string;
  steamId: string;
  persona: string;
  score: number;
  /* when the Refresh that first saw it started */
  firstSeenAt: number;
  /* when the Refresh that closed it started, or null while it is open */
  closedAt: number | null;
}

/* One player on one list, by name: what a WorkshopStandingRow carries by position. The
   wire's rows are written and read only through these two, so no caller counts positions. */
export interface StandingFields {
  /* the index into WorkshopStandings.players */
  player: number;
  /* the count now, and at the baseline */
  n: number;
  nBefore: number;
  /* the shared place now, and at the baseline */
  place: number;
  placeBefore: number;
}
export const standingRow = (r: StandingFields): WorkshopStandingRow => [
  r.player,
  r.n,
  r.nBefore,
  r.place,
  r.placeBefore,
];
export const standingOf = ([
  player,
  n,
  nBefore,
  place,
  placeBefore,
]: WorkshopStandingRow): StandingFields => ({ player, n, nBefore, place, placeBefore });

/* each list, and the count that breaks a tie on it before the Steam ID */
const LISTS: ReadonlyArray<[StandingsStat, StandingsStat | null]> = [
  ["played", null],
  ["author", null],
  ["wr", "top5"],
  ["top5", "wr"],
];

type Counts = Record<StandingsStat, number>;
const zero = (): Counts => ({ played: 0, author: 0, wr: 0, top5: 0 });

const bySteamId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/* a Map's rank order: fastest, then first seen, then Steam ID */
const byRank = (a: StandingsEntry, b: StandingsEntry) =>
  a.score - b.score || a.firstSeenAt - b.firstSeenAt || bySteamId(a.steamId, b.steamId);

const openAt = (e: StandingsEntry, t: number) =>
  e.firstSeenAt <= t && (e.closedAt === null || e.closedAt > t);

/* The Entries on a Map that count, in rank order. A creator's own Entry counts only if it
   beats the Author Medal by CREATOR_BEAT_MARGIN_TICKS: the Author time is their publishing
   run, so matching it is not a finish. Positions are counted among these. */
function counted(map: StandingsMap, entries: ReadonlyArray<StandingsEntry>) {
  return [...entries]
    .sort(byRank)
    .filter(
      (e) =>
        e.steamId !== map.creator ||
        map.authorTicks === null ||
        e.score <= map.authorTicks - CREATOR_BEAT_MARGIN_TICKS,
    );
}

function tally(
  into: Map<string, Counts>,
  map: StandingsMap,
  ranked: ReadonlyArray<StandingsEntry>,
) {
  ranked.forEach((e, i) => {
    const t = into.get(e.steamId) ?? zero();
    t.played += 1;
    if (map.authorTicks !== null && e.score <= map.authorTicks) t.author += 1;
    if (i === 0) t.wr += 1;
    if (i < 5) t.top5 += 1;
    into.set(e.steamId, t);
  });
}

/* 1 + how many counts in `all` are strictly higher than each count, by count */
function placesOf(all: ReadonlyArray<number>): Map<number, number> {
  const sorted = [...all].sort((a, b) => b - a);
  const place = new Map<number, number>();
  sorted.forEach((n, i) => {
    if (!place.has(n)) place.set(n, i + 1);
  });
  return place;
}

/* The four lists over `maps` (the Workshop's now) and their Entries, now and at `since`.
   The now side is every open Entry. A board first read after `since` counts as it stands
   on both sides, since the database knew nothing of it before, so it is no gain; a Map
   published after `since` is the exception, its Entries all new. */
export function countStandings(
  maps: ReadonlyArray<StandingsMap>,
  entries: ReadonlyArray<StandingsEntry>,
  since: number,
): Omit<WorkshopStandings, "readAt" | "since"> {
  const byBoard = new Map<string, Array<StandingsEntry>>();
  for (const e of entries) {
    const list = byBoard.get(e.board) ?? [];
    list.push(e);
    byBoard.set(e.board, list);
  }
  const now = new Map<string, Counts>();
  const before = new Map<string, Counts>();
  const names = new Map<string, string>();
  for (const map of maps) {
    const all = byBoard.get(map.board) ?? [];
    for (const e of all) names.set(e.steamId, e.persona);
    const open = counted(
      map,
      all.filter((e) => e.closedAt === null),
    );
    const read = map.firstReadAt !== null && map.firstReadAt <= since;
    const published = map.createdAt === null || map.createdAt <= since;
    tally(now, map, open);
    tally(
      before,
      map,
      read || !published
        ? counted(
            map,
            all.filter((e) => openAt(e, since)),
          )
        : open,
    );
  }

  const ids = [...new Set([...now.keys(), ...before.keys()])].sort(bySteamId);
  const countOf = (from: Map<string, Counts>, id: string) => from.get(id) ?? zero();
  const lists = Object.fromEntries(
    LISTS.map(([stat, tieBreak]) => {
      /* ids is in Steam ID order, so a player's index there breaks the last tie */
      const on = ids
        .map((id, player) => ({
          player,
          n: countOf(now, id)[stat],
          nBefore: countOf(before, id)[stat],
          tie: tieBreak ? countOf(now, id)[tieBreak] : 0,
        }))
        .filter((r) => r.n > 0 || r.nBefore > 0);
      const placeNow = placesOf(on.map((r) => r.n));
      const placeBefore = placesOf(on.map((r) => r.nBefore));
      const rows = on
        .sort((x, y) => y.n - x.n || y.tie - x.tie || x.player - y.player)
        .map(({ player, n, nBefore }) =>
          standingRow({
            player,
            n,
            nBefore,
            place: placeNow.get(n) ?? 0,
            placeBefore: placeBefore.get(nBefore) ?? 0,
          }),
        );
      return [stat, rows];
    }),
  ) as Record<StandingsStat, Array<WorkshopStandingRow>>;

  return {
    maps: maps.length,
    players: ids.map((id): [string, string] => [id, names.get(id) ?? ""]),
    lists,
  };
}

/* GET /api/standings' payload: `standings` with the Daily side beside its lists: the Daily
   wins, counted from each final Daily's 1st, now and at `since` (a Daily counts there once
   its final Refresh had finished), and the newest final Daily, `latest`. The winners and
   `latest`'s top 10 join `players`, which stays in Steam ID order, so the lists' indices are
   moved to match; the lists themselves are unchanged. */
export function withDaily(
  standings: WorkshopStandings,
  wins: ReadonlyArray<DailyWin>,
  latest: LatestDaily | null,
  since: number,
): StandingsPayload {
  const names = new Map(standings.players);
  for (const { player } of latest?.top ?? [])
    if (!names.has(player.steamId)) names.set(player.steamId, player.persona);
  const now = new Map<string, number>();
  const before = new Map<string, number>();
  for (const w of wins) {
    if (!names.has(w.steamId)) names.set(w.steamId, w.persona);
    now.set(w.steamId, (now.get(w.steamId) ?? 0) + 1);
    if (w.finalAt <= since) before.set(w.steamId, (before.get(w.steamId) ?? 0) + 1);
  }
  const ids = [...names.keys()].sort(bySteamId);
  const index = new Map(ids.map((id, i) => [id, i]));
  const moved = (rows: ReadonlyArray<WorkshopStandingRow>) =>
    rows.map((row) => {
      const r = standingOf(row);
      return standingRow({ ...r, player: index.get(standings.players[r.player][0]) ?? -1 });
    });
  const lists = Object.fromEntries(
    Object.entries(standings.lists).map(([stat, rows]) => [stat, moved(rows)]),
  ) as Record<StandingsStat, Array<WorkshopStandingRow>>;

  const on = [...now.keys()].map((id) => ({
    player: index.get(id) ?? -1,
    n: now.get(id) ?? 0,
    nBefore: before.get(id) ?? 0,
  }));
  const placeNow = placesOf(on.map((r) => r.n));
  const placeBefore = placesOf(on.map((r) => r.nBefore));
  return {
    ...standings,
    players: ids.map((id): [string, string] => [id, names.get(id) ?? ""]),
    lists,
    daily: {
      wins: on
        .sort((x, y) => y.n - x.n || x.player - y.player)
        .map((r) =>
          standingRow({
            ...r,
            place: placeNow.get(r.n) ?? 0,
            placeBefore: placeBefore.get(r.nBefore) ?? 0,
          }),
        ),
      latest: latest && {
        ...latest,
        top: latest.top.map((r) => ({ ...r, player: index.get(r.player.steamId) ?? -1 })),
      },
    },
  };
}

/* The baseline /you compares against: 24 hours before the most recent 16:00 UTC at or
   before `now`, so right after the Daily Report posts the page matches its image */
export function youBaseline(now: number): number {
  const post = Math.floor((now - REPORT_HOUR_UTC * HOUR_MS) / DAY_MS) * DAY_MS;
  return post + REPORT_HOUR_UTC * HOUR_MS - DAY_MS;
}

/* The baseline GET /api/standings counts from: `given` (an ISO time or Unix ms, or null for
   the /you baseline), read down to the hour. One that can't be read, is in the future or is
   more than a week back is refused, with why, so only a few baselines are ever cached. */
export function baselineOf(
  given: string | null,
  now: number,
): { since: number } | { error: string } {
  const at =
    given === null ? youBaseline(now) : /^\d+$/.test(given) ? Number(given) : Date.parse(given);
  if (!Number.isFinite(at)) return { error: "since is not a time" };
  const since = Math.floor(at / HOUR_MS) * HOUR_MS;
  if (since > now || since < now - OLDEST_MS)
    return { error: "since must be within the last week" };
  return { since };
}

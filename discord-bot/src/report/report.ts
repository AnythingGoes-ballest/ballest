// The Daily Report (spec #126) as plain data: what the database holds (ReportData, read by
// source.ts) and the Workshop standings the site counts (Standings, read by standings.ts) in, the
// four Workshop standings' top rows, the lists and what changed since yesterday out. Pure, so every rule here is tested
// without Postgres, the site, Steam or Discord.
import { SCORE_TICKS_PER_SECOND } from "../domain.js";

export const DAY_MS = 86_400_000;
/** A creator's own time must beat their Author Medal by this much to count (1 ms). */
export const CREATOR_BEAT_MARGIN = SCORE_TICKS_PER_SECOND / 1000;
/** Rows shown of each of the four Workshop standings. */
export const TOP = 10;

/** A Workshop Map as the report needs it. */
export interface ReportMap {
  readonly pfid: string;
  readonly board: string;
  readonly title: string;
  /** The creator's Steam ID; their own Entries count only by beating the Author Medal. */
  readonly creator: string | null;
  /** When it was published (ms), or null if the database doesn't know. */
  readonly createdAt: number | null;
  /** The Author Medal in ticks, or null for a Map that publishes no Medals. */
  readonly authorTicks: number | null;
  /**
   * When the collector first read its board (ms), or null if never. Before that the database
   * knows nothing of it, so a board first read in the last day has no yesterday to compare with.
   */
  readonly firstReadAt: number | null;
}

/** An Entry on a Map's board that was open at the report's time or 24 hours before it. */
export interface ReportEntry {
  readonly board: string;
  readonly steamId: string;
  readonly persona: string;
  readonly score: number;
  readonly ugcId: string | null;
  /** When the Refresh that first saw it started (ms). */
  readonly firstSeenAt: number;
  /** When the Refresh that closed it started (ms), or null while it is open. */
  readonly closedAt: number | null;
}

/** A Track's world record at one moment. */
export interface TrackRecord {
  readonly steamId: string;
  readonly persona: string;
  readonly score: number;
  readonly ugcId: string | null;
}

export interface ReportTrack {
  readonly board: string;
  /** "S2 04 Big Stairs": the Season leads, since Tracks are numbered per Season. */
  readonly label: string;
  readonly record: TrackRecord | null;
  readonly recordYesterday: TrackRecord | null;
}

export interface ReportData {
  readonly maps: ReadonlyArray<ReportMap>;
  readonly entries: ReadonlyArray<ReportEntry>;
  /** The Tracks in their order on the site. */
  readonly tracks: ReadonlyArray<ReportTrack>;
  /** When the last Refresh that wrote the database finished (ms), or null with none yet. */
  readonly refreshedAt: number | null;
}

// ---------------------------------------------------------------- the report

export type Stat = "played" | "author" | "wr" | "wins";
/** The report's four standings, in the image's order: three Workshop standings and Most Daily
 * wins (GLOSSARY.md, Daily wins). */
export const STATS: ReadonlyArray<Stat> = ["played", "author", "wr", "wins"];

/**
 * One player on one of the report's standings, as the site counts it (GET /api/standings, docs/adr/
 * 0011). A place is shared: 1 + the players with a strictly higher count.
 */
export interface SiteStanding {
  readonly steamId: string;
  readonly persona: string;
  /** The count now, and at the baseline (24 hours before the report). */
  readonly n: number;
  readonly nBefore: number;
  readonly place: number;
  readonly placeBefore: number;
}
/** Yesterday's Daily: the newest final Daily, as the site reads it (GET /api/standings). */
export interface YesterdayDaily {
  /** Its day, "2026-10-31". */
  readonly date: string;
  readonly title: string;
  /** The Map's Workshop preview, or null when no catalogue has a picture. */
  readonly preview: string | null;
  /** Players with a time on its board. */
  readonly players: number;
  /** Its top 10 as its board ranks it, each score in ticks. */
  readonly top: ReadonlyArray<{
    readonly steamId: string;
    readonly persona: string;
    readonly score: number;
    readonly rank: number;
  }>;
}

/** What the report reads from the site: its four standings, each in the site's order (most
 * first, ties as the site breaks them), and yesterday's Daily, or null while no Daily is final. */
export type Standings = Readonly<Record<Stat, ReadonlyArray<SiteStanding>>> & {
  readonly yesterday: YesterdayDaily | null;
};

export interface Standing {
  readonly steamId: string;
  readonly persona: string;
  readonly n: number;
  /** The shared place on this standing now. */
  readonly place: number;
  /** The shared place 24 hours before, or null if it was outside the top TOP places then. */
  readonly placeBefore: number | null;
  /** n now less n 24 hours before. */
  readonly gain: number;
}
export interface Board {
  readonly stat: Stat;
  readonly rows: ReadonlyArray<Standing>;
  /** Players in this standing's top TOP places 24 hours before who are outside them now. */
  readonly out: ReadonlyArray<Pick<Standing, "steamId" | "persona">>;
}

/** One player on the overall standing: points from their places on the report's four standings. */
export interface OverallStanding {
  readonly steamId: string;
  readonly persona: string;
  /** TOP + 1 - place on each standing where they are in its top TOP places, added up. */
  readonly points: number;
  /** The shared place on Overall now: 1 + the players with more points. */
  readonly place: number;
  /** The shared place 24 hours before, or null if it was outside the top TOP places then. */
  readonly placeBefore: number | null;
  /** Their shared place on each standing, or null outside its top TOP places. */
  readonly places: Readonly<Record<Stat, number | null>>;
}
export interface OverallStandings {
  readonly rows: ReadonlyArray<OverallStanding>;
  /** Players in Overall's top TOP places 24 hours before who are outside them now. */
  readonly out: ReadonlyArray<Pick<OverallStanding, "steamId" | "persona">>;
}

/** A Track as the report names and links it. */
export interface ListedTrack {
  readonly board: string;
  readonly label: string;
}

export interface ListedMap {
  readonly pfid: string;
  readonly title: string;
  /** Players who count on it (see `counted`). */
  readonly finishers: number;
}

/** Something that changed in the last 24 hours, in the order the report lists them. */
export type Change =
  | {
      readonly kind: "trackRecord";
      readonly track: ListedTrack;
      readonly by: string;
      readonly from: string;
      readonly score: number;
      readonly gain: number;
    }
  | {
      readonly kind: "mapRecord";
      readonly map: ListedMap;
      readonly players: number;
      readonly by: string;
      readonly from: string;
      readonly score: number;
    }
  | {
      readonly kind: "firstFinish";
      readonly map: ListedMap;
      readonly players: number;
      readonly by: string;
    }
  | {
      readonly kind: "firstAuthor";
      readonly map: ListedMap;
      readonly players: number;
      readonly by: string;
    };

/** A world record that may be among the longest-standing, once its ghost dates it. */
export interface RecordCandidate {
  readonly steamId: string;
  readonly persona: string;
  readonly score: number;
  readonly ugcId: string;
  /** The Track, or the Map. */
  readonly where: { readonly track: ListedTrack } | { readonly map: ListedMap };
  /** For a Map, when it was published (ms): the walk in records.ts goes oldest Map first. */
  readonly publishedAt: number | null;
}

export interface Report {
  readonly at: number;
  /** The newest final Daily, drawn above Overall, or null while none is final. */
  readonly yesterday: YesterdayDaily | null;
  /** The data's age: when the last Refresh finished (ms), or null with none yet. */
  readonly refreshedAt: number | null;
  readonly maps: number;
  readonly players: number;
  readonly boards: ReadonlyArray<Board>;
  /** The four standings' places as points, added up (spec #373). */
  readonly overall: OverallStandings;
  readonly unfinished: ReadonlyArray<ListedMap>;
  readonly unclaimed: ReadonlyArray<ListedMap>;
  /** Circuit world records that changed hands, in Track order. */
  readonly circuitChanges: ReadonlyArray<Extract<Change, { kind: "trackRecord" }>>;
  /** Every Workshop change, the busiest Map (most players) first. */
  readonly workshopChanges: ReadonlyArray<Exclude<Change, { kind: "trackRecord" }>>;
  readonly newMaps: number;
  readonly trackRecords: ReadonlyArray<RecordCandidate>;
  readonly mapRecords: ReadonlyArray<RecordCandidate>;
}

const openAt = (e: ReportEntry, t: number) =>
  e.firstSeenAt <= t && (e.closedAt === null || e.closedAt > t);

const bySteamId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Rank order on a time board: fastest, then first seen, then Steam ID (as web/db/reads.ts). */
const byRank = (a: ReportEntry, b: ReportEntry) =>
  a.score - b.score || a.firstSeenAt - b.firstSeenAt || bySteamId(a.steamId, b.steamId);

/**
 * The Entries on a Map that count, in rank order. A creator's own Entry counts only if it beats
 * the Author Medal by CREATOR_BEAT_MARGIN: the Author time is their publishing run, so matching
 * it is not a finish. Positions (world record) are counted among these.
 */
export const counted = (map: ReportMap, entries: ReadonlyArray<ReportEntry>) =>
  [...entries]
    .sort(byRank)
    .filter(
      (e) =>
        e.steamId !== map.creator ||
        map.authorTicks === null ||
        e.score <= map.authorTicks - CREATOR_BEAT_MARGIN,
    );

const medalled = (map: ReportMap, e: ReportEntry) =>
  map.authorTicks !== null && e.score <= map.authorTicks;

/** Workshop changes listed before "and N more", busiest Map first. */
export const CHANGES_SHOWN = 6;

/**
 * A standing's top TOP rows in the site's order (exactly TOP, where a tie runs past the last), each
 * moved by its shared place, and who fell out of the top TOP places.
 */
const board = (stat: Stat, list: ReadonlyArray<SiteStanding>): Board => {
  const wasTop = (s: SiteStanding) => s.nBefore > 0 && s.placeBefore <= TOP;
  return {
    stat,
    rows: list
      .filter((s) => s.n > 0)
      .slice(0, TOP)
      .map((s) => ({
        steamId: s.steamId,
        persona: s.persona,
        n: s.n,
        place: s.place,
        placeBefore: wasTop(s) ? s.placeBefore : null,
        gain: s.n - s.nBefore,
      })),
    out: list
      .filter((s) => wasTop(s) && (s.n === 0 || s.place > TOP))
      .sort((a, b) => a.placeBefore - b.placeBefore)
      .map((s) => ({ steamId: s.steamId, persona: s.persona })),
  };
};

/** A shared place in the top TOP on a standing, or null outside it. */
const scoringPlace = (n: number, place: number) => (n > 0 && place <= TOP ? place : null);
/** A standing's points for a place in its top TOP: 10 for 1st down to 1 for 10th. */
const pointsFor = (place: number) => TOP + 1 - place;

/**
 * The overall standing (GLOSSARY.md): each player scores `pointsFor` their shared place on each
 * standing where it is in the top TOP, added up, now and 24 hours before. Counted from the
 * places the site serves, so it never disagrees with the four boards. Exactly TOP rows, by points
 * then name.
 */
const overallStandings = (standings: Standings): OverallStandings => {
  interface Tally {
    steamId: string;
    persona: string;
    points: number;
    pointsBefore: number;
    places: Record<Stat, number | null>;
  }
  const players = new Map<string, Tally>();
  for (const stat of STATS)
    for (const s of standings[stat]) {
      const place = scoringPlace(s.n, s.place);
      const before = scoringPlace(s.nBefore, s.placeBefore);
      if (place === null && before === null) continue;
      const p = players.get(s.steamId) ?? {
        steamId: s.steamId,
        persona: s.persona,
        points: 0,
        pointsBefore: 0,
        places: { played: null, author: null, wr: null, wins: null },
      };
      if (place !== null) p.points += pointsFor(place);
      if (before !== null) p.pointsBefore += pointsFor(before);
      p.places[stat] = place;
      players.set(s.steamId, p);
    }
  const all = [...players.values()];
  /** Each scoring player's shared place: 1 + the players with more points. */
  const places = (points: (p: Tally) => number) =>
    new Map(
      all
        .filter((p) => points(p) > 0)
        .map((p) => [p.steamId, 1 + all.filter((o) => points(o) > points(p)).length]),
    );
  const now = places((p) => p.points);
  const then = places((p) => p.pointsBefore);
  const inTop = (place: number | undefined): place is number => place !== undefined && place <= TOP;
  return {
    rows: all
      .filter((p) => p.points > 0)
      .sort(
        (a, b) =>
          b.points - a.points ||
          a.persona.localeCompare(b.persona) ||
          bySteamId(a.steamId, b.steamId),
      )
      .slice(0, TOP)
      .map((p) => {
        const before = then.get(p.steamId);
        return {
          steamId: p.steamId,
          persona: p.persona,
          points: p.points,
          place: 1 + all.filter((o) => o.points > p.points).length,
          placeBefore: inTop(before) ? before : null,
          places: p.places,
        };
      }),
    out: all
      .flatMap((p) => {
        const before = then.get(p.steamId);
        return inTop(before) && !inTop(now.get(p.steamId)) ? [{ p, before }] : [];
      })
      .sort((a, b) => a.before - b.before)
      .map(({ p }) => ({ steamId: p.steamId, persona: p.persona })),
  };
};

export const buildReport = (data: ReportData, standings: Standings, at: number): Report => {
  const yesterday = at - DAY_MS;
  const byBoard = new Map<string, Array<ReportEntry>>();
  for (const e of data.entries) {
    const list = byBoard.get(e.board) ?? [];
    list.push(e);
    byBoard.set(e.board, list);
  }

  const unfinished: Array<ListedMap> = [];
  const unclaimed: Array<ListedMap> = [];
  const mapChanges: Array<Extract<Change, { map: ListedMap }>> = [];
  const mapRecords: Array<RecordCandidate> = [];
  let newMaps = 0;

  for (const map of data.maps) {
    const all = byBoard.get(map.board) ?? [];
    const open = all.filter((e) => e.closedAt === null);
    const now = counted(map, open);
    const before = counted(
      map,
      all.filter((e) => openAt(e, yesterday)),
    );
    const listed: ListedMap = { pfid: map.pfid, title: map.title, finishers: now.length };
    // Maps up less than a day aren't listed or reported on: they haven't been played yet.
    const dayOld = map.createdAt === null || map.createdAt <= yesterday;
    const readYesterday = map.firstReadAt !== null && map.firstReadAt <= yesterday;

    if (!dayOld) newMaps += 1;
    const medals = now.filter((e) => medalled(map, e));
    if (dayOld && now.length === 0) unfinished.push(listed);
    if (dayOld && now.length > 0 && map.authorTicks !== null && medals.length === 0)
      unclaimed.push(listed);

    const record = now[0];
    if (record !== undefined && record.ugcId !== null)
      mapRecords.push({
        steamId: record.steamId,
        persona: record.persona,
        score: record.score,
        ugcId: record.ugcId,
        where: { map: listed },
        publishedAt: map.createdAt,
      });

    if (!dayOld || !readYesterday || record === undefined) continue;
    const players = open.length;
    const held = before[0];
    if (held === undefined) {
      mapChanges.push({ kind: "firstFinish", map: listed, players, by: record.persona });
    } else if (held.steamId !== record.steamId) {
      mapChanges.push({
        kind: "mapRecord",
        map: listed,
        players,
        by: record.persona,
        from: held.persona,
        score: record.score,
      });
    }
    const firstMedal = medals[0];
    if (
      firstMedal !== undefined &&
      map.authorTicks !== null &&
      !before.some((e) => medalled(map, e))
    )
      mapChanges.push({ kind: "firstAuthor", map: listed, players, by: firstMedal.persona });
  }

  const trackChanges: Array<Extract<Change, { kind: "trackRecord" }>> = [];
  const trackRecords: Array<RecordCandidate> = [];
  for (const track of data.tracks) {
    const now = track.record;
    const then = track.recordYesterday;
    const listed: ListedTrack = { board: track.board, label: track.label };
    if (now !== null && then !== null && now.steamId !== then.steamId)
      trackChanges.push({
        kind: "trackRecord",
        track: listed,
        by: now.persona,
        from: then.persona,
        score: now.score,
        gain: then.score - now.score,
      });
    if (now !== null && now.ugcId !== null)
      trackRecords.push({
        steamId: now.steamId,
        persona: now.persona,
        score: now.score,
        ugcId: now.ugcId,
        where: { track: listed },
        publishedAt: null,
      });
  }

  const title = (m: ListedMap) => m.title.toLowerCase();
  return {
    at,
    yesterday: standings.yesterday,
    refreshedAt: data.refreshedAt,
    maps: data.maps.length,
    players: standings.played.filter((s) => s.n > 0).length,
    boards: STATS.map((stat) => board(stat, standings[stat])),
    overall: overallStandings(standings),
    unfinished: unfinished.sort((a, b) => title(a).localeCompare(title(b))),
    unclaimed: unclaimed.sort(
      (a, b) => b.finishers - a.finishers || title(a).localeCompare(title(b)),
    ),
    circuitChanges: trackChanges,
    // a stable sort keeps a Map's own changes in the order they were found
    workshopChanges: mapChanges.sort((a, b) => b.players - a.players),
    newMaps,
    trackRecords,
    mapRecords,
  };
};

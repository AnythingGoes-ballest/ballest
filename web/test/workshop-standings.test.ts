// The Workshop standings (lib/workshop-standings.ts) counted from plain rows: the Daily
// Report's rules, now and at a baseline, with shared places. Every expected value is worked
// out by hand from the rows in each test.
import { describe, expect, test } from "vitest";

import type { StandingsStat } from "../lib/rows";
import {
  countStandings,
  withDaily,
  youBaseline,
  type StandingsEntry,
  type StandingsMap,
} from "../lib/workshop-standings";

const H = 3_600_000;
const SINCE = Date.parse("2026-10-15T16:00:00Z");
const BEFORE = SINCE - 10 * H;
const AFTER = SINCE + 10 * H;

const map = (board: string, over: Partial<StandingsMap> = {}): StandingsMap => ({
  board,
  creator: null,
  authorTicks: null,
  createdAt: BEFORE - 100 * H,
  firstReadAt: BEFORE - 100 * H,
  ...over,
});

const entry = (
  board: string,
  steamId: string,
  score: number,
  over: Partial<StandingsEntry> = {},
): StandingsEntry => ({
  board,
  steamId,
  persona: steamId.toUpperCase(),
  score,
  firstSeenAt: BEFORE,
  closedAt: null,
  ...over,
});

/* one list as { id: [now, before, place, placeBefore] }, in its listing order */
function list(maps: Array<StandingsMap>, entries: Array<StandingsEntry>, stat: StandingsStat) {
  const s = countStandings(maps, entries, SINCE);
  return s.lists[stat].map(([i, n, b, place, placeBefore]) => [
    s.players[i][0],
    n,
    b,
    place,
    placeBefore,
  ]);
}

describe("Maps played", () => {
  test("each counted Entry is one Map played, and equal counts share a place", () => {
    const maps = [map("A"), map("B"), map("C")];
    const entries = [
      entry("A", "ann", 100),
      entry("B", "ann", 100),
      entry("C", "ann", 100),
      entry("A", "bob", 200),
      entry("B", "bob", 200),
      entry("A", "cat", 300),
      entry("B", "cat", 300),
      entry("A", "dan", 400),
    ];
    expect(list(maps, entries, "played")).toEqual([
      ["ann", 3, 3, 1, 1],
      ["bob", 2, 2, 2, 2],
      ["cat", 2, 2, 2, 2],
      ["dan", 1, 1, 4, 4],
    ]);
  });
});

describe("the creator rule", () => {
  test("a creator's own time counts only when it beats the Author Medal by the margin", () => {
    const own = { creator: "cre", authorTicks: 1000 };
    const maps = [map("A", own), map("B", own), map("C", own)];
    const entries = [
      // on the Author time: their publishing run, not a finish
      entry("A", "cre", 1000),
      entry("A", "ann", 950),
      entry("A", "bob", 1100),
      // 101 ticks under it: counts
      entry("B", "cre", 899),
      entry("B", "ann", 950),
      // faster than everyone, but not by the margin: the record is dan's
      entry("C", "cre", 950),
      entry("C", "dan", 990),
    ];
    expect(list(maps, entries, "played")).toEqual([
      ["ann", 2, 2, 1, 1],
      ["bob", 1, 1, 2, 2],
      ["cre", 1, 1, 2, 2],
      ["dan", 1, 1, 2, 2],
    ]);
    expect(list(maps, entries, "author")).toEqual([
      ["ann", 2, 2, 1, 1],
      ["cre", 1, 1, 2, 2],
      ["dan", 1, 1, 2, 2],
    ]);
    expect(list(maps, entries, "wr")).toEqual([
      ["ann", 1, 1, 1, 1],
      ["cre", 1, 1, 1, 1],
      ["dan", 1, 1, 1, 1],
    ]);
  });

  test("a Map with no Medals counts no Author Medal, and its creator plays it as anyone", () => {
    const entries = [entry("A", "cre", 1000), entry("A", "ann", 900)];
    expect(list([map("A", { creator: "cre" })], entries, "played")).toEqual([
      ["ann", 1, 1, 1, 1],
      ["cre", 1, 1, 1, 1],
    ]);
    expect(list([map("A", { creator: "cre" })], entries, "author")).toEqual([]);
  });
});

describe("now and at the baseline", () => {
  test("a run since the baseline is a gain, and a record taken moves both players", () => {
    const entries = [
      // ann's old run, replaced by a faster one after the baseline
      entry("A", "ann", 500, { closedAt: AFTER }),
      entry("A", "ann", 400, { firstSeenAt: AFTER }),
      entry("A", "bob", 450),
      // cat's first time, after the baseline
      entry("B", "cat", 450, { firstSeenAt: AFTER }),
    ];
    const maps = [map("A"), map("B")];
    expect(list(maps, entries, "wr")).toEqual([
      ["ann", 1, 0, 1, 2],
      ["cat", 1, 0, 1, 2],
      ["bob", 0, 1, 3, 1],
    ]);
    expect(list(maps, entries, "played")).toEqual([
      ["ann", 1, 1, 1, 1],
      ["bob", 1, 1, 1, 1],
      ["cat", 1, 0, 1, 3],
    ]);
  });

  test("a board first read after the baseline counts as it stands on both sides", () => {
    const maps = [
      // an old Map the collector first read after the baseline: no gain
      map("A", { firstReadAt: AFTER }),
      // read before it: bob's time is new
      map("B"),
      // published after the baseline: everything on it is new
      map("C", { createdAt: SINCE + H, firstReadAt: AFTER }),
    ];
    const entries = [
      entry("A", "ann", 100, { firstSeenAt: AFTER }),
      entry("B", "bob", 100, { firstSeenAt: AFTER }),
      entry("C", "cat", 100, { firstSeenAt: AFTER }),
    ];
    expect(list(maps, entries, "played")).toEqual([
      ["ann", 1, 1, 1, 1],
      ["bob", 1, 0, 1, 2],
      ["cat", 1, 0, 1, 2],
    ]);
  });

  test("a Map gone from the Workshop is on neither side", () => {
    const entries = [entry("A", "ann", 100), entry("GONE", "ann", 100), entry("GONE", "dan", 50)];
    const s = countStandings([map("A")], entries, SINCE);
    expect(s.maps).toBe(1);
    expect(s.players).toEqual([["ann", "ANN"]]);
    expect(list([map("A")], entries, "played")).toEqual([["ann", 1, 1, 1, 1]]);
  });
});

describe("listing order", () => {
  test("a tie lists by world records for top 5s and the reverse, then by Steam ID", () => {
    const maps = [map("A"), map("B")];
    const entries = [
      entry("A", "amy", 100),
      entry("A", "zed", 200),
      entry("A", "bob", 300),
      entry("B", "zed", 100),
      entry("B", "bob", 200),
    ];
    // zed and amy hold a record each; zed has the more top 5s
    expect(list(maps, entries, "wr")).toEqual([
      ["zed", 1, 1, 1, 1],
      ["amy", 1, 1, 1, 1],
    ]);
    // zed and bob have two top 5s each; zed has the record
    expect(list(maps, entries, "top5")).toEqual([
      ["zed", 2, 2, 1, 1],
      ["bob", 2, 2, 1, 1],
      ["amy", 1, 1, 3, 3],
    ]);
    expect(list(maps, entries, "played")).toEqual([
      ["bob", 2, 2, 1, 1],
      ["zed", 2, 2, 1, 1],
      ["amy", 1, 1, 3, 3],
    ]);
  });
});

const served = (s: ReturnType<typeof countStandings>) => ({ readAt: null, since: "", ...s });

describe("the Daily wins beside them", () => {
  test("a winner on no Workshop list joins the players in Steam ID order, the lists kept", () => {
    const s = served(
      countStandings([map("A")], [entry("A", "ann", 100), entry("A", "cat", 200)], SINCE),
    );
    const w = (steamId: string, finalAt: number) => ({ steamId, persona: "B", finalAt });
    const got = withDaily(s, [w("bob", BEFORE), w("cat", AFTER), w("bob", AFTER)], null, SINCE);
    expect(got.players).toEqual([
      ["ann", "ANN"],
      ["bob", "B"],
      ["cat", "CAT"],
    ]);
    const as = (rows: typeof got.daily.wins) =>
      rows.map(([i, ...rest]) => [got.players[i][0], ...rest]);
    expect(as(got.lists.wr)).toEqual([["ann", 1, 1, 1, 1]]);
    expect(as(got.lists.played)).toEqual([
      ["ann", 1, 1, 1, 1],
      ["cat", 1, 1, 1, 1],
    ]);
    // cat's win came after the baseline
    expect(as(got.daily.wins)).toEqual([
      ["bob", 2, 1, 1, 1],
      ["cat", 1, 0, 2, 2],
    ]);
  });

  test("level on wins share a place and list by Steam ID", () => {
    const s = served(countStandings([], [], SINCE));
    const w = (steamId: string) => ({ steamId, persona: steamId, finalAt: BEFORE });
    const got = withDaily(s, [w("zed"), w("amy"), w("zed"), w("amy"), w("kim")], null, SINCE);
    expect(got.daily.wins.map(([i, ...rest]) => [got.players[i][0], ...rest])).toEqual([
      ["amy", 2, 2, 1, 1],
      ["zed", 2, 2, 1, 1],
      ["kim", 1, 1, 3, 3],
    ]);
  });
});

describe("the newest final Daily beside them", () => {
  test("its top 10 join the players and point at them; none is null", () => {
    const s = served(countStandings([map("A")], [entry("A", "cat", 200)], SINCE));
    const top = (steamId: string, score: number, rank: number) => ({
      player: { steamId, persona: steamId.toUpperCase() },
      score,
      rank,
    });
    const latest = {
      date: "2026-09-01",
      title: "Gully",
      preview: null,
      players: 12,
      top: [top("dan", 1_160_400, 1), top("cat", 1_163_000, 2)],
    };
    const got = withDaily(s, [], latest, SINCE);
    expect(got.players).toEqual([
      ["cat", "CAT"],
      ["dan", "DAN"],
    ]);
    expect(got.daily.latest).toEqual({
      ...latest,
      top: [
        { player: 1, score: 1_160_400, rank: 1 },
        { player: 0, score: 1_163_000, rank: 2 },
      ],
    });
    expect(withDaily(s, [], null, SINCE).daily.latest).toBeNull();
  });
});

describe("the /you baseline", () => {
  test("is 24 hours before the most recent 16:00 UTC", () => {
    const at = (iso: string) => new Date(youBaseline(Date.parse(iso))).toISOString();
    expect(at("2026-10-16T15:59:59Z")).toBe("2026-10-14T16:00:00.000Z");
    expect(at("2026-10-16T16:00:00Z")).toBe("2026-10-15T16:00:00.000Z");
    expect(at("2026-10-16T23:30:00Z")).toBe("2026-10-15T16:00:00.000Z");
  });
});

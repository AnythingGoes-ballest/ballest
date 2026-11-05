import { describe, expect, it } from "@effect/vitest";
import { Effect, Either, Layer, Option, Schema } from "effect";
import {
  headMessage,
  MESSAGE_LIMIT,
  pack,
  standingsImage,
  threadSections,
} from "../src/report/messages.js";
import { oldestMapRecords } from "../src/report/records.js";
import { GhostDates, GhostUnavailable, parseGhostStamp } from "../src/steam/ghosts.js";
import {
  buildReport,
  DAY_MS,
  type RecordCandidate,
  type Report,
  type ReportData,
  type ReportEntry,
  type ReportMap,
  type Stat,
  type Standings,
} from "../src/report/report.js";
import { standingsFrom } from "../src/report/standings.js";
import { SiteStandings } from "../src/steam/webApi.js";
import { ticks } from "./harness.js";

const AT = Date.UTC(2026, 9, 4, 16); // Sunday 4 October 2026, 16:00 UTC
const LONG_AGO = Date.UTC(2026, 8, 1);
const EARLIER = AT - 2 * DAY_MS;
const TODAY = AT - 3_600_000;

const map = (n: number, over: Partial<ReportMap> = {}): ReportMap => ({
  pfid: `pf${n}`,
  board: `Workshop_${n}`,
  title: `Map ${n}`,
  creator: "creator",
  createdAt: LONG_AGO,
  authorTicks: ticks(20),
  firstReadAt: LONG_AGO,
  ...over,
});
const entry = (
  m: ReportMap,
  steamId: string,
  seconds: number,
  over: Partial<ReportEntry> = {},
): ReportEntry => ({
  board: m.board,
  steamId,
  persona: steamId.toUpperCase(),
  score: ticks(seconds),
  ugcId: `ugc-${m.pfid}-${steamId}`,
  firstSeenAt: EARLIER,
  closedAt: null,
  ...over,
});
/** Since yesterday in the order it is posted: the Circuit, then the Workshop. */
const changes = (r: Report) => [...r.circuitChanges, ...r.workshopChanges];

const data = (over: Partial<ReportData>): ReportData => ({
  maps: [],
  entries: [],
  tracks: [],
  refreshedAt: null,
  ...over,
});

/** A list row as the site serves it, with a Steam ID for the player's index. */
type Row = [steamId: string, n: number, nBefore: number, place: number, placeBefore: number];
type Lists = Partial<Record<Stat, Array<Row>>>;

/** The site's GET /api/standings payload for these lists, as it serves it, every player named in
 * capitals. */
const payload = (lists: Lists): typeof SiteStandings.Encoded => {
  const ids = [...new Set(Object.values(lists).flatMap((rows) => rows.map((r) => r[0])))].sort();
  const index = (rows: Array<Row> = []) =>
    rows.map(([id, ...counts]): (typeof SiteStandings.Encoded)["lists"]["played"][number] => [
      ids.indexOf(id),
      ...counts,
    ]);
  return {
    readAt: new Date(TODAY).toISOString(),
    since: new Date(AT - DAY_MS).toISOString(),
    maps: 3,
    players: ids.map((id): [string, string] => [id, id.toUpperCase()]),
    lists: {
      played: index(lists.played),
      author: index(lists.author),
      wr: index(lists.wr),
    },
    daily: { wins: index(lists.wins), latest: null },
  };
};
/** The payload read as the bot reads it: decoded, then its players named. */
const fromSite = (wire: typeof SiteStandings.Encoded) =>
  standingsFrom(Schema.decodeSync(SiteStandings)(wire));
const standings = (lists: Lists = {}): Standings => Either.getOrThrow(fromSite(payload(lists)));
const build = (d: ReportData, lists: Lists = {}) => buildReport(d, standings(lists), AT);
const player = (i: number) => `p${String(i).padStart(2, "0")}`;

describe("the Daily Report's standings", () => {
  it("takes the four boards from the site, in its order, and counts the players on them", () => {
    const r = build(data({}), {
      played: [
        ["amy", 3, 3, 1, 1],
        ["bob", 2, 2, 2, 2],
        ["cat", 1, 0, 3, 3],
      ],
      wr: [["bob", 1, 1, 1, 1]],
    });
    expect(r.boards.map((b) => b.stat)).toEqual(["played", "author", "wr", "wins"]);
    expect(r.boards.find((b) => b.stat === "wr")?.rows).toEqual([
      { steamId: "bob", persona: "BOB", n: 1, place: 1, placeBefore: 1, gain: 0 },
    ]);
    expect(r.players).toBe(3);
  });

  it("takes Most Daily wins from the site's Daily side, with yesterday's win as a gain", () => {
    const r = build(data({}), {
      wins: [
        ["dan", 3, 2, 1, 1],
        ["amy", 2, 2, 2, 1],
      ],
    });
    expect(r.boards.find((b) => b.stat === "wins")?.rows).toEqual([
      { steamId: "dan", persona: "DAN", n: 3, place: 1, placeBefore: 1, gain: 1 },
      { steamId: "amy", persona: "AMY", n: 2, place: 2, placeBefore: 1, gain: 0 },
    ]);
    expect(
      standingsImage(r, new Map()).boards[3]?.rows.map((x) => [x.name, x.place, x.move, x.gain]),
    ).toEqual([
      ["DAN", 1, 0, 1],
      ["AMY", 2, -1, 0],
    ]);
  });

  it("moves each row by its shared place, so a tie shows no move", () => {
    const r = build(data({}), {
      wr: [
        ["amy", 2, 2, 1, 1],
        ["bob", 2, 1, 1, 3],
        ["cat", 2, 2, 1, 1],
        ["dan", 1, 1, 4, 3],
      ],
    });
    // bob caught amy and cat, who were tied all along; dan fell behind bob
    expect(
      standingsImage(r, new Map()).boards[2]?.rows.map((x) => [x.name, x.place, x.move, x.gain]),
    ).toEqual([
      ["AMY", 1, 0, 0],
      ["BOB", 1, 2, 1],
      ["CAT", 1, 0, 0],
      ["DAN", 4, -1, 0],
    ]);
  });

  it("marks a player new to a top 10, and names who fell out of it", () => {
    const ten = Array.from({ length: 10 }, (_, i): Row => [
      player(i),
      20 - i,
      20 - i,
      i + 2,
      i + 1,
    ]);
    // zoe is new, and p09 drops to 11th
    const r = build(data({}), { played: [["zoe", 30, 0, 1, 12], ...ten] });
    const played = r.boards.find((x) => x.stat === "played");
    expect(played?.rows).toHaveLength(10);
    expect(played?.rows[0]).toEqual({
      steamId: "zoe",
      persona: "ZOE",
      n: 30,
      place: 1,
      placeBefore: null,
      gain: 30,
    });
    expect(played?.out).toEqual([{ steamId: "p09", persona: "P09" }]);
    expect(standingsImage(r, new Map()).boards[0]?.rows[0]?.move).toBe("new");
    expect(standingsImage(r, new Map()).boards[0]?.out).toEqual(["P09"]);
  });

  it("draws each row in the Chosen Skin its player had when the report was built", () => {
    const r = build(data({}), {
      wr: [
        ["amy", 2, 2, 1, 1],
        ["bob", 1, 1, 2, 2],
      ],
    });
    const pink = "/Game/Art/Materials/Instances/Ball/MI_BallPink.MI_BallPink";
    const rows = standingsImage(
      r,
      new Map([
        ["amy", pink],
        ["zed", pink],
      ]),
    ).boards[2]?.rows;
    expect(rows?.map((x) => [x.name, x.skin])).toEqual([
      ["AMY", pink],
      ["BOB", null],
    ]);
    expect(
      standingsImage(r, new Map([["amy", pink]])).overall.rows.map((x) => [x.name, x.skin]),
    ).toEqual([
      ["AMY", pink],
      ["BOB", null],
    ]);
  });

  const dailyTop = (steamId: string, seconds: number, rank: number) => ({
    steamId,
    persona: steamId.toUpperCase(),
    score: ticks(seconds),
    rank,
  });
  const dailyOn = (date: string) => ({
    date,
    title: "Happy Halloween",
    preview: "https://images.example.invalid/hh.jpg",
    players: 291,
    top: [dailyTop("amy", 9.604, 1), dailyTop("bob", 11.63, 2), dailyTop("cy", 69.5, 3)],
  });

  it("draws yesterday's Daily with each row's gap to 1st and time, in its Chosen Skin", () => {
    // AT is Sunday 4 October, so Saturday 3 October's Daily is yesterday's.
    const r = buildReport(data({}), { ...standings(), yesterday: dailyOn("2026-10-03") }, AT);
    const pink = "/Game/Art/Materials/Instances/Ball/MI_BallPink.MI_BallPink";
    const uri = "data:image/jpeg;base64,AAAA";
    expect(standingsImage(r, new Map([["bob", pink]]), uri).daily).toEqual({
      heading: "Yesterday's Daily",
      title: "Happy Halloween",
      meta: "Daily · Sat 3 Oct · 291 players",
      preview: uri,
      rows: [
        { steamId: "amy", skin: null, name: "AMY", place: 1, gap: null, time: "9.604" },
        { steamId: "bob", skin: pink, name: "BOB", place: 2, gap: "+2.026", time: "11.630" },
        { steamId: "cy", skin: null, name: "CY", place: 3, gap: "+59.896", time: "1:09.500" },
      ],
    });
    expect(standingsImage(r, new Map()).daily?.preview).toBeNull();
    expect(standingsImage(build(data({})), new Map()).daily).toBeNull();
  });

  it("heads an older Daily as the latest, its date line saying which day", () => {
    const r = buildReport(data({}), { ...standings(), yesterday: dailyOn("2026-10-01") }, AT);
    const daily = standingsImage(r, new Map()).daily;
    expect(daily?.heading).toBe("Latest Daily");
    expect(daily?.meta).toBe("Daily · Thu 1 Oct · 291 players");
  });

  it("subtitles the image with the counts as Standings, since it leads with a Daily", () => {
    expect(standingsImage(build(data({})), new Map()).subtitle).toBe(
      "Standings · 0 Workshop Maps · 0 players",
    );
  });

  it("keeps exactly ten rows in the site's order when a tie runs past tenth", () => {
    const twelve = Array.from({ length: 12 }, (_, i): Row => [player(i), 1, 1, 1, 1]);
    const wr = build(data({}), { wr: twelve }).boards.find((x) => x.stat === "wr");
    expect(wr?.rows.map((x) => x.steamId)).toEqual(twelve.slice(0, 10).map((x) => x[0]));
    // the two cut by the tie still share first place: neither fell out
    expect(wr?.out).toEqual([]);
  });

  it("leaves off a player whose count is gone, and names them out of the top 10", () => {
    const r = build(data({}), {
      wr: [
        ["amy", 1, 0, 1, 2],
        ["bob", 0, 1, 2, 1],
      ],
    });
    const wr = r.boards.find((x) => x.stat === "wr");
    expect(wr?.rows.map((x) => x.steamId)).toEqual(["amy"]);
    expect(wr?.out).toEqual([{ steamId: "bob", persona: "BOB" }]);
  });

  it("refuses a payload whose rows name no player", () => {
    const bad = payload({ played: [["amy", 1, 1, 1, 1]] });
    const wr: (typeof SiteStandings.Encoded)["lists"]["wr"] = [[5, 1, 1, 1, 1]];
    expect(Either.isLeft(fromSite({ ...bad, lists: { ...bad.lists, wr } }))).toBe(true);
    expect(Either.isLeft(fromSite({ ...bad, daily: { wins: wr, latest: null } }))).toBe(true);
  });

  it("refuses a payload without the Daily side, and reads one that still lists top 5s", () => {
    const workshopOnly = Object.fromEntries(
      Object.entries(payload({})).filter(([key]) => key !== "daily"),
    );
    expect(Either.isLeft(Schema.decodeUnknownEither(SiteStandings)(workshopOnly))).toBe(true);
    const site = payload({ wins: [["amy", 1, 1, 1, 1]] });
    const served = { ...site, lists: { ...site.lists, top5: [[0, 5, 5, 1, 1]] } };
    const read = Either.getOrThrow(standingsFrom(Schema.decodeUnknownSync(SiteStandings)(served)));
    expect(read.wins).toEqual([
      { steamId: "amy", persona: "AMY", n: 1, nBefore: 1, place: 1, placeBefore: 1 },
    ]);
  });

  it("carries yesterday's Daily from the site, its top 10 named, and none while none is final", () => {
    const site = payload({ wins: [["amy", 1, 1, 1, 1]] });
    const latest = {
      date: "2026-10-03",
      title: "Happy Halloween",
      preview: "https://images.example.invalid/hh.jpg",
      players: 291,
      top: [
        { player: 1, score: 1_160_400, rank: 1 },
        { player: 0, score: 1_163_000, rank: 2 },
      ],
    };
    const served = {
      ...site,
      players: [...site.players, ["bob", "BOB"] as [string, string]],
      daily: { ...site.daily, latest },
    };
    const r = buildReport(data({}), Either.getOrThrow(fromSite(served)), AT);
    expect(r.yesterday).toEqual({
      date: "2026-10-03",
      title: "Happy Halloween",
      preview: "https://images.example.invalid/hh.jpg",
      players: 291,
      top: [
        { steamId: "bob", persona: "BOB", score: 1_160_400, rank: 1 },
        { steamId: "amy", persona: "AMY", score: 1_163_000, rank: 2 },
      ],
    });
    expect(build(data({})).yesterday).toBeNull();
    const nobody = { ...latest, top: [{ player: 7, score: 1, rank: 1 }] };
    expect(Either.isLeft(fromSite({ ...site, daily: { ...site.daily, latest: nobody } }))).toBe(
      true,
    );
  });

  it("scores Overall 10 for 1st down to 1 for 10th on each standing, nothing outside a top 10", () => {
    const r = build(data({}), {
      played: [
        ["slati", 9, 9, 1, 1],
        ["amy", 1, 1, 11, 11],
      ],
      author: [["slati", 9, 9, 1, 1]],
      wr: [
        ["amy", 5, 5, 1, 1],
        ["slati", 4, 4, 2, 2],
      ],
      wins: [
        ["slati", 9, 9, 1, 1],
        ["bob", 1, 1, 10, 10],
      ],
    });
    expect(r.overall.rows.map((x) => [x.persona, x.points, x.place, x.places])).toEqual([
      ["SLATI", 39, 1, { played: 1, author: 1, wr: 2, wins: 1 }],
      ["AMY", 10, 2, { played: null, author: null, wr: 1, wins: null }],
      ["BOB", 1, 3, { played: null, author: null, wr: null, wins: 10 }],
    ]);
  });

  it("scores everyone tied on a standing, and shares Overall places over exactly ten rows", () => {
    // twelve tied for 1st on world records: all twelve score 10, and share 1st Overall
    const twelve = Array.from({ length: 12 }, (_, i): Row => [player(i), 1, 1, 1, 1]);
    const r = build(data({}), { wr: twelve, wins: [["zed", 1, 1, 1, 1]] });
    expect(r.overall.rows).toHaveLength(10);
    expect(r.overall.rows.map((x) => [x.steamId, x.points, x.place])).toEqual(
      twelve.slice(0, 10).map((x) => [x[0], 10, 1]),
    );
  });

  it("scores a shared place that runs past tenth on a standing for everyone on it", () => {
    // three share 9th on Maps played: the eleventh row still holds 9th, and scores 2
    const eight = Array.from({ length: 8 }, (_, i): Row => [
      player(i),
      20 - i,
      20 - i,
      i + 1,
      i + 1,
    ]);
    const tied = ["amy", "bob", "cat"].map((id): Row => [id, 5, 5, 9, 9]);
    const r = build(data({}), { played: [...eight, ...tied, ["dan", 4, 4, 12, 12]] });
    const points = new Map(r.overall.rows.map((x) => [x.steamId, x.points]));
    expect(points.get("amy")).toBe(2);
    expect(r.overall.rows.map((x) => x.steamId)).toEqual([...eight.map((x) => x[0]), "amy", "bob"]);
    expect(r.overall.rows.at(-1)?.place).toBe(9);
  });

  it("moves Overall rows by yesterday's points, marks newcomers, and names who fell out", () => {
    const nine = Array.from({ length: 9 }, (_, i): Row => [
      player(i),
      20 - i,
      20 - i,
      i + 1,
      i + 1,
    ]);
    const r = build(data({}), {
      // p09 slips from 10th to 11th on Maps played; zoe takes amy's world-record lead
      played: [...nine, ["p09", 10, 10, 11, 10]],
      wr: [
        ["zoe", 3, 0, 1, 3],
        ["amy", 2, 2, 2, 1],
      ],
    });
    const image = standingsImage(r, new Map()).overall;
    // yesterday: P00 and AMY 10, P01 9 ... P08 2, P09 1 (11th)
    expect(image.rows.map((x) => [x.name, x.points, x.place, x.move])).toEqual([
      ["P00", 10, 1, 0],
      ["ZOE", 10, 1, "new"],
      ["AMY", 9, 3, -2],
      ["P01", 9, 3, 0],
      ["P02", 8, 5, -1],
      ["P03", 7, 6, -1],
      ["P04", 6, 7, -1],
      ["P05", 5, 8, -1],
      ["P06", 4, 9, -1],
      ["P07", 3, 10, -1],
    ]);
    expect(image.rows[1]?.places).toEqual([null, null, 1, null]);
    // P08 is 11th Overall now; P09 was 11th yesterday too, so never in the top 10
    expect(image.out).toEqual(["P08"]);
  });

  it("lists unfinished and unclaimed Maps only once they are a day old", () => {
    const old = map(1, { title: "b old" });
    const fresh = map(2, { createdAt: TODAY });
    const tough = map(3, { title: "Tough", authorTicks: ticks(5) });
    const r = build(
      data({
        maps: [old, fresh, tough],
        entries: [entry(tough, "ann", 9), entry(tough, "bob", 8)],
      }),
    );
    expect(r.unfinished.map((m) => m.title)).toEqual(["b old"]);
    expect(r.unclaimed).toEqual([{ pfid: "pf3", title: "Tough", finishers: 2 }]);
    expect(r.newMaps).toBe(1);
  });
});

describe("since yesterday", () => {
  it("lists the Circuit first, then Workshop changes by the Map's players", () => {
    const quiet = map(1);
    const busy = map(2);
    const ann = entry(busy, "ann", 10, { closedAt: TODAY });
    const r = build(
      data({
        maps: [quiet, busy],
        entries: [
          // quiet: a first finish
          entry(quiet, "cat", 30, { firstSeenAt: TODAY }),
          // busy: bob takes the record from ann, with two others on the board
          ann,
          entry(busy, "ann", 9.5, { firstSeenAt: TODAY }),
          entry(busy, "bob", 9, { firstSeenAt: TODAY }),
          entry(busy, "dee", 40),
        ],
        tracks: [
          {
            board: "Map_Track13",
            label: "S1 01",
            record: { steamId: "eve", persona: "Eve", score: ticks(10), ugcId: "u" },
            recordYesterday: { steamId: "fay", persona: "Fay", score: ticks(10.5), ugcId: "v" },
          },
        ],
      }),
    );
    expect(changes(r).map((c) => c.kind)).toEqual(["trackRecord", "mapRecord", "firstFinish"]);
    expect(changes(r)[1]).toMatchObject({ by: "BOB", from: "ANN", players: 3 });
    expect(changes(r)[0]).toMatchObject({
      track: { board: "Map_Track13", label: "S1 01" },
      gain: ticks(0.5),
    });
  });

  it("doesn't list a holder improving their own record, or a Map published today", () => {
    const a = map(1);
    const fresh = map(2, { createdAt: TODAY });
    const r = build(
      data({
        maps: [a, fresh],
        entries: [
          entry(a, "ann", 10, { closedAt: TODAY }),
          entry(a, "ann", 9, { firstSeenAt: TODAY }),
          entry(fresh, "bob", 30, { firstSeenAt: TODAY }),
        ],
      }),
    );
    expect(changes(r)).toEqual([]);
  });

  it("lists nothing for a Map whose board was first read in the last day", () => {
    const a = map(1, { firstReadAt: TODAY });
    const r = build(data({ maps: [a], entries: [entry(a, "ann", 10, { firstSeenAt: TODAY })] }));
    expect(changes(r)).toEqual([]);
  });

  it("notes the first Author Medal on a Map", () => {
    const a = map(1, { authorTicks: ticks(10) });
    const r = build(
      data({
        maps: [a],
        entries: [entry(a, "ann", 12), entry(a, "bob", 9.9, { firstSeenAt: TODAY })],
      }),
    );
    expect(changes(r).map((c) => [c.kind, "by" in c ? c.by : null])).toEqual([
      ["mapRecord", "BOB"],
      ["firstAuthor", "BOB"],
    ]);
  });
});

describe("the Daily Report's messages", () => {
  const busyDay = () => {
    const maps = Array.from({ length: 60 }, (_, i) =>
      map(i, { title: `A very long Map title number ${i} *with* markdown_` }),
    );
    const entries = maps.flatMap((m) => [
      entry(m, "old-holder-with-a-long-name", 10, { closedAt: TODAY }),
      entry(m, "new_holder @everyone", 9, { firstSeenAt: TODAY }),
    ]);
    return build(data({ maps, entries }));
  };

  it("heads the post with the day, and fits Since yesterday under Discord's limit", () => {
    const text = headMessage(busyDay());
    expect(text.startsWith("# Sunday 4 October\n-# Standings · 60 Workshop Maps")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(text).toMatch(/…and \d+ more on smaller Workshop Maps/);
    expect(text).toContain("NEW\\_HOLDER @​EVERYONE");
    expect(text).toContain("A very long Map title number 0 \\*with\\* markdown\\_");
  });

  it("dates the data with a Discord timestamp", () => {
    const r = build(data({ refreshedAt: Date.UTC(2026, 9, 4, 14) }));
    expect(headMessage(r).split("\n")[1]).toBe(
      "-# Standings · 0 Workshop Maps · 0 players · data as of <t:1791122400:R>",
    );
  });

  it("links Maps and Tracks to their pages on the site", () => {
    const a = map(1, { pfid: "3623648768" });
    const r = build(
      data({
        maps: [a],
        entries: [entry(a, "ann", 30, { firstSeenAt: TODAY })],
        tracks: [
          {
            board: "Map_Track13",
            label: "S1 01",
            record: { steamId: "eve", persona: "Eve", score: ticks(10), ugcId: "u" },
            recordYesterday: { steamId: "fay", persona: "Fay", score: ticks(10.5), ugcId: "v" },
          },
        ],
      }),
    );
    const text = headMessage(r);
    expect(text).toContain("took [S1 01](<https://ballestrecords.com/board/Map_Track13>) from");
    expect(text).toContain("[Map 1](<https://ballestrecords.com/map/3623648768>)");
    expect(text).not.toContain("steamcommunity");
    const thread = threadSections(r, {
      tracks: [
        {
          steamId: "eve",
          persona: "Eve",
          score: ticks(10),
          ugcId: "u",
          where: { track: { board: "Map_Track13", label: "S1 01" } },
          publishedAt: null,
          setAt: LONG_AGO,
        },
      ],
      maps: [],
    }).join("\n");
    expect(thread).toContain("[S1 01](<https://ballestrecords.com/board/Map_Track13>) in");
  });

  it("says when nothing changed", () => {
    expect(headMessage(build(data({})))).toContain("- Nothing changed.");
  });

  it("splits the thread into messages under the limit, a long list between lines", () => {
    const maps = Array.from({ length: 200 }, (_, i) => map(i, { title: `Unplayed ${i}` }));
    const messages = pack(threadSections(build(data({ maps })), { tracks: [], maps: [] }));
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(messages.join("\n")).toContain("Unplayed 199");
  });
});

describe("the longest-standing records", () => {
  it("parses a ghost's stamp, and treats an unset one as no date", () => {
    expect(parseGhostStamp("2025.10.27-17.25.22")).toEqual(
      Option.some(Date.UTC(2025, 9, 27, 17, 25, 22)),
    );
    expect(parseGhostStamp("0001.01.01-00.00.00")).toEqual(Option.none());
    expect(parseGhostStamp("garbage")).toEqual(Option.none());
  });

  const candidate = (n: number, publishedAt: number, ugcId = `u${n}`): RecordCandidate => ({
    steamId: `s${n}`,
    persona: `P${n}`,
    score: ticks(10),
    ugcId,
    where: { map: { pfid: `pf${n}`, title: `Map ${n}`, finishers: 1 } },
    publishedAt,
  });

  it.effect("walks oldest Map first, skips undatable records, and stops early", () =>
    Effect.gen(function* () {
      const asked: Array<string> = [];
      const dates: Record<string, number> = {
        u1: Date.UTC(2025, 9, 27),
        u3: Date.UTC(2025, 9, 29),
        u4: Date.UTC(2025, 9, 28),
      };
      const ghosts = Layer.succeed(
        GhostDates,
        GhostDates.of({
          setAt: (ugcId) => {
            asked.push(ugcId);
            return ugcId === "u2"
              ? Effect.fail(new GhostUnavailable({ reason: "gone" }))
              : Effect.succeed(Option.fromNullable(dates[ugcId]));
          },
        }),
      );
      const day = (d: number) => Date.UTC(2025, 9, d);
      const oldest = yield* oldestMapRecords([
        candidate(5, day(29) + 30 * DAY_MS), // published long after the third record: never asked
        candidate(3, day(28)),
        candidate(1, day(26)),
        candidate(2, day(27)),
        candidate(4, day(28)),
      ]).pipe(Effect.provide(ghosts));
      expect(oldest.map((r) => r.steamId)).toEqual(["s1", "s4", "s3"]);
      expect(asked).toEqual(["u1", "u2", "u3", "u4"]);
    }),
  );
});

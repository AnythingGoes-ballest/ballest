// `pnpm render:samples [dir]`: renders every image the bot draws, in every state, as PNGs (to
// the gitignored `.logs/samples` by default) to check by eye against the prototype (branch claude/prototype-discord-bot-surfaces).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { type Player, SCORE_TICKS_PER_SECOND, type Standing } from "../src/domain.js";
import type { CardView } from "../src/ports.js";
import { Renderer } from "../src/render/renderer.js";
import { STATS } from "../src/report/report.js";
import { cupStandingsImage } from "../src/weeklyCup/messages.js";
import type { CupMap, StandingsView } from "../src/weeklyCup/model.js";
import { cupStandings } from "../src/weeklyCup/points.js";
import { weekAt } from "../src/weeklyCup/week.js";

const out = process.argv[2] ?? ".logs/samples";
const T = SCORE_TICKS_PER_SECOND;
const p = (name: string): Player => ({
  discordId: name,
  steamId: `7656119800${name.length}${name.charCodeAt(0)}${name.charCodeAt(1)}`,
});
const [chkn, tilt, grav, maxx] = [
  p("ChknThugget"),
  p("tilt_queen"),
  p("gravwell"),
  p("シドニー"),
] as const;
const names = new Map([chkn, tilt, grav, maxx].map((x) => [x.discordId, x.discordId]));
// A few players with a Chosen Skin, to check the pictures by eye beside the hue marbles.
const chosen: Readonly<Record<string, string>> = {
  [grav.steamId]: "/Game/Art/Materials/Masters/M_LavaBall.M_LavaBall",
  [tilt.steamId]: "/Game/Art/Materials/Instances/Ball/MI_BallPink.MI_BallPink",
  "s-Slati Jnr": "/Game/Art/M_GoldReal.M_GoldReal",
  "s-Chaos":
    "/Game/Packs/Vefects/Stylized_Galaxy_Shader/Galaxy/Materials/MI_VFX_Lush_Galaxy_Shader_02.MI_VFX_Lush_Galaxy_Shader_02",
};
const skinOf = (steamId: string) => chosen[steamId] ?? null;
const map = {
  pfid: "3791550212",
  title: "Gutter Run",
  creator: "pebblewright",
  previewUrl: "",
  boardName: "",
  medals: { bronze: 20, silver: 17, gold: 15.5, author: 14.2 },
  boardId: 1,
  worldRecordTicks: 12.981 * T,
  personalBests: {},
};
const standing = (
  player: Player,
  seconds: number | null,
  rank: number | null,
  medal: Standing["medal"],
): Standing => ({
  player,
  ticks: seconds === null ? null : Math.round(seconds * T),
  rank,
  medal,
});
const base: CardView = {
  matchId: "1",
  venue: "home",
  state: "invite",
  type: "lobby",
  minutes: 15,
  creator: chkn,
  target: null,
  players: [chkn, tilt, grav],
  map: null,
  standings: [],
  expiresAt: null,
  endsAt: null,
  waitingForSteam: false,
  skins: chosen,
};
const cards: Record<string, CardView> = {
  "card-invite-lobby": base,
  "card-invite-public": { ...base, type: "public", players: [chkn] },
  "card-invite-challenge": { ...base, type: "challenge", players: [chkn], target: tilt },
  "card-live-lobby": {
    ...base,
    state: "live",
    players: [chkn, tilt, grav, maxx],
    // シドニー had finished this Map before, so only a run under their PB counts
    map: { ...map, personalBests: { [maxx.steamId]: 14.95 * T } },
    standings: [
      standing(grav, 14.59, 1, "gold"),
      standing(chkn, 15.118, 2, "gold"),
      standing(tilt, 16.402, 3, "silver"),
      standing(maxx, null, null, null),
    ],
  },
  "card-final-lobby": {
    ...base,
    state: "finished",
    players: [chkn, tilt, grav, maxx],
    map,
    standings: [
      standing(grav, 13.977, 1, "author"),
      standing(chkn, 14.861, 2, "gold"),
      standing(tilt, 16.402, 3, "silver"),
      standing(maxx, null, null, null),
    ],
  },
  // gravwell beat the 12.981 WR: the WR ribbon replaces their medal
  "card-final-wr": {
    ...base,
    state: "finished",
    players: [chkn, tilt, grav, maxx],
    map,
    standings: [
      standing(grav, 12.94, 1, "author"),
      standing(chkn, 13.2, 2, "author"),
      standing(tilt, 16.402, 3, "silver"),
      standing(maxx, null, null, null),
    ],
  },
};
// Time is up and the Result is waiting for Steam: the live Card, marked as such.
const liveLobby = cards["card-live-lobby"];
if (liveLobby !== undefined) cards["card-waiting-lobby"] = { ...liveLobby, waitingForSteam: true };

/** A 15-minute Lobby's PBs as they happened: seconds into the Match, Player, time. */
const pbs = (events: ReadonlyArray<readonly [number, Player, number]>) =>
  events.map(([s, player, t]) => ({
    steamId: player.steamId,
    ticks: Math.round(t * T),
    at: s * 1000,
  }));
const race = pbs([
  [70, tilt, 19.45],
  [112, chkn, 17.09],
  [150, chkn, 15.66],
  [210, grav, 16.96],
  [265, chkn, 14.89],
  [300, grav, 14.18],
  [375, tilt, 15.75],
  [428, tilt, 14.52],
  [511, grav, 13.31],
  [665, grav, 12.94],
  [728, chkn, 13.2],
  [870, tilt, 14.02],
]);

// The Weekly Cup's sample week (from claude/prototype-cup-standings): eight Entrants, by name, on
// the three Cup Maps the sandbox's live check voted; a name missing on a Map has no time.
const CUP_NAMES = [
  "marblequeen",
  "rollo",
  "pebblewright",
  "sprocket",
  "tumbler",
  "QuickSilver",
  "nightowl",
  "Zed",
];
const cupMap = (pfid: string, title: string, creator: string): CupMap => ({
  pfid,
  title,
  creator,
  previewUrl: "",
  authorSeconds: 60,
  boardId: 1,
  worldRecordTicks: 1,
});
const CUP_MAPS = [
  cupMap("3810099846", "Crimson Flux", "CoS"),
  cupMap("3796494598", "the drop", "AvgRon"),
  cupMap("3762695115", "AJC4", "Action Jackson"),
];
const CUP_SECONDS: Record<string, Record<string, number>> = {
  "3810099846": {
    marblequeen: 38.214,
    rollo: 38.902,
    pebblewright: 39.551,
    sprocket: 41.003,
    tumbler: 41.003,
    QuickSilver: 44.87,
  },
  "3796494598": {
    rollo: 26.118,
    marblequeen: 26.54,
    QuickSilver: 27.002,
    pebblewright: 27.99,
    nightowl: 29.431,
    tumbler: 31.25,
  },
  "3762695115": {
    pebblewright: 49.877,
    marblequeen: 50.105,
    nightowl: 51.66,
    rollo: 52.3,
    Zed: 58.004,
  },
};
const cupView = (final: boolean): StandingsView => ({
  guildId: "sample",
  week: weekAt(Date.parse("2026-10-30T15:00:00Z")),
  maps: CUP_MAPS,
  final,
  lateReads: [],
  standings: cupStandings(
    CUP_MAPS,
    CUP_NAMES,
    Object.fromEntries(
      Object.entries(CUP_SECONDS).map(([pfid, byName]) => [
        pfid,
        Object.fromEntries(Object.entries(byName).map(([n, sec]) => [n, Math.round(sec * T)])),
      ]),
    ),
  ),
});
const cupNames = new Map(CUP_NAMES.map((n) => [n, n]));

const program = Effect.gen(function* () {
  const renderer = yield* Renderer;
  yield* Effect.tryPromise(() => mkdir(out, { recursive: true }));
  const save = Effect.fn("RenderSamples.save")(function* (name: string, png: Buffer) {
    yield* Effect.tryPromise(() => writeFile(join(out, `${name}.png`), png));
  });
  for (const [name, view] of Object.entries(cards))
    yield* save(name, yield* renderer.card({ view, names, preview: null }));
  yield* save(
    "row-lead",
    yield* renderer.improvement(
      {
        player: grav,
        ticks: 14.59 * T,
        medal: "gold",
        rank: 1,
        previousTicks: 17.244 * T,
        previousRank: 2,
        beatWorldRecord: null,
      },
      "gravwell",
      skinOf(grav.steamId),
    ),
  );
  yield* save(
    "row-first",
    yield* renderer.improvement(
      {
        player: tilt,
        ticks: 16.402 * T,
        medal: "silver",
        rank: 2,
        previousTicks: null,
        previousRank: null,
        beatWorldRecord: null,
      },
      "tilt_queen",
      skinOf(tilt.steamId),
    ),
  );
  yield* save(
    "row-wr",
    yield* renderer.improvement(
      {
        player: grav,
        ticks: 12.94 * T,
        medal: "author",
        rank: 1,
        previousTicks: 13.31 * T,
        previousRank: 1,
        beatWorldRecord: 12.981 * T,
      },
      "gravwell",
      skinOf(grav.steamId),
    ),
  );
  const finalWr = cards["card-final-wr"];
  if (finalWr !== undefined) {
    yield* save(
      "progression-wr",
      yield* renderer.progression({ view: finalWr, history: race, names }),
    );
    // シドニー brought a PB into the Match: dotted until beaten (here, never)
    const withPb = { ...finalWr, map: { ...map, personalBests: { [maxx.steamId]: 14.3 * T } } };
    yield* save(
      "progression-pb",
      yield* renderer.progression({ view: withPb, history: race, names }),
    );
  }
  yield* save("footer", yield* renderer.footer);
  yield* save(
    "link",
    yield* renderer.link(
      {
        steamId: "76561198012345678",
        personaName: "ChknThugget",
        avatarUrl: "",
        campaignTracks: 21,
        campaignTrackTotal: 23,
      },
      null,
    ),
  );
  yield* save("marble", yield* renderer.marble(96));
  const row = (name: string, n: number, place: number, move: number | "new", gain = 0) => ({
    steamId: `s-${name}`,
    skin: skinOf(`s-${name}`),
    name,
    n,
    place,
    move,
    gain,
  });
  const overall = (
    name: string,
    points: number,
    place: number,
    move: number | "new",
    places: ReadonlyArray<number | null>,
  ) => ({
    steamId: `s-${name}`,
    skin: skinOf(`s-${name}`),
    name,
    points,
    place,
    move,
    places: STATS.map((_, i) => places[i] ?? null),
  });
  // Yesterday's Daily, over a preview drawn here rather than fetched, and over the stand-in art.
  const preview = `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="110" viewBox="0 0 640 110"><rect width="640" height="110" fill="#1d4e8f"/><circle cx="330" cy="70" r="80" fill="#2b6cc4"/><rect x="250" y="40" width="40" height="14" fill="#0b1830"/><rect x="370" y="40" width="40" height="14" fill="#0b1830"/><path d="M270 90 Q330 120 390 90" stroke="#0b1830" stroke-width="10" fill="none"/><rect x="560" y="10" width="60" height="90" fill="#4f8ee0" transform="rotate(12 590 55)"/></svg>`,
  ).toString("base64")}`;
  const dailyRow = (name: string, seconds: number, place: number) => ({
    steamId: `s-${name}`,
    skin: skinOf(`s-${name}`),
    name,
    place,
    gap: place === 1 ? null : `+${(seconds - 9.604).toFixed(3)}`,
    time:
      seconds < 60
        ? seconds.toFixed(3)
        : `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}`,
  });
  const daily = {
    heading: "Yesterday's Daily",
    title: "Happy Halloween",
    meta: "Daily · Sat 31 Oct · 291 players",
    preview,
    rows: [
      dailyRow("Sparro", 9.604, 1),
      dailyRow("snayK", 11.63, 2),
      dailyRow("[TC] Sailent", 11.732, 3),
      dailyRow("Slati Jnr", 11.773, 4),
      dailyRow("123JLaney123", 11.835, 5),
      dailyRow("acheeks0307", 11.859, 6),
      dailyRow("Action Jackson", 11.878, 7),
      dailyRow("Chaos", 11.905, 8),
      dailyRow("a_name_far_too_long_for_its_row", 11.934, 9),
      dailyRow("vincentkelley29", 71.5, 10),
    ],
  };
  yield* save(
    "standings-daily-stand-in",
    yield* renderer.standings({
      title: "Saturday 10 October",
      subtitle: "Standings · 1,286 Workshop Maps · 4,778 players",
      daily: { ...daily, heading: "Latest Daily", preview: null, rows: daily.rows.slice(0, 7) },
      boards: [],
      overall: { rows: [], out: [] },
    }),
  );
  yield* save(
    "standings",
    yield* renderer.standings({
      title: "Saturday 10 October",
      subtitle: "Standings · 1,286 Workshop Maps · 4,778 players",
      daily,
      boards: [
        {
          title: "Most Maps played",
          rows: [
            row("Slati Jnr", 999, 1, 0, 14),
            row("Chaos", 462, 2, 0, 3),
            row("Pamzei", 304, 3, 0),
            row("Ronko Tomyno", 291, 4, 1, 19),
            row("SlugSalt", 277, 5, -1),
            row("[:D:] CryT4x", 268, 6, 0, 2),
            row("R23", 251, 7, 0),
            row("nuts", 251, 7, "new", 31),
            row("ChknThugget", 242, 9, -1, 1),
            row("Action Jackson", 237, 10, -1),
          ],
          out: ["Low5ive"],
        },
        { title: "Most Author Medals", rows: [], out: [] },
        {
          title: "Most world records",
          rows: [
            row("Slati Jnr", 169, 1, 0, 5),
            row("123JLaney123", 100, 2, 0, -2),
            row("Pamzei", 78, 3, 0),
          ],
          out: [],
        },
        {
          title: "Most Daily wins",
          rows: [row("a_name_far_too_long_for_its_row", 18, 1, 0, 1), row("Chaos", 9, 2, 0)],
          out: ["purple", "Skylar <3"],
        },
      ],
      overall: {
        rows: [
          overall("Slati Jnr", 39, 1, 0, [1, 1, 2, 1]),
          overall("Chaos", 35, 2, 0, [2, 2, 3, 2]),
          overall("123JLaney123", 31, 3, 1, [6, 3, 1, 3]),
          overall("Pamzei", 21, 4, -1, [8, 6, 5, 4]),
          overall("a_name_far_too_long_for_its_row", 14, 5, "new", [3, 5, null, null]),
          overall("alepa", 14, 5, 2, [null, 10, 4, 5]),
          overall("warzone1320", 10, 7, 0, [5, 7, null, null]),
          overall("snayK", 9, 8, -1, [null, null, 6, 7]),
          overall("Bill Lumbergh", 8, 9, -2, [null, null, 8, 6]),
          overall("シドニー", 1, 10, "new", [null, null, null, 10]),
        ],
        out: ["Skylar <3"],
      },
    }),
  );
  // A Daily Post's lead graph: the prototype's graph A (Daily #60, "the drop"), live and closed.
  const opensAt = Date.UTC(2026, 9, 18, 1);
  const hour = (h: number) => opensAt + h * 3_600_000;
  const lead = (h: number, leaders: ReadonlyArray<string>, seconds: number) => ({
    at: hour(h),
    leaders,
    ticks: Math.round(seconds * T),
  });
  const leads = [
    lead(0.4, ["MitchPlease"], 8.912),
    lead(1.17, ["FEDUS"], 8.701),
    lead(2.67, ["MitchPlease"], 8.64),
    lead(5.08, ["FEDUS"], 8.566),
    lead(8.28, ["airman"], 8.532),
    lead(12.8, ["airman", "snayK"], 8.532),
  ];
  const graph = { opensAt, closesAt: hour(24), leads };
  yield* save("lead-graph", yield* renderer.leadGraph({ ...graph, now: hour(16.33) }));
  yield* save("lead-graph-closed", yield* renderer.leadGraph({ ...graph, now: null }));
  yield* save("lead-graph-tie-now", yield* renderer.leadGraph({ ...graph, now: hour(12.8) }));
  yield* save(
    "lead-graph-first",
    yield* renderer.leadGraph({ ...graph, leads: leads.slice(0, 1), now: hour(0.5) }),
  );
  // A steal minutes before the close, and a lead first seen at it: names stay inside the image.
  yield* save(
    "lead-graph-late-steal",
    yield* renderer.leadGraph({
      ...graph,
      leads: [...leads, lead(23.8, ["MitchPleaseAgain"], 8.5)],
      now: null,
    }),
  );
  yield* save(
    "lead-graph-at-close",
    yield* renderer.leadGraph({ ...graph, leads: [lead(24, ["snayK"], 17.585)], now: null }),
  );
  yield* save(
    "cup-standings-live",
    yield* renderer.cupStandings(cupStandingsImage(cupView(false), cupNames)),
  );
  yield* save(
    "cup-standings-results",
    yield* renderer.cupStandings(cupStandingsImage(cupView(true), cupNames)),
  );
  yield* Effect.log(`wrote samples to ${out}`);
});

program.pipe(Effect.provide(Renderer.Default), NodeRuntime.runMain);

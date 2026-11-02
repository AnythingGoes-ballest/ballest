// What each image draws for a player's marble: the picture of the Chosen Skin its input carries
// for them, their hue marble otherwise, or for a Skin with no picture. The scenes are element
// trees, so a marble is an image whose source is either the picture or a drawn marble in the
// player's hue.
import { describe, expect, it } from "@effect/vitest";
import { hueFor, type SkinPictureUris } from "../src/render/art.js";
import type { PbEvent } from "../src/domain.js";
import type { Improvement, ProfilePreview } from "../src/ports.js";
import {
  cardScene,
  type El,
  footerScene,
  improvementScene,
  linkScene,
  progressionScene,
  standingsScene,
} from "../src/render/scenes.js";
import { ALICE, BOB, cardView, drawnMap, ticks } from "./harness.js";

const PINK = "/Game/Art/Materials/Instances/Ball/MI_BallPink.MI_BallPink";
const PICTURE = "data:image/png;base64,UElOSw==";
/** The only Skin with a picture is Pink. */
const PICTURES: SkinPictureUris = new Map([[PINK, PICTURE]]);
/** Alice picked Pink; Bob has no Chosen Skin. */
const skinOf = (who: typeof ALICE) => (who.steamId === ALICE.steamId ? PINK : null);
const skins = { [ALICE.steamId]: PINK };

/** Every image source in a scene, SVGs decoded. */
const sources = (el: El): Array<string> => [
  ...(el.type === "img" && el.props.src !== undefined ? [decoded(el.props.src)] : []),
  ...(el.props.children ?? []).flatMap((c) =>
    c === null || typeof c === "string" ? [] : sources(c),
  ),
];
const decoded = (src: string) =>
  src.startsWith("data:image/svg+xml;base64,")
    ? Buffer.from(src.slice(src.indexOf(",") + 1), "base64").toString()
    : src;

/** How many of a scene's images are the picture, and whether a player's hue marble is drawn. */
const pictures = (el: El) => sources(el).filter((s) => s === PICTURE).length;
const drawsHueMarble = (el: El, steamId: string) =>
  sources(el).some((s) => s.includes(`stop-color="hsl(${hueFor(steamId)},94%,90%)"`));

const names = new Map([
  [ALICE.discordId, "Alice"],
  [BOB.discordId, "Bob"],
]);
const live = cardView("m1", {
  state: "live",
  type: "lobby",
  players: [ALICE, BOB],
  map: drawnMap(),
  standings: [
    { player: ALICE, ticks: ticks(19), rank: 1, medal: "author" },
    { player: BOB, ticks: ticks(24), rank: 2, medal: "gold" },
  ],
  skins,
});

const improvement = (player: typeof ALICE, beatWorldRecord: number | null): Improvement => ({
  player,
  ticks: ticks(14.59),
  medal: "gold",
  rank: 1,
  previousTicks: ticks(17.2),
  previousRank: 2,
  beatWorldRecord,
});
const preview = (steamId: string): ProfilePreview => ({
  steamId,
  personaName: "Someone",
  avatarUrl: "",
  campaignTracks: 21,
  campaignTrackTotal: 23,
});
const history: ReadonlyArray<PbEvent> = [
  { at: 60_000, steamId: ALICE.steamId, ticks: ticks(19) },
  { at: 90_000, steamId: BOB.steamId, ticks: ticks(24) },
];
const row = (who: typeof ALICE, name: string, place: number) => ({
  steamId: who.steamId,
  skin: skinOf(who),
  name,
  n: 10 - place,
  place,
  move: 0,
  gain: 0,
});

/** A scene drawing one player's marble, for each image that draws one. */
const scenes: ReadonlyArray<readonly [string, (who: typeof ALICE) => El]> = [
  [
    "an Improvement row",
    (who) => improvementScene(improvement(who, null), "Name", skinOf(who), PICTURES),
  ],
  [
    "a world record's row",
    (who) => improvementScene(improvement(who, ticks(15)), "Name", skinOf(who), PICTURES),
  ],
  ["the Link confirmation", (who) => linkScene(preview(who.steamId), skinOf(who), PICTURES)],
];

describe("a player's marble", () => {
  it("on the Card is their Chosen Skin, or their hue marble without one", () => {
    const scene = cardScene({ view: live, names, preview: null }, PICTURES);
    expect(pictures(scene)).toBe(1);
    expect(drawsHueMarble(scene, ALICE.steamId)).toBe(false);
    expect(drawsHueMarble(scene, BOB.steamId)).toBe(true);
  });

  it("is their hue marble for a Chosen Skin with no picture (one a game update added)", () => {
    const future = { ...live, skins: { [ALICE.steamId]: "/Game/Art/Some/Future/Skin.Skin" } };
    const scene = cardScene({ view: future, names, preview: null }, PICTURES);
    expect(pictures(scene)).toBe(0);
    expect(drawsHueMarble(scene, ALICE.steamId)).toBe(true);
  });

  for (const [name, draw] of scenes)
    it(`on ${name} is their Chosen Skin, or their hue marble without one`, () => {
      expect(pictures(draw(ALICE))).toBe(1);
      expect(drawsHueMarble(draw(ALICE), ALICE.steamId)).toBe(false);
      expect(pictures(draw(BOB))).toBe(0);
      expect(drawsHueMarble(draw(BOB), BOB.steamId)).toBe(true);
    });

  it("in the progression graph's legend is their Chosen Skin, or their hue marble", () => {
    const final = cardView("m1", {
      state: "finished",
      type: "lobby",
      players: [ALICE, BOB],
      map: drawnMap(),
      standings: [
        { player: ALICE, ticks: ticks(19), rank: 1, medal: "author" },
        { player: BOB, ticks: ticks(24), rank: 2, medal: "gold" },
      ],
      skins,
    });
    const scene = progressionScene({ view: final, history, names }, PICTURES);
    expect(pictures(scene)).toBe(1);
    expect(drawsHueMarble(scene, ALICE.steamId)).toBe(false);
    expect(drawsHueMarble(scene, BOB.steamId)).toBe(true);
  });

  it("on the Daily Report's boards is their Chosen Skin, or their hue marble", () => {
    const scene = standingsScene(
      {
        title: "Daily Report",
        subtitle: "",
        daily: null,
        boards: [
          {
            title: "Most played",
            rows: [row(ALICE, "Alice", 1), row(BOB, "Bob", 2)],
            out: [],
          },
          { title: "Most authors", rows: [row(ALICE, "Alice", 1)], out: [] },
        ],
        overall: { rows: [], out: [] },
      },
      PICTURES,
    );
    expect(pictures(scene)).toBe(2);
    expect(drawsHueMarble(scene, ALICE.steamId)).toBe(false);
    expect(drawsHueMarble(scene, BOB.steamId)).toBe(true);
  });
});

/** Every string a scene draws, in order, joined by spaces. */
const text = (el: El): string =>
  (el.props.children ?? [])
    .map((c) => (c === null ? "" : typeof c === "string" ? c : text(c)))
    .filter((s) => s !== "")
    .join(" ");

describe("the Footer", () => {
  it("presents the bot as MULTIBALLS by BALLESTRECORDS", () => {
    // the site's name is two-tone, so its halves are drawn apart
    expect(text(footerScene())).toMatch(/^MULTIBALLS by BALLEST ?RECORDS /);
  });
});

// A Prefab file read into what the viewer draws (lib/prefab.ts), and the upload check the
// browser and the server both run on one (lib/prefab-check.ts).
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  footprintOf,
  partsOf,
  pieceLabel,
  prismOf,
  shapesOf,
  type PrefabFile,
} from "../lib/prefab";
import { MAX_BYTES, checkPrefab, fileNameOf } from "../lib/prefab-check";
import { DEFAULT_ANGLE, PAN_MAX, ZOOM_RANGE, checkAngle, galleryOf } from "../lib/prefabs";

const sample = (name: string) =>
  readFileSync(new URL(`../../prefabs/samples/${name}.json`, import.meta.url), "utf8");

const CUBE = "/Game/Blueprints/Editor/BP_Prim_Cube.BP_Prim_Cube_C";
const BOX = "/Game/Art/GreyBoxing/_GENERATED/PC/Box_C559BEB3.Box_C559BEB3";

/* a file of cubes, each [location cm, rotation [pitch, yaw, roll], scale] */
function cubes(...items: Array<[Array<number>, Array<number>, Array<number>]>): PrefabFile {
  return {
    format: "BallestPrefab",
    version: 1,
    group: { rotation: [0, 0, 0], scale: [1, 1, 1] },
    items: items.map(([location, rotation, scale]) => ({
      class: CUBE,
      transform: { location, rotation, scale },
      meshes: [{ mesh: BOX, materials: ["/Game/M/MI_Env_Lime.MI_Env_Lime"] }],
    })) as PrefabFile["items"],
  };
}

/* an air vent as the editor saves it (copied from a player's upload, 2026-10-17): its mesh
   comes from the blueprint, so the file leaves it blank, and its airflow is in properties */
const VENT = {
  class: "/Game/Core/Gameplay/Props/MP_AirVent.MP_AirVent_C",
  transform: { location: [0, 0, 0], rotation: [0, 180, 0], scale: [0.75, 0.75, 1] },
  properties: { "Field Magnitude": 750000, EntryAssistMinSpeed: 800 },
  meshes: [{ tag: "SKGMapEditor", mesh: "", materials: [] }],
  paint: { categories: [], colors: [] },
};

const near = (got: { w: number; d: number; h: number }, want: [number, number, number]) => {
  expect(got.w).toBeCloseTo(want[0]);
  expect(got.d).toBeCloseTo(want[1]);
  expect(got.h).toBeCloseTo(want[2]);
};

describe("a Prefab file", () => {
  test("the bench is 23 pipe tubes and 5 cubes", () => {
    const file = JSON.parse(sample("bench")) as PrefabFile;
    expect(partsOf(file)).toEqual([
      { piece: "BP_Pipe_Tube1", count: 23 },
      { piece: "BP_Prim_Cube", count: 5 },
    ]);
    expect(shapesOf(file)).toHaveLength(28);
  });

  test("an unscaled cube is 10 m a side and sits on the ground", () => {
    const [shape] = shapesOf(
      cubes([
        [0, 0, 0],
        [0, 0, 0],
        [1, 1, 1],
      ]),
    );
    near(footprintOf([shape]), [10, 10, 10]);
    // three's y is up: the unit shape's centre lands 5 m above the pivot
    expect(shape.matrix[13]).toBeCloseTo(5);
    expect(shape.colour).not.toBe("#8a90a0");
  });

  test("yaw turns a long piece flat, pitch stands it up", () => {
    const long = (rotation: Array<number>) =>
      footprintOf(shapesOf(cubes([[0, 0, 0], rotation, [2, 1, 1]])));
    near(long([0, 0, 0]), [20, 10, 10]);
    near(long([0, 90, 0]), [10, 20, 10]);
    near(long([90, 0, 0]), [10, 10, 20]);
  });

  test("yaw turns Unreal's x toward its y (three's z), pitch tilts it up", () => {
    const xAxis = (rotation: Array<number>) =>
      shapesOf(cubes([[0, 0, 0], rotation, [1, 1, 1]]))[0]
        .matrix.slice(0, 3)
        .map((v) => v / 10);
    const close = (got: Array<number>, want: Array<number>) =>
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i]));
    close(xAxis([0, 0, 0]), [1, 0, 0]);
    close(xAxis([0, 90, 0]), [0, 0, 1]);
    close(xAxis([90, 0, 0]), [0, 1, 0]);
  });

  test("a piece is drawn at its own mesh's size, or its piece's when the mesh is unknown", () => {
    const track = (mesh: string) =>
      footprintOf(
        shapesOf({
          ...cubes([
            [0, 0, 0],
            [0, 0, 0],
            [1, 1, 1],
          ]),
          items: [
            {
              class: "/Game/LevelEditor/BP_Track_Short1.BP_Track_Short1_C",
              transform: { location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              meshes: [{ mesh, materials: [] }],
            },
          ],
        }),
      );
    // SM_500 is 500 x 500 x 100 cm (piece_bounds.json)
    near(track("/Game/Maps/_GENERATED/PC/SM_500.SM_500"), [5, 5, 1]);
    near(track("/Game/Somewhere/SM_Unheardof.SM_Unheardof"), [5, 5, 1]);
  });

  test("the hole bowls are drawn as half and quarter rings, not boxes", () => {
    const bowl = (name: string) =>
      shapesOf({
        ...cubes(),
        items: [
          {
            class: `/Game/LevelEditor/MP_SM_${name}.MP_SM_${name}_C`,
            transform: { location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            meshes: [{ mesh: `/Game/Meshes/SM_${name}.SM_${name}`, materials: [] }],
          },
        ],
      })[0].kind;
    expect(bowl("HalfShallowHoleBowl")).toBe("halfRing");
    expect(bowl("QuarterShallowHoleBowl")).toBe("quarterRing");
  });

  test("a curved piece is its own outline pushed through its bounds; a hand-made shape stays", () => {
    const piece = (mesh: string) =>
      shapesOf({
        ...cubes(),
        items: [
          {
            class: "/Game/LevelEditor/BP_Piece.BP_Piece_C",
            transform: { location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            meshes: [{ mesh: `/Game/Maps/_GENERATED/PC/${mesh}.${mesh}`, materials: [] }],
          },
        ],
      })[0];
    // a kicker's ramp shows from the side, so that's the outline it is drawn from
    expect(piece("SM_1000_kicker").profile?.view).toBe("side");
    expect(piece("SM_1000_kicker").profile?.shapes[0][0].length).toBeGreaterThan(6);
    // the goal ring's hole shows from above
    expect(piece("SM_GoalRing").profile?.shapes[0]).toHaveLength(2);
    expect(piece("Torus")).toMatchObject({ kind: "torus", profile: undefined });
    expect(piece("SM_500").profile).toBeUndefined();
  });

  test("an outline is laid in its view's plane, in three's axes, and pushed along the third", () => {
    // Unreal x, y, z are three's x, z, y; side is Unreal x across and z up, seen along y
    const axes = (view: "top" | "front" | "side") => prismOf({ view, shapes: [] }).axes;
    expect(axes("side")).toEqual([0, 1, 2]);
    expect(axes("top")).toEqual([0, 2, 1]);
    expect(axes("front")).toEqual([2, 1, 0]);
  });

  test("a second view squeezes the prism: how far it reaches, read between evenly spaced places", () => {
    // two places, at a quarter and three quarters along: full depth, then only its lower half
    const spans = [0, 1000, 0, 500];
    // a top outline (pushed up, three's y) squeezed from the front: they share Unreal's y,
    // three's z, so how high a point reaches is read by how deep it is
    const { squeeze } = prismOf({ view: "top", shapes: [], squeeze: { view: "front", spans } });
    expect(squeeze?.([0, 0.5, -0.5])).toEqual([0, 0.5, -0.5]);
    expect(squeeze?.([0, 0.5, 0])).toEqual([0, 0.25, 0]);
    expect(squeeze?.([0, 0.5, 0.5])).toEqual([0, 0, 0.5]);
    expect(squeeze?.([0, -0.5, 0.5])).toEqual([0, -0.5, 0.5]);
    expect(prismOf({ view: "top", shapes: [] }).squeeze).toBeNull();
  });

  test("a rounded torus is a torus, and an Emissive material glows", () => {
    const [shape] = shapesOf({
      ...cubes(),
      items: [
        {
          class: "/Game/LevelEditor/MP_RoundedTorus.MP_RoundedTorus_C",
          transform: { location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          meshes: [
            {
              mesh: "/Game/Meshes/Torus.Torus",
              materials: ["/Game/M/MI_Env_Emissive_Red.MI_Env_Emissive_Red"],
            },
          ],
        },
      ],
    });
    expect(shape).toMatchObject({ kind: "torus", glow: true, colour: "#d8433a" });
  });

  test("Unreal's y lands on three's z, so two pieces apart in y are deep, not tall", () => {
    const pair = cubes(
      [
        [0, 0, 0],
        [0, 0, 0],
        [1, 1, 1],
      ],
      [
        [0, 2000, 0],
        [0, 0, 0],
        [1, 1, 1],
      ],
    );
    near(footprintOf(shapesOf(pair)), [10, 30, 10]);
  });
});

test("a vent is drawn at the air vent's size and in its own white, not as the unknown grey box", () => {
  const file = { ...cubes(), items: [VENT] } as unknown as PrefabFile;
  const [shape] = shapesOf(file);
  expect(shape.kind).toBe("box");
  expect(shape.size[0]).toBeCloseTo(1);
  expect(shape.size[1]).toBeCloseTo(0.0356);
  expect(shape.colour).toBe("#e8ecf2");
});

test("a piece reads as the editor's catalogue names it, without its blueprint prefix", () => {
  expect(pieceLabel("BP_Pipe_Tube1")).toBe("Pipe Tube 1");
  expect(pieceLabel("BP_Prim_Cube")).toBe("Cube");
  expect(pieceLabel("BP_Ramp_Curve_Long1")).toBe("Ramp Curve Long 1");
  expect(pieceLabel("Bevel_Full_Ring")).toBe("Bevel Full Ring");
  expect(pieceLabel("MP_AirVent")).toBe("Air Vent");
  expect(pieceLabel("MP_SM_ConeBowl")).toBe("Cone Bowl");
  expect(pieceLabel("Bevel_Full_HalfRingKicker")).toBe("Bevel Full Half Ring Kicker");
});

describe("the upload check", () => {
  test("both samples pass, with their piece counts", () => {
    expect(checkPrefab(sample("bench"))).toEqual({ ok: true, pieces: 28 });
    expect(checkPrefab(sample("testparkhill"))).toEqual({ ok: true, pieces: 153 });
  });

  const problems = (text: string) => {
    const r = checkPrefab(text);
    return r.ok ? [] : r.problems;
  };
  const withFile = (patch: object) => JSON.stringify({ ...JSON.parse(sample("bench")), ...patch });

  test("each rule fails with its own sentence", () => {
    expect(problems("not json")).toEqual(["This isn't a JSON file."]);
    expect(problems(withFile({ format: "BallestMap" }))).toEqual([
      'It isn\'t a prefab: "format" should be "BallestPrefab".',
    ]);
    expect(problems(withFile({ version: 2 }))).toEqual([
      "It's a prefab version this site doesn't know yet (only version 1).",
    ]);
    expect(problems(withFile({ group: null }))).toEqual(["Its group transform is missing."]);
    expect(problems(withFile({ items: "x" }))).toEqual(["It has no pieces."]);
    const one = (JSON.parse(sample("bench")) as PrefabFile).items.slice(0, 1);
    expect(problems(withFile({ items: one }))).toEqual(["A prefab needs at least 2 pieces."]);
    const many = Array.from({ length: 4097 }, () => one[0]);
    expect(problems(withFile({ items: many }))).toEqual([
      "It has 4097 pieces; the game takes at most 4096.",
    ]);
    const start = [
      one[0],
      { ...one[0], class: "/Game/Blueprints/MP_PlayerStart.MP_PlayerStart_C" },
    ];
    expect(problems(withFile({ items: start }))).toEqual([
      "It contains the start pad, which the game won't spawn in a prefab.",
    ]);
    const odd = [one[0], { ...one[0], class: "/Game/BP_Nope.BP_Nope_C" }];
    expect(problems(withFile({ items: odd }))).toEqual([
      "Pieces the editor doesn't have: BP_Nope.",
    ]);
  });

  test("pieces not laid out as the editor saves them are refused, not drawn", () => {
    const one = (JSON.parse(sample("bench")) as PrefabFile).items[0];
    const bare = { class: one.class };
    const noScale = { ...one, transform: { ...one.transform, scale: [1, 1] } };
    expect(problems(withFile({ items: [null, null] }))).toEqual([
      "2 pieces aren't laid out as the editor saves them (a position, rotation, scale and meshes each).",
    ]);
    expect(problems(withFile({ items: [one, bare, noScale] }))).toEqual([
      "2 pieces aren't laid out as the editor saves them (a position, rotation, scale and meshes each).",
    ]);
  });

  test("a vent passes as the editor saves it, with no mesh, materials or paint", () => {
    const one = (JSON.parse(sample("bench")) as PrefabFile).items[0];
    expect(checkPrefab(withFile({ items: [one, VENT] }))).toEqual({ ok: true, pieces: 2 });
  });

  test("the Rubber Block's thumbnail, RubberBlock, is not a piece the editor has", () => {
    const one = (JSON.parse(sample("bench")) as PrefabFile).items[0];
    const thumb = { ...one, class: "/Game/LevelEditor/SS/RubberBlock.RubberBlock_C" };
    expect(problems(withFile({ items: [one, thumb] }))).toEqual([
      "Pieces the editor doesn't have: RubberBlock.",
    ]);
  });

  test("a file over 4 MB is refused before it is read", () => {
    expect(problems(" ".repeat(MAX_BYTES + 1))).toEqual(["The file is over 4 MB."]);
  });

  test("download names are what the game's spawn command accepts", () => {
    expect(fileNameOf("Park hill")).toBe("park_hill.json");
    expect(fileNameOf("  Loop-gate #2!  ")).toBe("loop-gate_2.json");
    expect(fileNameOf("😀😀")).toBe("prefab.json");
    expect(fileNameOf("a".repeat(80))).toBe("a".repeat(64) + ".json");
  });
});

describe("the gallery's order", () => {
  const card = (slug: string, favorites: number, createdAt: string, tags: Array<string> = []) => ({
    slug,
    favorites,
    createdAt,
    tags,
  });
  const cards = [
    card("old-hit", 9, "2026-10-01T00:00:00.000Z", ["Ramp"]),
    card("new-quiet", 0, "2026-10-15T00:00:00.000Z"),
    card("tie-newer", 3, "2026-10-12T00:00:00.000Z", ["Ramp", "Loop"]),
    card("tie-older", 3, "2026-10-10T00:00:00.000Z"),
  ];
  const slugs = (list: Array<{ slug: string }>) => list.map((c) => c.slug);

  test("Popular is most favorited first, newest breaking a tie", () => {
    expect(slugs(galleryOf(cards, "popular", null))).toEqual([
      "old-hit",
      "tie-newer",
      "tie-older",
      "new-quiet",
    ]);
  });

  test("Newest is by when it was uploaded", () => {
    expect(slugs(galleryOf(cards, "newest", null))).toEqual([
      "new-quiet",
      "tie-newer",
      "tie-older",
      "old-hit",
    ]);
  });

  test("a tag keeps only the Prefabs carrying it", () => {
    expect(slugs(galleryOf(cards, "popular", "Ramp"))).toEqual(["old-hit", "tie-newer"]);
    expect(slugs(galleryOf(cards, "popular", "Structure"))).toEqual([]);
  });
});

describe("a Prefab's angle", () => {
  const ok = { from: [3, 0, 4], zoom: 2, pan: [0, 0, 0] };
  test("is tidied: its direction made unit length, every number to four places", () => {
    expect(checkAngle({ ...ok, zoom: 2.000049, pan: [1 / 3, 0, -0] })).toEqual({
      from: [0.6, 0, 0.8],
      zoom: 2,
      pan: [0.3333, 0, 0],
    });
  });
  test("can't be one with no direction, a zoom or pan past its limits, or a number that isn't one", () => {
    for (const bad of [
      null,
      5,
      { ...ok, from: [0, 0, 0] },
      { ...ok, from: [1, 0] },
      { ...ok, zoom: ZOOM_RANGE[0] / 2 },
      { ...ok, zoom: ZOOM_RANGE[1] * 2 },
      { ...ok, zoom: "2" },
      { ...ok, pan: [PAN_MAX + 1, 0, 0] },
      { ...ok, from: [NaN, 0, 1] },
      { ...ok, pan: [Infinity, 0, 0] },
      // each part finite, but too long to measure: it would tidy to [0, 0, 0]
      { ...ok, from: [1.7e308, 1.7e308, 1.7e308] },
    ])
      expect(checkAngle(bad)).toBeNull();
  });
  test("the default is itself an angle", () => {
    expect(checkAngle(DEFAULT_ANGLE)?.from[0]).toBeCloseTo(DEFAULT_ANGLE.from[0], 4);
  });
});

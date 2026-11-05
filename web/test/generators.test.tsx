// The Generators (spec #299): each makes a Prefab file from a few settings. Tested through
// generate() and each Generator's controls, the way the page drives them.
import { englishDataset } from "obscenity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { MakeGallery } from "../components/prefabs/make/MakeGallery";

import {
  CATEGORIES,
  COLOUR_NAMES,
  GENERATORS,
  PIECE_LIMIT,
  SPAWN_MOST,
  MARBLE,
  PIECE_FONTS,
  PIXEL_LETTERING,
  generate,
  generatorOf,
  pictureOf,
  refuses,
  readPicture,
  rotOf,
  spawnsOf,
  variationsOf,
  voxelBoxes,
  voxelTree,
  VOXEL_KINDS,
  type PieceFontName,
  type Values,
} from "../lib/generators";
import {
  UNKNOWN_COLOUR,
  footprintOf,
  rotationRows,
  shapesOf,
  spanOf,
  type PrefabFile,
  type PrefabItem,
} from "../lib/prefab";
import { faultsOf, parts } from "../lib/generators/checks";
import { ball, fileOf, piece } from "../lib/generators/pieces";
import { checkPrefab } from "../lib/prefab-check";
import { pieceLettering } from "../lib/generators/piece-fonts";
import { GENERATOR_KEYS, generatorHref } from "../lib/routes";

type V3 = [number, number, number];
const CUBE = 1000;
function gen(key: string) {
  const g = generatorOf(key);
  if (!g) throw new Error(`no Generator ${key}`);
  return g;
}
const valuesOf = (key: string, change: Values = {}): Values => ({
  ...gen(key).defaults,
  ...change,
});
function make(key: string, change: Values = {}) {
  const file = generate(key, valuesOf(key, change));
  if (!file) throw new Error(`${key} made nothing`);
  return file;
}

/* a cube's extent across a sign (+Y, left to right for the camera that spawned it)
   and up it (z), in cm */
const extent = (it: PrefabItem) => {
  const [, y, z] = it.transform.location;
  const [, sy, sz] = it.transform.scale;
  return { x0: y - (sy * CUBE) / 2, x1: y + (sy * CUBE) / 2, z0: z, z1: z + sz * CUBE };
};
/* the lowest any piece reaches, in cm: each shape's centre less its corners' reach downward
   (the matrix takes a unit shape centred on the origin, so a corner is half each column) */
const lowest = (file: PrefabFile) =>
  Math.min(
    ...shapesOf(file).map(
      (sh) =>
        sh.matrix[13] -
        (Math.abs(sh.matrix[1]) + Math.abs(sh.matrix[5]) + Math.abs(sh.matrix[9])) / 2,
    ),
  ) * 100;
const highest = (file: PrefabFile) =>
  Math.max(
    ...shapesOf(file).map(
      (sh) =>
        sh.matrix[13] +
        (Math.abs(sh.matrix[1]) + Math.abs(sh.matrix[5]) + Math.abs(sh.matrix[9])) / 2,
    ),
  ) * 100;
/* the nearest any piece reaches toward the camera that spawns it (-X), in cm */
const nearest = (file: PrefabFile) =>
  Math.min(
    ...shapesOf(file).map(
      (sh) =>
        sh.matrix[12] -
        (Math.abs(sh.matrix[0]) + Math.abs(sh.matrix[4]) + Math.abs(sh.matrix[8])) / 2,
    ),
  ) * 100;
const count = (file: PrefabFile, piece: string) =>
  file.items.filter((it) => it.class.includes(piece)).length;

/* how far a cube stands out of a sign toward the camera (-X), in cm */
const proud = (it: PrefabItem) => -(it.transform.location[0] - (it.transform.scale[0] * CUBE) / 2);

/* every Generator but the trees and the bush: their sticks dip a little under the floor where
   they start, and a Tree with every slider at its most is 4,531 pieces, over the limit */
const BUILT = GENERATORS.filter((g) => g.category !== "Nature").map((g) => g.key);

describe("every Generator", () => {
  test.each(GENERATORS.map((g) => g.key))("%s's defaults make a file the game takes", (key) => {
    const file = make(key);
    expect(checkPrefab(JSON.stringify(file))).toEqual({ ok: true, pieces: file.items.length });
  });

  /* a piece the editor's menus no longer offer: it still spawns, but a player can't pick it */
  test.each(GENERATORS.map((g) => g.key))("%s's defaults use only pieces in the menus", (key) => {
    const left = make(key).items.filter((it) => it.class.includes("BP_Prim_Sphere"));
    expect(left).toEqual([]);
  });

  test.each(GENERATORS.map((g) => g.key))("%s's defaults sit inside its sliders", (key) => {
    const g = gen(key);
    /* every choice's controls: a tree style's sliders show only once it is picked */
    const choices = g
      .controls(g.defaults)
      .flatMap((c) => (c.kind === "choice" ? c.options.map((o) => ({ [c.key]: o })) : []));
    for (const pick of [{}, ...choices])
      for (const c of g.controls({ ...g.defaults, ...pick }))
        if (c.kind === "number") {
          const v = Number(g.defaults[c.key]);
          expect(v, c.key).toBeGreaterThanOrEqual(c.min);
          expect(v, c.key).toBeLessThanOrEqual(c.max);
        }
  });
  test.each(BUILT)("%s stays within the game's limit at its largest", (key) => {
    const g = gen(key);
    /* no pick, then each option of each choice these values show */
    const picksOf = (values: Values): Array<Values> => [
      {},
      ...g
        .controls(values)
        .flatMap((c) => (c.kind === "choice" ? c.options.map((o) => ({ [c.key]: o })) : [])),
    ];
    const most: Values = { ...g.defaults };
    for (const pick of picksOf(g.defaults))
      for (const c of g.controls({ ...g.defaults, ...pick }))
        if (c.kind === "number") most[c.key] = c.max;
    for (const pick of picksOf(most))
      expect(make(key, { ...most, ...pick }).items.length).toBeLessThanOrEqual(PIECE_LIMIT);
  });

  test("a tree at its largest is too big for the game, and says so", () => {
    const most: Values = { ...gen("tree").defaults };
    for (const c of gen("tree").controls(most)) if (c.kind === "number") most[c.key] = c.max;
    const file = make("tree", most);
    expect(file.items.length).toBeGreaterThan(PIECE_LIMIT);
    expect(checkPrefab(JSON.stringify(file)).ok).toBe(false);
  });

  test.each(BUILT)("%s never reaches under the floor", (key) => {
    for (const { label, values } of variationsOf(gen(key))) {
      const file = generate(key, values);
      if (file) expect(lowest(file), `${key} ${label}`).toBeGreaterThanOrEqual(-1);
    }
  });
});

describe("spawning in parts", () => {
  /* 128 by 8 cells, red and white like a chessboard: 1,024 blocks, none merged */
  const chess = "128x8:" + ("ca".repeat(64) + "ac".repeat(64)).repeat(4);
  const big = (lay = "Standing") => make("pixel-art", { picture: chess, across: 128, lay });

  test("a small one is one part, itself", () => {
    const file = make("pixel-art");
    expect(spawnsOf(file)).toEqual({ parts: [file], marked: false });
  });

  test("a big one splits into parts the game can spawn, each reaching as near and as low", () => {
    for (const lay of ["Standing", "On the floor"]) {
      const file = big(lay);
      const { parts } = spawnsOf(file);
      expect(parts.length, lay).toBe(Math.ceil(file.items.length / (SPAWN_MOST - 1)));
      for (const p of parts) {
        expect(p.items.length, lay).toBeLessThanOrEqual(SPAWN_MOST);
        expect(nearest(p), lay).toBeCloseTo(nearest(file), 0);
        expect(lowest(p), lay).toBeCloseTo(lowest(file), 0);
        expect(checkPrefab(JSON.stringify(p)).ok, lay).toBe(true);
      }
      /* every piece once, and at most a marker more in each part */
      const all = parts.flatMap((p) => p.items);
      for (const it of file.items) expect(all).toContain(it);
      expect(all.length, lay).toBeLessThanOrEqual(file.items.length + parts.length);
    }
  });

  test("no part is a single piece, which the game won't spawn", () => {
    const file = big();
    /* lengths either side of where a split leaves one piece over */
    for (let n = SPAWN_MOST - 2; n <= 2 * SPAWN_MOST + 2; n++)
      for (const p of spawnsOf({ ...file, items: file.items.slice(0, n) }).parts)
        expect(p.items.length, `${String(n)} pieces`).toBeGreaterThanOrEqual(2);
  });
});

describe("the sign", () => {
  /* the boxes in front of the wall (or every box with none), as extents */
  const letters = (file: PrefabFile, wall: boolean) =>
    (wall ? file.items.slice(1) : file.items).map(extent);

  test.each([
    [12, 4],
    [3, 10],
    [40, 1],
    [1, 0.5],
  ])("fits its letters inside a %s m by %s m wall", (width, height) => {
    const file = make("sign", { text: "Welcome to my map, friend", width, height });
    const wall = extent(file.items[0]);
    for (const l of letters(file, true)) {
      expect(l.x0).toBeGreaterThanOrEqual(wall.x0 - 0.01);
      expect(l.x1).toBeLessThanOrEqual(wall.x1 + 0.01);
      expect(l.z0).toBeGreaterThanOrEqual(wall.z0 - 0.01);
      expect(l.z1).toBeLessThanOrEqual(wall.z1 + 0.01);
    }
  });

  test("faces the camera it spawns in front of, its letters standing out of the wall", () => {
    const [wall, ...letters] = make("sign", { wall: true }).items;
    for (const l of letters) expect(proud(l)).toBeGreaterThan(proud(wall));
  });

  test("with the wall off is letters standing on the ground, no plate", () => {
    const on = make("sign", { wall: true });
    const off = make("sign", { wall: false });
    expect(off.items.length).toBe(on.items.length - 1);
    expect(Math.min(...off.items.map((it) => it.transform.location[2]))).toBeCloseTo(0);
  });

  test("hides the wall's colour when the wall is off, and Detail in the Pixel font", () => {
    const keys = (change: Values) =>
      gen("sign")
        .controls(valuesOf("sign", change))
        .map((ctl) => ctl.key);
    expect(keys({ wall: false })).not.toContain("back");
    expect(keys({ wall: true })).toContain("back");
    expect(keys({ font: "Pixel" })).not.toContain("detail");
    expect(keys({ font: "Bungee" })).toContain("detail");
  });

  test("keeps a dash at its height in its line, not on the ground", () => {
    const dash = make("sign", { text: "-", wall: false });
    expect(Math.min(...dash.items.map((it) => it.transform.location[2]))).toBeGreaterThan(0);
  });

  test("letters an A in Pixel as its table draws it", () => {
    const grid = PIXEL_LETTERING.grid(["A"]) ?? { w: 0, h: 0, on: () => false };
    const rows = Array.from({ length: grid.h }, (_, y) =>
      Array.from({ length: grid.w }, (_, x) => (grid.on(x, y) ? "#" : ".")).join(""),
    );
    expect(rows).toEqual([".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"]);
  });

  test("makes nothing from no text", () => {
    expect(generate("sign", valuesOf("sign", { text: "   " }))).toBeNull();
  });

  /* players spawn it into Maps others race on, so it won't letter a word from obscenity's
     English list however it is disguised, nor a hate symbol or code. The words come from the
     list, so none are written here; it keeps them in private metadata, with no public getter */
  const phrases = (
    englishDataset as unknown as { containers: Array<{ metadata?: { originalWord?: string } }> }
  ).containers;
  const listed = [...new Set(phrases.map((c) => c.metadata?.originalWord ?? ""))]
    .filter(Boolean)
    .filter((w) => refuses("sign", valuesOf("sign", { text: w })));
  /* one word a character at a time (a phrase's words would run together, so it stays as typed) */
  const spell = (sep: string) => (w: string) => (w.includes(" ") ? w : w.split("").join(sep)); // the list is ASCII;
  const leet = (w: string) =>
    w.replace(/[aeios]/g, (ch) => ({ a: "4", e: "3", i: "1", o: "0", s: "5" })[ch] ?? ch);
  test("refuses obscenity's list, so the test has words to refuse", () => {
    expect(listed.length).toBeGreaterThan(50);
  });
  test.each([
    ["in capitals", (w: string) => w.toUpperCase()],
    ["inside a sentence", (w: string) => `my ${w} map`],
    ["spelled out", spell(" ")],
    ["spelled out with dots", spell(".")],
    ["spelled out with wide gaps", spell("    ")],
    ["in l33t", leet],
  ])("refuses every listed word %s, and makes nothing from it", (_, disguise) => {
    const letters = listed.filter((w) => !refuses("sign", valuesOf("sign", { text: disguise(w) })));
    expect(letters).toEqual([]);
    expect(generate("sign", valuesOf("sign", { text: disguise(listed[0]) }))).toBeNull();
  });

  test.each(["1488", "1.4.8.8", "KKK rally", "\u5350", "\u534D", "\u0FD5"])(
    "refuses the hate code or symbol %j",
    (text) => {
      expect(refuses("sign", valuesOf("sign", { text }))).toBe(true);
    },
  );

  test.each([
    "Welcome to my map",
    "Scunthorpe",
    "Bass Shop",
    "assassin",
    "Grape Escape",
    "U S A",
    "Ashkenazi",
    "Room 14880",
    "Cockpit view",
    "Shiitake",
  ])("letters clean text like %j, rude words inside a word included", (text) => {
    expect(refuses("sign", valuesOf("sign", { text }))).toBe(false);
    expect(generate("sign", valuesOf("sign", { text }))).not.toBeNull();
  });
});

describe("the sign in R23's piece fonts", () => {
  /* where the pieces reach, in cm, along three's axis k: 0 Unreal's x (toward the camera at
     its least), 1 up, 2 across the sign (Unreal's y) */
  const reach = (items: Array<PrefabItem>, k: number) => {
    const spans = shapesOf({ format: "BallestPrefab", version: 1, group: GROUP, items }).map((sh) =>
      spanOf(sh, k),
    );
    return [Math.min(...spans.map((s) => s[0])) * 100, Math.max(...spans.map((s) => s[1])) * 100];
  };
  const GROUP = { rotation: [0, 0, 0] as V3, scale: [1, 1, 1] as V3 };
  const glyphs = (font: PieceFontName) => PIECE_FONTS[font].glyphs;
  const sizeOf = (ch: string, font: PieceFontName) => glyphs(font)[ch].pieces.length;

  test.each(["Graduate", "Leker"] as const)(
    "%s letters with the pieces its Prefabs are built from",
    (font) => {
      const text = font === "Graduate" ? "AB" : "ab";
      const file = make("sign", { font, text, wall: false });
      expect(file.items.length).toBe(sizeOf(text[0], font) + sizeOf(text[1], font));
      expect(file.items.every((it) => /BP_(Track|Ramp)|Cylinder|CornerScoop/.test(it.class))).toBe(
        true,
      );
      expect(checkPrefab(JSON.stringify(file))).toEqual({ ok: true, pieces: file.items.length });
    },
  );

  test("Graduate letters in capitals and Leker in lower case, whichever is typed", () => {
    expect(make("sign", { font: "Graduate", text: "Ab" })).toEqual(
      make("sign", { font: "Graduate", text: "AB" }),
    );
    expect(make("sign", { font: "Leker", text: "Ab" })).toEqual(
      make("sign", { font: "Leker", text: "ab" }),
    );
  });

  test("letters a character neither font has as a ?, and ' . : from the pieces it has", () => {
    expect(make("sign", { font: "Graduate", text: "A&" })).toEqual(
      make("sign", { font: "Graduate", text: "A?" }),
    );
    for (const ch of [".", ":", "'", '"'])
      expect(make("sign", { font: "Leker", text: `a${ch}` })).not.toEqual(
        make("sign", { font: "Leker", text: "a?" }),
      );
  });

  test.each([
    ["Graduate", 12, 4],
    ["Leker", 3, 10],
    ["Graduate", 40, 1],
    ["Leker", 1, 0.5],
  ])("in %s fits inside a %s m by %s m wall and stands out of its face", (font, width, height) => {
    const [wall, ...letters] = make("sign", {
      font,
      text: "Welcome to my map, friend!",
      width,
      height,
      wall: true,
    }).items;
    const [across, up, out] = [reach(letters, 2), reach(letters, 1), reach(letters, 0)];
    const w = width * 100;
    const h = height * 100;
    expect(across[0]).toBeGreaterThanOrEqual(-w / 2 - 0.01);
    expect(across[1]).toBeLessThanOrEqual(w / 2 + 0.01);
    expect(up[0]).toBeGreaterThanOrEqual(-0.01);
    expect(up[1]).toBeLessThanOrEqual(h + 0.01);
    /* centred across and up the wall */
    expect(across[0] + across[1]).toBeCloseTo(0, 0);
    expect(up[0] + up[1]).toBeCloseTo(h, 0);
    /* on the wall's face, toward the camera at -X */
    expect(out[1]).toBeCloseTo(reach([wall], 0)[0], 0);
  });

  test("stands its letters up, reading left to right for the camera at -X", () => {
    const file = make("sign", { font: "Graduate", text: "L", wall: false, height: 10 });
    const [across, up, out] = [reach(file.items, 2), reach(file.items, 1), reach(file.items, 0)];
    /* an L is taller than it is wide, and as deep as R23 built it, in proportion */
    const L = glyphs("Graduate").L;
    const built = pieceLettering("Graduate").pieces(["L"], 1, "Dark");
    const [bOut, bUp] = [reach(built, 0), reach(built, 1)];
    expect((up[1] - up[0]) / (across[1] - across[0])).toBeCloseTo(L.top / L.w, 1);
    expect((out[1] - out[0]) / (up[1] - up[0])).toBeCloseTo(
      (bOut[1] - bOut[0]) / (bUp[1] - bUp[0]),
      2,
    );
    expect(up[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(0);
    /* its foot runs right from its stem: the stem's at the left (-Y) */
    const stem = file.items.filter(
      (it) => reach([it], 1)[1] - reach([it], 1)[0] > (up[1] - up[0]) / 2,
    );
    expect(stem.length).toBeGreaterThan(0);
    for (const s of stem) expect(reach([s], 2)[0]).toBeLessThan((across[0] + across[1]) / 2);
  });

  test("opens a straight quote after a space or a bracket and closes it after a word", () => {
    expect(make("sign", { font: "Leker", text: '("hi")' })).toEqual(
      make("sign", { font: "Leker", text: "(“hi”)" }),
    );
  });

  test("wraps text that grows in capitals (ß is SS) without splitting a word", () => {
    expect(make("sign", { font: "Graduate", text: "straße", width: 1, height: 10 })).toEqual(
      make("sign", { font: "Graduate", text: "STRASSE", width: 1, height: 10 }),
    );
  });

  test("paints every piece in the Letters colour", () => {
    const file = make("sign", { font: "Leker", text: "hi", front: "Red", wall: false });
    for (const it of file.items) {
      for (const m of it.meshes[0].materials) expect(m).toMatch(/MI_Env_Red_Smooth/);
      expect(it.paint?.colors.every((c) => c === 3)).toBe(true);
    }
  });

  test("shows no Detail, which a built font doesn't have", () => {
    const keys = gen("sign")
      .controls(valuesOf("sign", { font: "Leker" }))
      .map((ctl) => ctl.key);
    expect(keys).not.toContain("detail");
  });
});

describe("the tree and the bush", () => {
  const cases: Array<[string, Values]> = [
    ["tree", {}],
    ["pine", { "t.snow": true }],
    ["block-tree", { "v.kind": "Oak" }],
    ["block-tree", { "v.kind": "Birch" }],
    ["block-tree", { "v.kind": "Spruce" }],
    ["block-tree", { "v.kind": "Jungle" }],
    ["bush", {}],
  ];

  test.each(cases)(
    "%s %o is the same for the same seed and passes the game's check",
    (key, change) => {
      const a = make(key, { ...change, seed: 42 });
      expect(make(key, { ...change, seed: 42 })).toEqual(a);
      expect(checkPrefab(JSON.stringify(a)).ok).toBe(true);
    },
  );

  test.each(cases)("%s %o changes with Shuffle", (key, change) => {
    expect(make(key, { ...change, seed: 1 })).not.toEqual(make(key, { ...change, seed: 2 }));
  });

  test.each(VOXEL_KINDS)("a voxel %s's boxes cover exactly its voxels", (kind) => {
    const values = valuesOf("block-tree", { "v.kind": kind, "v.cell": 100 });
    const vox = voxelTree(values);
    const covered = new Map<string, string>();
    for (const it of voxelBoxes(vox, 100)) {
      const [x, y, z] = it.transform.location;
      const [sx, sy] = it.transform.scale;
      const [w, d] = [Math.round((sx * CUBE) / 100), Math.round((sy * CUBE) / 100)];
      const x0 = Math.round(x / 100 - w / 2 + 0.5);
      const y0 = Math.round(y / 100 - d / 2 + 0.5);
      for (let i = 0; i < w; i++)
        for (let j = 0; j < d; j++) {
          const k = `${x0 + i},${y0 + j},${Math.round(z / 100)}`;
          expect(covered.has(k), k).toBe(false);
          covered.set(k, it.meshes[0].materials[0]);
        }
    }
    expect([...covered.keys()].sort()).toEqual([...vox.keys()].sort());
  });

  test("each kind of tree is its own Generator, under Nature", () => {
    const keys = (key: string) =>
      gen(key)
        .controls(gen(key).defaults)
        .map((ctl) => ctl.key);
    expect(keys("tree")).toContain("b.levels");
    expect(keys("pine")).toContain("t.tiers");
    expect(keys("block-tree")).toContain("v.kind");
    for (const key of ["tree", "pine", "block-tree", "bush"])
      expect(gen(key).category).toBe("Nature");
  });
});

describe("buildings", () => {
  const tall = (key: string, change: Values) => footprintOf(shapesOf(make(key, change))).h;
  const isRound = (it: PrefabItem) => /BP_Prim_Cylinder|MP_Cone/.test(it.class);

  test("are House, Tower and Castle, under Buildings", () => {
    expect(GENERATORS.filter((g) => g.category === "Buildings").map((g) => g.key)).toEqual([
      "house",
      "tower",
      "castle",
    ]);
  });

  test("a house with more floors is taller, and a tower with more floors taller still", () => {
    expect(tall("house", { floors: 3 })).toBeGreaterThan(tall("house", { floors: 1 }) + 5);
    expect(tall("tower", { floors: 40 })).toBeGreaterThan(tall("tower", { floors: 10 }) + 50);
  });

  test("a castle without towers or a keep has no round pieces and no roofs", () => {
    const items = make("castle", { towers: false, keep: false, gate: 0 }).items;
    expect(items.filter(isRound)).toEqual([]);
    expect(items.filter((it) => it.class.includes("MP_Pyramid"))).toEqual([]);
  });

  test("a hip roof's pyramids are turned to the walls and cover the house", () => {
    const pyramids = make("house", { roof: "Hip", width: 12, depth: 8 }).items.filter((it) =>
      it.class.includes("MP_Pyramid"),
    );
    expect(pyramids).toHaveLength(2);
    for (const p of pyramids) {
      expect(p.transform.rotation[1]).toBe(45);
      /* SM_Pyramid is 500 cm across its corners; turned, its square side is that over √2 */
      expect((p.transform.scale[0] * 500) / Math.SQRT2).toBeGreaterThanOrEqual(800);
    }
  });

  /* a cube's span along each axis, in cm */
  const span = (it: PrefabItem) => {
    const [x, y, z] = it.transform.location;
    const [sx, sy, sz] = it.transform.scale.map((k) => k * CUBE);
    return { x0: x - sx / 2, x1: x + sx / 2, y0: y - sy / 2, y1: y + sy / 2, z0: z, z1: z + sz };
  };
  const coloured = (file: PrefabFile, material: string) =>
    file.items.filter(
      (it) => it.class.includes("BP_Prim_Cube") && it.meshes[0].materials[0].includes(material),
    );

  test.each([
    [4, 8, true],
    [4, 2, true],
    [9, 3, true],
    [30, 8, false],
  ])(
    "a %s m house's %s windows a side never overlap, and the door never meets one",
    (width, windows, door) => {
      const file = make("house", { width, depth: 4, windows, door, floors: 1 });
      const panes = coloured(file, "SkyBlue").map(span);
      const doorPanel = coloured(file, "Dark").find(
        (it) => span(it).z1 - span(it).z0 > 150 && span(it).z0 < 60,
      );
      expect(!!doorPanel).toBe(door);
      const W = width * 100;
      for (const [i, a] of panes.entries()) {
        expect(a.y0).toBeGreaterThanOrEqual(-W / 2);
        expect(a.y1).toBeLessThanOrEqual(W / 2);
        for (const b of panes.slice(i + 1))
          expect(
            a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0,
            "panes overlap",
          ).toBe(true);
        const doorway = doorPanel && span(doorPanel);
        if (doorway && a.x0 < -150)
          expect(a.y1 <= doorway.y0 || doorway.y1 <= a.y0, "a pane in the doorway").toBe(true);
      }
    },
  );

  test.each(["Gable", "Hip"])("a %s-roofed house's chimney stands above its roof", (roof) => {
    for (const [width, depth] of [
      [4, 30],
      [30, 4],
      [9, 7],
    ]) {
      const file = make("house", { roof, width, depth, chimney: true });
      const chimney = coloured(file, "Dark")
        .map(span)
        .find((b) => Math.abs(b.x1 - b.x0 - 60) < 1 && Math.abs(b.y1 - b.y0 - 60) < 1);
      /* the roof's highest point: each shape's centre plus its corners' reach upward */
      const roofShapes = shapesOf({
        ...file,
        items: file.items.filter((it) => it.meshes[0].materials[0].includes("Wine")),
      });
      /* the matrix takes a unit shape centred on the origin, so a corner is half each column */
      const reach = (m: Array<number>) => (Math.abs(m[1]) + Math.abs(m[5]) + Math.abs(m[9])) / 2;
      const ridge = Math.max(...roofShapes.map((sh) => sh.matrix[13] + reach(sh.matrix))) * 100;
      expect(chimney?.z1 ?? 0, `${roof} ${width}x${depth}`).toBeGreaterThan(ridge);
    }
  });

  test("a castle's gate towers and battlements stay within its walls at any gate", () => {
    for (const [size, gate, merlons] of [
      [10, 10, 3],
      [10, 4, 0.7],
      [24, 4, 1],
    ]) {
      const S = size * 100;
      const file = make("castle", { size, gate, merlons, towers: false });
      for (const b of file.items.filter((it) => it.class.includes("BP_Prim_Cube")).map(span)) {
        expect(Math.max(-b.x0, b.x1, -b.y0, b.y1), `${size} m, gate ${gate} m`).toBeLessThanOrEqual(
          S / 2 + S * 0.15 + 1,
        );
        expect(Math.max(-b.y0, b.y1), `${size} m, gate ${gate} m`).toBeLessThanOrEqual(S / 2 + 60);
      }
    }
  });
});

describe("the pieces", () => {
  test("a ball is the Shapes menu's sphere, centred where it's asked, its pivot at its centre", () => {
    const it = ball([100, 200, 500], 300, "Lime", 0.5);
    expect(it.class).toContain("BP_GlossyRed_WholeSphere");
    expect(it.transform.location).toEqual([100, 200, 500]);
    const [shape] = shapesOf(fileOf([it]));
    expect(shape.kind).toBe("sphere");
    /* three's metres: up is y */
    const [lo, hi] = spanOf(shape, 1);
    expect(lo).toBeCloseTo(4.25);
    expect(hi).toBeCloseTo(5.75);
  });

  test.each([
    [
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 1, 0.3],
      [0, 0, 1],
    ],
    [
      [-1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0.2, -0.7, -0.4],
      [0.5, 0.2, 0.8],
    ],
  ] as Array<[V3, V3]>)("rotOf(%o, %o) turns a piece's x and up that way", (f, u) => {
    const [x, , z] = rotationRows(rotOf(f, u));
    const n = (v: V3) => v.map((k) => k / Math.hypot(...v));
    n(f).forEach((k, i) => expect(x[i]).toBeCloseTo(k));
    /* up as near as it goes square to forward */
    const fu = n(f).reduce((a, k, i) => a + k * u[i], 0);
    const square = n(u.map((k, i) => k - fu * n(f)[i]) as V3);
    square.forEach((k, i) => expect(z[i]).toBeCloseTo(k));
  });
});

describe("the checks", () => {
  test("no Generator has a fault in any variation the collage draws", () => {
    for (const g of GENERATORS) {
      const base = generate(g.key, g.defaults);
      for (const { label, values } of variationsOf(g))
        expect(
          faultsOf(generate(g.key, values), g.loose || !base ? Infinity : parts(base)),
          `${g.key} ${label}`,
        ).toEqual([]);
    }
  });

  test("a gap between pieces is two parts, a touching pair is one, and a piece under the floor is a fault", () => {
    const cube = (at: V3) => piece("cube", at, [100, 100, 100], "White");
    expect(parts(fileOf([cube([0, 0, 0]), cube([100, 0, 0])]))).toBe(1);
    expect(parts(fileOf([cube([0, 0, 0]), cube([300, 0, 0])]))).toBe(2);
    expect(faultsOf(fileOf([cube([0, 0, -100]), cube([0, 0, 0])]), 1).map((f) => f.kind)).toEqual([
      "floor",
    ]);
    expect(faultsOf(null, 1).map((f) => f.kind)).toEqual(["empty"]);
  });

  test("a block tree's canopy never reaches the ground's far side, and a pine's tiers touch", () => {
    expect(lowest(make("block-tree", { "v.height": 4, "v.radius": 3 }))).toBeGreaterThanOrEqual(-1);
    expect(parts(make("pine", { "t.overlap": 0, seed: 7 }))).toBe(1);
  });
});

describe("the categories", () => {
  test("hold the Useful ones, then Racing, then Decor, each of the new five", () => {
    const under = (c: string) => GENERATORS.filter((g) => g.category === c).map((g) => g.key);
    expect(under("Useful")).toEqual([
      "sign",
      "arrow",
      "pixel-art",
      "stairs",
      "bridge",
      "floor-tiles",
    ]);
    expect(under("Racing")).toEqual(["spiral", "loop", "jump", "plinko", "rollers"]);
    expect(under("Decor")).toEqual(["lamp", "fountain", "trophy", "fence", "finish-arch"]);
  });
});

describe("the racing pieces", () => {
  test("a spiral with more turns is taller, and without walls is a third the pieces", () => {
    expect(highest(make("spiral", { turns: 4 }))).toBeGreaterThan(
      highest(make("spiral", { turns: 2 })) + 700,
    );
    const on = make("spiral", { walls: true, column: false });
    const off = make("spiral", { walls: false, column: false });
    expect(off.items.length * 3).toBe(on.items.length);
  });

  test("a loop's top is its diameter up, its surface there facing down", () => {
    const file = make("loop", { radius: 5, walls: false, lead: 0 });
    const top = file.items.reduce((a, b) =>
      b.transform.location[2] > a.transform.location[2] ? b : a,
    );
    expect(rotationRows(top.transform.rotation)[2][2]).toBeLessThan(-0.9);
    expect(highest(file)).toBeGreaterThan(1000);
    expect(highest(file)).toBeLessThan(1000 + 100);
  });

  test("a jump with a wider gap is longer", () => {
    const long = (change: Values) => footprintOf(shapesOf(make("jump", change))).w;
    expect(long({ gap: 12 })).toBeCloseTo(long({ gap: 6 }) + 6, 0);
  });

  test("a plinko board's pegs grow in number as they close up, and stay on the board", () => {
    expect(count(make("plinko", { spacing: 0.8 }), "Cylinder")).toBeGreaterThan(
      count(make("plinko", { spacing: 1.6 }), "Cylinder") * 3,
    );
    for (const it of make("plinko", { width: 5, spacing: 0.7 }).items)
      if (it.class.includes("Cylinder"))
        expect(Math.abs(it.transform.location[1])).toBeLessThan(250);
  });

  test("rollers rise to their bump height and have a piece more for each bump", () => {
    const file = make("rollers", { height: 2, bumps: 2, walls: false });
    /* the bumps over the track's 30 cm slab, its pieces' ends a little proud at the crests */
    expect(highest(file)).toBeGreaterThan(200 + 30);
    expect(highest(file)).toBeLessThan(200 + 30 + 30);
    expect(make("rollers", { bumps: 6, walls: false }).items.length).toBe(
      make("rollers", { bumps: 5, walls: false }).items.length + 10,
    );
  });
});

describe("the decor", () => {
  test("lamps come one post each", () => {
    for (const style of ["Street", "Lantern", "Globe", "Double"]) {
      const posts = (n: number) =>
        make("lamp", { style, count: n }).items.filter(
          (it) => it.class.includes("Cylinder") && it.transform.scale[2] * 200 >= 490,
        ).length;
      expect(posts(4), style).toBe(4);
    }
  });

  test("a street lamp's shade is a cone wide at the bottom, over its bulb", () => {
    const items = make("lamp", { style: "Street" }).items;
    const shade = items.find((it) => it.class.includes("MP_Cone"));
    expect(shade?.transform.rotation).toEqual([0, 0, 0]);
    const bulb = items.find((it) => it.class.includes("Sphere"));
    expect(shade?.transform.location[2]).toBeGreaterThan(bulb?.transform.location[2] ?? 0);
  });

  test("a fountain of one tier has no column, and more tiers stand taller", () => {
    expect(highest(make("fountain", { tiers: 3, jet: false }))).toBeGreaterThan(
      highest(make("fountain", { tiers: 1, jet: false })) + 100,
    );
    expect(
      make("fountain", { tiers: 1, jet: false }).items.some((it) => it.class.includes("Cone")),
    ).toBe(false);
  });

  test("a trophy is as tall as asked, a ball on top has no cup, and no handles is fewer sticks", () => {
    expect(highest(make("trophy", { height: 5 }))).toBeCloseTo(500, -1);
    expect(count(make("trophy", { top: "Ball" }), "MP_Cone")).toBe(0);
    expect(count(make("trophy", { handles: false }), "Cylinder")).toBe(
      count(make("trophy", { handles: true }), "Cylinder") - 12,
    );
  });

  test("a pen is four sides, with a gate gap in the front's middle", () => {
    const pen = make("fence", { shape: "Pen", style: "Wall", length: 10, gate: true });
    const front = pen.items.filter((it) => it.transform.location[0] < -400);
    for (const it of front) {
      const [, y] = it.transform.location;
      const half = (it.transform.scale[1] * CUBE) / 2;
      expect(Math.abs(y) - half, "a piece in the gateway").toBeGreaterThanOrEqual(99);
    }
    expect(footprintOf(shapesOf(pen)).d).toBeGreaterThan(10);
  });

  test("an arch's banner has every other check, on both faces", () => {
    const file = make("finish-arch", { width: 8, banner: 1, rows: 2, flags: false });
    const checks = file.items.filter((it) => Math.abs(it.transform.scale[0] * CUBE - 4) < 0.01);
    expect(checks).toHaveLength(2 * 16);
  });
});

describe("the useful ones", () => {
  /* a sign's raised cells, as their spans across it */
  const across = (file: PrefabFile) =>
    file.items
      .slice(1)
      .map((it) => extent(it))
      .map((e) => [Math.round(e.x0), Math.round(e.x1), Math.round(e.z0)].join());
  const mirrored = (file: PrefabFile) =>
    file.items
      .slice(1)
      .map((it) => extent(it))
      .map((e) => [Math.round(-e.x1), Math.round(-e.x0), Math.round(e.z0)].join());

  test("an arrow pointing left is one pointing right, mirrored", () => {
    for (const shape of ["Arrow", "Turn", "U-turn", "Chevrons"])
      expect(new Set(across(make("arrow", { shape, points: "Left", detail: 20 }))), shape).toEqual(
        new Set(mirrored(make("arrow", { shape, points: "Right", detail: 20 }))),
      );
  });

  test("a picture reads back as it was written, each colour the nearest", () => {
    const rgba = [255, 255, 255, 255, 0, 0, 0, 0, 216, 67, 58, 255, 155, 226, 45, 255];
    const pic = readPicture(pictureOf(rgba, 2, 2));
    expect(pic && [pic.at(0, 0), pic.at(1, 0), pic.at(0, 1), pic.at(1, 1)]).toEqual([
      "White",
      null,
      "Red",
      "Lime",
    ]);
    expect(readPicture("3x3:abc")).toBeNull();
  });

  test("pixel art's blocks cover the picture's cells, and only those", () => {
    const pic = readPicture(MARBLE);
    if (!pic) throw new Error("no marble");
    let cells = 0;
    for (let y = 0; y < pic.h; y++) for (let x = 0; x < pic.w; x++) if (pic.at(x, y)) cells++;
    const area = make("pixel-art", { across: 16, block: 10 })
      .items.map((it) => extent(it))
      .reduce((a, e) => a + ((e.x1 - e.x0) * (e.z1 - e.z0)) / 100, 0);
    expect(area).toBeCloseTo(cells);
  });

  test("pixel art goes up to 128 blocks across", () => {
    /* a row of 128 cells, red and white by turns: one block each, none merged */
    const picture = "128x1:" + "ca".repeat(64);
    expect(gen("pixel-art").controls(valuesOf("pixel-art"))).toContainEqual(
      expect.objectContaining({ key: "across", max: 128 }),
    );
    expect(make("pixel-art", { picture, across: 128 }).items).toHaveLength(128);
  });

  test("a tall picture is held to 128 blocks the longer way", () => {
    /* two columns, red and white, four times as tall as wide */
    const picture = "2x8:" + "ca".repeat(8);
    const file = make("pixel-art", { picture, across: 128, block: 10 });
    expect(file.items).toHaveLength(2);
    expect(highest(file)).toBeCloseTo(1280);
  });

  test("a tall picture's slider stops where it reaches 128 blocks tall", () => {
    /* 3 by 7: 55 across makes 128 tall (54 would make 126) */
    const picture = "3x7:" + "cac".repeat(7);
    expect(gen("pixel-art").controls(valuesOf("pixel-art", { picture }))).toContainEqual(
      expect.objectContaining({ key: "across", max: 55 }),
    );
    expect(highest(make("pixel-art", { picture, across: 128, block: 10 }))).toBeCloseTo(1280);
    /* two cells across, 300 tall, red and white by rows: still no more than 128 */
    const thin = "2x300:" + "ccaa".repeat(150);
    expect(highest(make("pixel-art", { picture: thin, across: 128, block: 10 }))).toBeCloseTo(1280);
  });

  test("pixel art laid on the floor lies flat, a block deep", () => {
    expect(highest(make("pixel-art", { lay: "On the floor", block: 20 }))).toBeCloseTo(20);
  });

  test("stairs climb to their height in steps of about their step height", () => {
    for (const shape of ["Straight", "Spiral"]) {
      const file = make("stairs", { shape, height: 3, rise: 20, rails: false });
      expect(count(file, "Cube"), shape).toBe(15);
      expect(highest(file), shape).toBeCloseTo(300, -1);
    }
  });

  test("an arched bridge rises to its arch height in the middle", () => {
    const file = make("bridge", { style: "Arch", span: 20, rise: 3, rails: false });
    expect(highest(file)).toBeGreaterThan(300);
    expect(highest(file)).toBeLessThan(300 + 40);
    expect(Math.max(footprintOf(shapesOf(file)).w, footprintOf(shapesOf(file)).d)).toBeGreaterThan(
      19.9,
    );
  });

  test("a checker is a tile each, stripes a strip a row", () => {
    expect(make("floor-tiles", { pattern: "Checker", across: 6, deep: 5 }).items).toHaveLength(30);
    expect(make("floor-tiles", { pattern: "Stripes", across: 6, deep: 5 }).items).toHaveLength(5);
    const box = footprintOf(shapesOf(make("floor-tiles", { across: 8, deep: 4, tile: 2 })));
    expect([box.w, box.d].sort((a, b) => a - b)).toEqual([8, 16]);
  });
});

describe("colours", () => {
  /* pairs read from prefabs the editor saved (prefabs/samples) */
  test.each([
    ["Dark", "MI_Env_Dark_Smooth", "MaterialCategory_Smooth", 2],
    ["White", "MI_Env_White_Smooth", "MaterialCategory_Smooth", 1],
    ["Lime", "MI_Env_Lime_Smooth", "MaterialCategory_Smooth", 6],
  ])("%s is painted as the editor saves it", (colour, material, category, index) => {
    const item = make("sign", { back: colour }).items[0];
    expect(item.meshes[0].materials[0]).toMatch(new RegExp(`/${material}[.]${material}$`));
    expect(item.paint).toEqual({
      categories: [`/Game/Art/DataAssets/BallestMaterials/${category}.${category}`],
      colors: [index],
    });
  });

  test("the site's viewer draws every colour, each in a colour of its own", () => {
    const drawn = COLOUR_NAMES.map((name) => shapesOf(make("sign", { back: name }))[0].colour);
    expect(drawn).not.toContain(UNKNOWN_COLOUR);
    expect(new Set(drawn).size).toBe(COLOUR_NAMES.length);
  });
});

describe("the pages", () => {
  test("only the sign letters, so only its page loads the fonts", () => {
    expect(GENERATORS.filter((g) => g.lettered).map((g) => g.key)).toEqual(["sign"]);
  });

  test("link every Generator, in GENERATORS' order", () => {
    expect(GENERATORS.map((g) => g.key)).toEqual([...GENERATOR_KEYS]);
    expect(generatorHref("tree")).toBe("/prefabs/make/tree");
    expect(generatorHref("no-such-generator")).toBe("/prefabs/make");
  });

  test("Make your own shows a card per Generator, and no tabs of its own (the header has them)", () => {
    const html = renderToStaticMarkup(<MakeGallery />);
    expect(html).not.toContain('href="/prefabs"');
    expect(html).not.toContain("aria-current");
    for (const g of GENERATORS) expect(html).toContain(`href="/prefabs/make/${g.key}"`);
  });

  test("Generate your own puts each Generator under its category's heading, in order", () => {
    const html = renderToStaticMarkup(<MakeGallery />);
    const at = (s: string) => html.indexOf(s);
    expect(CATEGORIES.map((c) => at(`>${c}</h2>`))).toEqual(
      [...CATEGORIES.map((c) => at(`>${c}</h2>`))].sort((a, b) => a - b),
    );
    CATEGORIES.forEach((c, i) => {
      const from = at(`>${c}</h2>`);
      const to = i + 1 < CATEGORIES.length ? at(`>${CATEGORIES[i + 1]}</h2>`) : html.length;
      expect(from).toBeGreaterThan(0);
      for (const g of GENERATORS.filter((x) => x.category === c)) {
        const card = at(`href="/prefabs/make/${g.key}"`);
        expect(card, g.key).toBeGreaterThan(from);
        expect(card, g.key).toBeLessThan(to);
      }
    });
  });
});

describe("the collage's variations", () => {
  test("are the defaults, then each control pushed to each end, each option and each switch", () => {
    const rows = variationsOf(gen("castle"));
    const labels = rows.map((r) => r.label);
    expect(labels[0]).toBe("defaults");
    expect(labels).toContain("Size 10 m");
    expect(labels).toContain("Size 80 m");
    expect(labels).toContain("Corner towers off");
    expect(labels).not.toContain("Stone");
    const defaults = gen("castle").defaults;
    for (const { values } of rows)
      expect(
        Object.keys(values).filter((k) => values[k] !== defaults[k]).length,
      ).toBeLessThanOrEqual(1);
  });

  test("can be narrowed to some controls", () => {
    const rows = variationsOf(gen("house"), ["roof"]);
    expect(rows.map((r) => r.label)).toEqual(["defaults", "Roof Gable", "Roof Hip", "Roof Flat"]);
  });

  test("each make a file within the game's limit, for every Generator", () => {
    for (const g of GENERATORS)
      for (const { label, values } of variationsOf(g)) {
        const file = generate(g.key, values);
        if (file) expect(file.items.length, `${g.key} ${label}`).toBeLessThanOrEqual(PIECE_LIMIT);
      }
  });
});

// The pieces every Generator builds from (lib/generators/index.ts): the colours and their paint,
// the editor's primitives placed by their bottom centre (or a box by its centre), the grid merge,
// the seeded random, the controls' shapes and the Generator interface itself.
import { rotationRows, shapesOf, spanOf, type PrefabFile, type PrefabItem } from "../prefab";
import type { PrefabAngle } from "../prefabs";
import type { Grid, Lettering } from "../generator-letters";

/* the most pieces spawnprefab takes (lib/prefab-check.ts) */
export const PIECE_LIMIT = 4096;
/* the most pieces one spawn can hold without running out the game's objects: its cost grows
   with the square of the pieces, and 289 spawned in a sandbox game where 400 crashed it */
export const SPAWN_MOST = 240;

/* ---------- colours ---------- */
/* each colour the Generators offer: its material and the paint the editor saves beside it,
   a MaterialCategory and an EBallestMaterialColors value (read from the game's assets) */
const SMOOTH = "MaterialCategory_Smooth";
const SPECIAL = "MaterialCategory_Special";
const ENV = "/Game/Art/Materials/Environment/Materials/";
const smooth = (name: string, index: number) =>
  ({ material: `${ENV}Instances_2/MI_Env_${name}_Smooth`, category: SMOOTH, index }) as const;
const special = (name: string, index: number) =>
  ({ material: `${ENV}Instances/MI_Env_${name}`, category: SPECIAL, index }) as const;
export const COLOURS = {
  White: smooth("White", 1),
  Dark: smooth("Dark", 2),
  Red: smooth("Red", 3),
  Orange: smooth("Orange", 4),
  Yellow: smooth("Yellow", 5),
  Lime: smooth("Lime", 6),
  Blue: smooth("Blue", 8),
  "Sky blue": smooth("SkyBlue", 9),
  Purple: smooth("Purple", 10),
  Wine: smooth("Wine", 11),
  Iron: special("Iron", 12),
  Copper: special("Copper", 13),
  Aluminum: special("Aluminum", 14),
} as const;
export type Colour = keyof typeof COLOURS;
export const COLOUR_NAMES = Object.keys(COLOURS) as Array<Colour>;
const isColour = (c: unknown): c is Colour => typeof c === "string" && c in COLOURS;

/* ---------- pieces ---------- */
const PIECES =
  "/Game/LevelEditor/PackageAssets/MultiplayerLevelEditor/ExampleObjects/BallestPieces";
const GLOSSY = "/Game/LevelEditor/PackageAssets/BallestAssets/MapPieces/GlossyRed";
const KINDS = {
  cube: {
    cls: `${PIECES}/BP_Prim_Cube.BP_Prim_Cube_C`,
    mesh: "/Game/Art/GreyBoxing/_GENERATED/PC/Box_C559BEB3.Box_C559BEB3",
    size: [1000, 1000, 1000],
  },
  /* the Shapes menu's sphere (its old BP_Prim_Sphere left the menus): pivot at its centre */
  sphere: {
    cls: `${GLOSSY}/BP_GlossyRed_WholeSphere.BP_GlossyRed_WholeSphere_C`,
    mesh: `${GLOSSY}/Meshes/SM_GlossyRed_WholeSphere.SM_GlossyRed_WholeSphere`,
    size: [1000, 1000, 1000],
    centred: true,
  },
  cylinder: {
    cls: `${PIECES}/BP_Prim_Cylinder.BP_Prim_Cylinder_C`,
    mesh: "/Game/Maps/_GENERATED/PC/SM_Start_Fixed.SM_Start_Fixed",
    size: [1000, 1000, 200],
  },
  pyramid: {
    cls: "/Game/LevelEditor/PackageAssets/BallestAssets/MapPieces/MP_Pyramid.MP_Pyramid_C",
    mesh: "/Game/LevelEditor/PackageAssets/BallestAssets/MapPieces/Meshes/SM_Pyramid.SM_Pyramid",
    size: [500, 500, 200],
  },
  cone: {
    cls: "/Game/LevelEditor/PackageAssets/BallestAssets/MapPieces/MP_Cone.MP_Cone_C",
    mesh: "/Game/LevelEditor/PackageAssets/BallestAssets/MapPieces/Meshes/SM_Cone.SM_Cone",
    size: [300, 300, 200],
  },
} as const;
export type Kind = keyof typeof KINDS;
export type V3 = [number, number, number];

const tail = (path: string) => path.split("/").at(-1) ?? path;
const full = (path: string) => `${path}.${tail(path)}`;

/* a piece `size` cm across its own axes, its bottom centre at `at`, turned by `rot` (or a yaw) */
export function piece(
  kind: Kind,
  at: V3,
  size: V3,
  colour: Colour,
  rot: V3 | number = 0,
): PrefabItem {
  const k = KINDS[kind];
  const rotation: V3 = typeof rot === "number" ? [0, rot, 0] : rot;
  /* a piece whose pivot is its centre goes half its height up its own z: `at` stays its bottom */
  const up = rotationRows(rotation)[2];
  const location = "centred" in k ? (at.map((v, i) => v + (up[i] * size[2]) / 2) as V3) : at;
  return placed(k.cls, k.mesh, 1, colour, location, rotation, [
    size[0] / k.size[0],
    size[1] / k.size[1],
    size[2] / k.size[2],
  ]);
}

/* a piece of class `cls` drawn with `mesh`, every one of its `slots` materials `colour`, as
   the editor saves it */
export function placed(
  cls: string,
  mesh: string,
  slots: number,
  colour: Colour,
  location: V3,
  rotation: V3,
  scale: V3,
): PrefabItem {
  const c = COLOURS[colour];
  const each = <T>(v: T) => Array<T>(slots).fill(v);
  /* the keys the editor saves; PrefabItem names only the ones the viewer reads */
  const item = {
    class: cls,
    transform: { location, rotation, scale },
    properties: {},
    meshes: [{ tag: "SKGMapEditor", mesh, materials: each(full(c.material)) }],
    paint: {
      categories: each(full(`/Game/Art/DataAssets/BallestMaterials/${c.category}`)),
      colors: each(c.index),
    },
  };
  return item;
}

/* a sign or code seen from in front (-X), a little from above and to the right, as it reads */
export const FRONT: PrefabAngle = { from: [-0.83, 0.35, 0.43], zoom: 1, pan: [0, 0, 0] };

export const fileOf = (items: Array<PrefabItem>): PrefabFile => ({
  format: "BallestPrefab",
  version: 1,
  group: { rotation: [0, 0, 0], scale: [1, 1, 1] },
  items,
});

/* the lowest corner of any of the pieces, in cm */
export const lowestOf = (items: Array<PrefabItem>) => edgeOf(items, 1, -1);

/* how far the pieces reach along three's axis `k` (0 x, 1 up, 2 Unreal's y), at their least
   (-1) or most (1), in cm */
const edgeOf = (items: Array<PrefabItem>, k: number, sign: -1 | 1) =>
  sign *
  Math.max(...shapesOf(fileOf(items)).map((sh) => sign * spanOf(sh, k)[sign < 0 ? 0 : 1])) *
  100;

/* where the pieces reach along Unreal's x, y and z, least and most, in cm */
export function reachOf(items: Array<PrefabItem>): [V3, V3] {
  const shapes = shapesOf(fileOf(items));
  /* three's axis for each of Unreal's: x is x, y is three's z, z is three's y (up) */
  const along = [0, 2, 1].map((k) => shapes.map((sh) => spanOf(sh, k)));
  return [
    along.map((spans) => Math.min(...spans.map((s) => s[0])) * 100) as V3,
    along.map((spans) => Math.max(...spans.map((s) => s[1])) * 100) as V3,
  ];
}

/* the pieces moved by `by` cm */
export const shifted = (items: Array<PrefabItem>, by: V3): Array<PrefabItem> =>
  items.map((it) => ({
    ...it,
    transform: { ...it.transform, location: add(it.transform.location, by) },
  }));

/* the pieces moved up or down so the lowest corner of any of them sits on the floor, z = 0 */
export const grounded = (items: Array<PrefabItem>) => shifted(items, [0, 0, -lowestOf(items)]);

/* a big Prefab as parts of at most SPAWN_MOST pieces, marker included, to spawn one after
   another without moving the camera. spawnprefab keeps a file's origin across and up but slides
   it along X so its nearest face sits a set way in front of the camera, so a part that doesn't
   reach as near or as low as the whole gets a small marker cube at the whole's near, low corner,
   and the parts land where they meet (checked in a sandbox game, 2026-10-23); `marked` says
   whether any part carries one */
export function spawnsOf(file: PrefabFile): { parts: Array<PrefabFile>; marked: boolean } {
  if (file.items.length <= SPAWN_MOST) return { parts: [file], marked: false };
  const near = (items: Array<PrefabItem>) => edgeOf(items, 0, -1);
  const [x, y, z] = [near(file.items), edgeOf(file.items, 2, -1), lowestOf(file.items)];
  const marker = piece("cube", [x + 10, y + 10, z], [20, 20, 20], "White");
  const parts: Array<PrefabFile> = [];
  let marked = false;
  /* one short of SPAWN_MOST, room for the marker */
  const most = SPAWN_MOST - 1;
  for (let i = 0; i < file.items.length; i += most) {
    const items = file.items.slice(i, i + most);
    /* and a part of one piece needs a second: the game spawns nothing from one */
    const reaches = items.length > 1 && near(items) <= x && lowestOf(items) <= z;
    marked ||= !reaches;
    parts.push({ ...file, items: reaches ? items : [...items, marker] });
  }
  return { parts, marked };
}

/* a sign or code laid out across x and standing out toward +y, turned to face -X */
export const facing = (items: Array<PrefabItem>) =>
  items.map((it) => {
    const [x, y, z] = it.transform.location;
    const [sx, sy, sz] = it.transform.scale;
    return {
      ...it,
      transform: { ...it.transform, location: [-y, x, z] as V3, scale: [sy, sx, sz] as V3 },
    };
  });

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const norm = (a: V3): V3 => mul(a, 1 / Math.hypot(...a));
export const DEG = Math.PI / 180;

/* the [pitch, yaw, roll] that turns a piece's up axis along d */
function aim(d: V3): V3 {
  const [x, y, z] = norm(d);
  return [-Math.acos(Math.max(-1, Math.min(1, z))) / DEG, Math.atan2(y, x) / DEG, 0];
}
/* a cylinder from a to b, w cm thick */
export const stick = (a: V3, b: V3, w: number, c: Colour) => {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  return piece("cylinder", a, [w, w, Math.hypot(...d)], c, aim(d));
};
/* a sphere s cm across centred at p, squashed in height */
export const ball = (p: V3, s: number, c: Colour, squash = 1) =>
  piece("sphere", [p[0], p[1], p[2] - (s * squash) / 2], [s, s, s * squash], c);

/* the grid's on cells as rectangles: runs along each row, stacked where rows agree */
export function rects(g: Grid): Array<{ x: number; y: number; w: number; h: number }> {
  const done = new Set<number>();
  const free = (x: number, y: number) => g.on(x, y) && !done.has(y * g.w + x);
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      if (!free(x, y)) continue;
      let w = 1;
      while (x + w < g.w && free(x + w, y)) w++;
      let h = 1;
      while (y + h < g.h && Array.from({ length: w }, (_, i) => free(x + i, y + h)).every(Boolean))
        h++;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) done.add((y + j) * g.w + x + i);
      out.push({ x, y, w, h });
    }
  return out;
}

/* the grid's on cells as boxes `cell` cm across, centred on x = 0 with row 0's top at `top`,
   `depth` thick from y = y0 */
export function cellsOf(g: Grid, cell: number, top: number, y0: number, depth: number, c: Colour) {
  return rects(g).map((r) =>
    piece(
      "cube",
      [(-g.w / 2 + r.x + r.w / 2) * cell, y0 + depth / 2, top - (r.y + r.h) * cell],
      [r.w * cell, depth, r.h * cell],
      c,
    ),
  );
}

/* a small seeded random, so the same seed gives the same shape */
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* a random point in the unit ball */
export function inBall(r: () => number): V3 {
  const a = r() * Math.PI * 2;
  const u = r() * 2 - 1;
  const d = Math.cbrt(r());
  const s = Math.sqrt(1 - u * u);
  return [Math.cos(a) * s * d, Math.sin(a) * s * d, u * d];
}

/* a direction `angle` radians off d, `around` radians about it */
export function turn(d: V3, angle: number, around: number): V3 {
  const [x, y, z] = norm(d);
  const ref: V3 = Math.abs(z) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = norm([y * ref[2] - z * ref[1], z * ref[0] - x * ref[2], x * ref[1] - y * ref[0]]);
  const w: V3 = [y * u[2] - z * u[1], z * u[0] - x * u[2], x * u[1] - y * u[0]];
  const s = Math.sin(angle);
  return norm(
    add(
      mul([x, y, z], Math.cos(angle)),
      add(mul(u, s * Math.cos(around)), mul(w, s * Math.sin(around))),
    ),
  );
}

/* ---------- controls ---------- */
export type Values = Record<string, string | number | boolean>;
interface Base {
  key: string;
  label: string;
  /* shown only under More options */
  more?: boolean;
}
export type Control = Base &
  (
    | { kind: "number"; min: number; max: number; step: number; unit?: string }
    | { kind: "colour" }
    | { kind: "choice"; options: ReadonlyArray<string> }
    | { kind: "toggle" }
    | { kind: "text"; lines?: number }
    | { kind: "font" }
    | { kind: "shuffle" }
    /* an image the page turns into a picture string (lib/generators/useful.ts) */
    | { kind: "picture" }
  );

export const num = (
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  unit?: string,
  more = false,
): Control => ({ key, label, kind: "number", min, max, step, unit, more });
export const colour = (key: string, label: string): Control => ({ key, label, kind: "colour" });
export const choice = (
  key: string,
  label: string,
  options: ReadonlyArray<string>,
  more = false,
): Control => ({ key, label, kind: "choice", options, more });
export const SHUFFLE: Control = { key: "seed", label: "Shuffle", kind: "shuffle" };

export const numberIn = (v: Values, k: string) => Number(v[k]);
/* a control in metres, in the centimetres pieces are placed in */
export const metresIn = (v: Values, k: string) => numberIn(v, k) * 100;
export const colourIn = (v: Values, k: string): Colour => (isColour(v[k]) ? v[k] : "White");

export interface Generator {
  key: string;
  name: string;
  blurb: string;
  category: (typeof CATEGORIES)[number];
  /* the stem of the file Download saves, and so of the spawn command */
  file: string;
  /* its pieces stand apart by design (letters, a row of lamps): the checks skip its parts */
  loose?: boolean;
  /* it letters text, so its page loads the drawn fonts and hands build a Lettering */
  lettered?: boolean;
  /* the view its model and card start from; without one, the Prefabs' default */
  angle?: PrefabAngle;
  defaults: Values;
  /* the controls to show for these values (a switch can hide another's) */
  controls: (v: Values) => Array<Control>;
  /* true when these values would letter text it won't (lib/rude-text.ts): generate returns null */
  refuses?: (v: Values) => boolean;
  build: (v: Values, lettering: Lettering) => PrefabFile | null;
}

/* a box `size` cm across centred at `at`, turned by `rot` */
export const boxAt = (at: V3, size: V3, c: Colour, rot: V3 = [0, 0, 0]) =>
  piece("cube", add(at, mul(rotationRows(rot)[2], -size[2] / 2)), size, c, rot);

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/* the [pitch, yaw, roll] that sends a piece's x axis along `forward` and its up axis as near
   `up` as it can go square to it (Unreal's FMatrix::Rotator, so rotationRows undoes it) */
export function rotOf(forward: V3, up: V3): V3 {
  const f = norm(forward);
  const u = norm(sub(up, mul(f, dot(up, f))));
  const pitch = Math.atan2(f[2], Math.hypot(f[0], f[1])) / DEG;
  const yaw = Math.atan2(f[1], f[0]) / DEG;
  const [, y0] = rotationRows([pitch, yaw, 0]);
  const y = cross(u, f);
  return [pitch, yaw, Math.atan2(dot(u, y0), dot(y, y0)) / DEG];
}

/* a slab `width` across and `thick` deep whose top runs from a to b, its top facing `up`;
   `over` cm longer at each end so a chain of them leaves no gaps */
export function slab(a: V3, b: V3, up: V3, width: number, thick: number, c: Colour, over = 0) {
  const d = sub(b, a);
  const rot = rotOf(d, up);
  const top = rotationRows(rot)[2];
  const mid = mul(add(a, b), 0.5);
  return piece(
    "cube",
    add(mid, mul(top, -thick)),
    [Math.hypot(...d) + 2 * over, width, thick],
    c,
    rot,
  );
}

/* a pyramid roof `side` cm square and `rise` tall: SM_Pyramid's corners sit at the middle of its
   bounds' edges, so it is turned 45° and grown by √2 to cover the square */
export const pyramid = (at: V3, side: number, rise: number, c: Colour) =>
  piece("pyramid", at, [side * Math.SQRT2, side * Math.SQRT2, rise], c, 45);

export const CATEGORIES = ["Useful", "Racing", "Decor", "Nature", "Buildings"] as const;

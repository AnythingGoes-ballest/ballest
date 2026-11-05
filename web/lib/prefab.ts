// A Prefab file (GLOSSARY.md) read into the shapes
// the viewer draws. A BallestPrefab file names each piece's mesh, material and transform
// but carries no geometry, so each mesh the editor's pieces use is a stand-in shape here,
// sized from the mesh's bounds (cm, pivot at the bottom centre). An unknown mesh is a grey box,
// and a piece the editor offers that a player never sees as a solid (a light, a decal) isn't
// drawn at all.
// The bounds are lib/prefab-meshes.ts; the game's meshes stay out of the repo (ADR 0001). A
// curved piece is drawn from its outline in one view pushed through its bounds, a prism
// (lib/prefab-profiles.ts).

import { MESHES, PIECE_MATERIALS, PIECE_MESHES } from "./prefab-meshes";
import { PIECES } from "./prefab-pieces";
import { PROFILES } from "./prefab-profiles";

const KNOWN_PIECES = new Set(PIECES);

export interface PrefabFile {
  format: "BallestPrefab";
  version: number;
  group: { rotation: Vec3; scale: Vec3 };
  items: Array<PrefabItem>;
}

type Vec3 = [number, number, number];

export interface PrefabItem {
  class: string;
  transform: { location: Vec3; rotation: Vec3; scale: Vec3 };
  meshes: Array<{ mesh: string; materials: Array<string> }>;
  paint?: { categories: Array<string>; colors: Array<number> };
}

export type ShapeKind =
  "box" | "cylinder" | "cone" | "pyramid" | "sphere" | "halfRing" | "quarterRing" | "torus";

export type ProfileView = "top" | "front" | "side";

/** a mesh's outline in one view: shapes, each an outline then its holes, as flat x, y lists in
    thousandths of the bounds along the view's right and up axes */
export interface MeshProfile {
  view: ProfileView;
  shapes: Array<Array<Array<number>>>;
  /** a second view's outline: where the prism reaches along the axis it is pushed through,
      [low, high] thousandths at evenly spaced places along the axis the two views share */
  squeeze?: { view: ProfileView; spans: Array<number> };
}

/** an outline's numbers are thousandths of the bounds */
export const PROFILE_SCALE = 1000;

/* Unreal axes [x, y, z] across and up each view, as the reference renders frame it */
const VIEW_AXES: Record<ProfileView, [number, number]> = {
  top: [0, 1],
  front: [1, 2],
  side: [0, 2],
};

const toThree = (unreal: number) => [0, 2, 1][unreal];

/** how far the prism reaches, 0 to 1 low and high, at `t` (0 to 1) along the shared axis */
function squeezeAt(spans: Array<number>, t: number): [number, number] {
  const n = spans.length / 2;
  const at = Math.min(Math.max(t * n - 0.5, 0), n - 1);
  const i = Math.min(Math.floor(at), n - 2);
  const f = n > 1 ? at - i : 0;
  const lerp = (k: number) =>
    (spans[2 * i + k] * (1 - f) + spans[2 * (i + 1) + k] * f) / PROFILE_SCALE;
  return n > 1 ? [lerp(0), lerp(1)] : [spans[0] / PROFILE_SCALE, spans[1] / PROFILE_SCALE];
}

/**
 * How an outline becomes its prism in the unit box (three's axes, -0.5..0.5): `axes` are three's
 * axes its across, up and pushed-through directions lie along, and `squeeze` moves a point of the
 * plain prism to where a second view's outline lets it reach (null without one).
 */
export function prismOf({ view, squeeze }: MeshProfile) {
  const [across, up] = VIEW_AXES[view];
  const axes: Vec3 = [toThree(across), toThree(up), toThree(3 - across - up)];
  const through = axes[2];
  const shared = squeeze && VIEW_AXES[view].find((a) => VIEW_AXES[squeeze.view].includes(a));
  if (!squeeze || shared === undefined) return { axes, squeeze: null };
  const along = toThree(shared);
  return {
    axes,
    squeeze: (p: Vec3): Vec3 => {
      const [lo, hi] = squeezeAt(squeeze.spans, p[along] + 0.5);
      const out: Vec3 = [...p];
      out[through] = lo + (p[through] + 0.5) * (hi - lo) - 0.5;
      return out;
    },
  };
}

export interface MeshShape {
  kind: ShapeKind;
  min: Vec3;
  max: Vec3;
}

/* a piece whose material names no colour word */
export const UNKNOWN_COLOUR = "#8a90a0";

/* the material's own colour word, as the editor's swatches show it */
const COLOURS: Array<[RegExp, string]> = [
  [/Lime/i, "#9be22d"],
  [/White/i, "#e8ecf2"],
  [/Dark/i, "#3a3f4b"],
  [/Concrete/i, "#9a9a96"],
  [/Red/i, "#d8433a"],
  /* before Blue: the first word that matches wins */
  [/SkyBlue/i, "#5fb2ee"],
  [/Blue/i, "#3f7fe0"],
  [/Yellow/i, "#f2cc3a"],
  [/Orange/i, "#ef8a2f"],
  [/Purple/i, "#9a5ae0"],
  [/Pink/i, "#e96aa8"],
  [/Green/i, "#3fae5a"],
  [/Black/i, "#202329"],
  [/Iron/i, "#2a2c31"],
  [/Aluminum/i, "#c9ccd2"],
  [/Copper/i, "#b0683a"],
  [/Wine/i, "#7a2a3a"],
];

/** the colour the viewer draws a material in */
export const colourOf = (material: string) =>
  COLOURS.find(([re]) => re.test(material))?.[1] ?? UNKNOWN_COLOUR;

export interface Shape {
  kind: ShapeKind;
  /** the stand-in's own size in metres, along three's x, y (up), z */
  size: Vec3;
  /** column-major 4x4, local unit shape (centred at the origin) to three world, metres */
  matrix: Array<number>;
  colour: string;
  /** the outline it is drawn from instead of the kind's shape, for a piece with one */
  profile?: MeshProfile;
  /** an Emissive material, which lights itself in the game */
  glow: boolean;
  piece: string;
  material: string;
}

const tail = (path: string) => path.split(/[./]/).at(-1) ?? path;

export function pieceName(item: PrefabItem) {
  return tail(item.class).replace(/_C$/, "");
}

/* Unreal's FRotator [pitch, yaw, roll] in degrees, as the three axes it sends local x, y, z to */
export function rotationRows([pitch, yaw, roll]: Vec3): [Vec3, Vec3, Vec3] {
  const r = Math.PI / 180;
  const [sp, cp] = [Math.sin(pitch * r), Math.cos(pitch * r)];
  const [sy, cy] = [Math.sin(yaw * r), Math.cos(yaw * r)];
  const [sr, cr] = [Math.sin(roll * r), Math.cos(roll * r)];
  return [
    [cp * cy, cp * sy, sp],
    [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp],
    [-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp],
  ];
}

/** the outline a mesh is drawn from, if it has one; a hand-made shape (a cylinder, a torus) is
    already round where an outline would be flat, so only a box gives way to one */
export function profileOf(mesh: string) {
  return MESHES[mesh]?.kind === "box" ? PROFILES[mesh] : undefined;
}

/** whether a piece is drawn: every one but a piece the editor offers with no mesh to draw it
    from, a light or a decal (its file names only the editor's marker, or a light's beam) */
export function isDrawn(piece: string) {
  return !KNOWN_PIECES.has(piece) || PIECE_MESHES[piece] !== undefined;
}

export function shapesOf(file: PrefabFile): Array<Shape> {
  return file.items
    .filter((item) => isDrawn(pieceName(item)))
    .map((item) => {
      const mesh = item.meshes.at(0);
      const piece = pieceName(item);
      const named = PIECE_MESHES[piece];
      const meshName = mesh && MESHES[tail(mesh.mesh)] ? tail(mesh.mesh) : named;
      const shape: MeshShape = (meshName ? MESHES[meshName] : undefined) ?? {
        kind: "box",
        min: [-50, -50, 0],
        max: [50, 50, 100],
      };
      const first = mesh?.materials.at(0);
      const material = first ? tail(first) : (PIECE_MATERIALS[piece] ?? "");
      const { location, rotation, scale } = item.transform;
      const rows = rotationRows(rotation);
      const centre = shape.min.map((lo, i) => (lo + shape.max[i]) / 2) as Vec3;
      const ext = shape.max.map((hi, i) => hi - shape.min[i]) as Vec3;
      /* Unreal local axis i -> world: rows[i] * scale[i] * ext[i] (unit shape spans -0.5..0.5) */
      const axis = (i: number) => rows[i].map((v) => v * scale[i] * ext[i]) as Vec3;
      const local = centre.map((c, i) => c * scale[i]) as Vec3;
      const origin = [0, 1, 2].map(
        (k) => location[k] + rows[0][k] * local[0] + rows[1][k] * local[1] + rows[2][k] * local[2],
      ) as Vec3;
      /* Unreal is left-handed, z up; three is right-handed, y up: swapping y and z is both.
       The unit shapes are built along three's axes, so Unreal's local z (up) is three's y. */
      const swap = (v: Vec3): Vec3 => [v[0] / 100, v[2] / 100, v[1] / 100];
      const [ax, ay, az] = [swap(axis(0)), swap(axis(2)), swap(axis(1))];
      const o = swap(origin);
      const profile = meshName ? profileOf(meshName) : undefined;
      return {
        kind: shape.kind,
        profile,
        size: [ext[0] / 100, ext[2] / 100, ext[1] / 100],
        matrix: [...ax, 0, ...ay, 0, ...az, 0, ...o, 1],
        colour: colourOf(material),
        glow: /Emissive/i.test(material),
        piece,
        material,
      };
    });
}

/* a piece's name as a person reads it: "BP_Pipe_Tube1" is Pipe Tube 1, a primitive just Cube,
   "MP_AirVent" Air Vent */
export function pieceLabel(piece: string) {
  return piece
    .replace(/^(BP_(Prim_)?|MP_(SM_)?)/, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/(\D)(\d+)$/, "$1 $2");
}

/* what the file is made of, most-used piece first */
export function partsOf(file: PrefabFile): Array<{ piece: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of file.items)
    counts.set(pieceName(item), (counts.get(pieceName(item)) ?? 0) + 1);
  return [...counts].map(([piece, count]) => ({ piece, count })).sort((a, b) => b.count - a.count);
}

/* where a shape reaches along three's axis k (0 x, 1 up, 2 z), in metres, over its corners */
export function spanOf({ matrix: m }: Shape, k: number): [number, number] {
  const half = (Math.abs(m[k]) + Math.abs(m[4 + k]) + Math.abs(m[8 + k])) / 2;
  return [m[12 + k] - half, m[12 + k] + half];
}

/* the prefab's size in metres: wide (x), deep (z) and tall (y), over every shape's corners */
export function footprintOf(shapes: Array<Shape>): { w: number; d: number; h: number } {
  /* a Prefab of lights alone draws nothing */
  if (!shapes.length) return { w: 0, d: 0, h: 0 };
  const size = (k: number) => {
    const spans = shapes.map((s) => spanOf(s, k));
    return Math.max(...spans.map((s) => s[1])) - Math.min(...spans.map((s) => s[0]));
  };
  return { w: size(0), d: size(2), h: size(1) };
}

/** the water's height in three's metres when some piece reaches through it, else null; `water`
    is its Unreal z in cm (lib/ballmap.ts MAP_WATER). The game's water is everywhere at one
    height, but the viewer draws it only where it meets the pieces, so a Map built high above it
    isn't drawn floating over a sea */
export function waterLevelOf(shapes: Array<Shape>, water: number | null): number | null {
  if (water === null) return null;
  const y = water / 100;
  return shapes.some((s) => {
    const [lo, hi] = spanOf(s, 1);
    return lo < y && y < hi;
  })
    ? y
    : null;
}

// The piece tables after a game update: which pieces the editor offers (lib/prefab-pieces.ts),
// the mesh each one is drawn from and each mesh's stand-in (lib/prefab-meshes.ts, lib/prefab-
// profiles.ts), merged from the catalogue into the tables as they are, and each table written
// out whole. Pure, so scripts/prefab-pieces.ts and the tests share it.
import type { MeshProfile, MeshShape } from "../../lib/prefab";
import type { Vec3 } from "./fit";

/* the piece catalogue read from the game's own packages (ballest-map-making/extract/pieces/) */
export interface Catalogue {
  pieces: Array<CataloguePiece>;
  meshes: Array<{
    meshPath: string;
    boundsOrigin: Vec3;
    boundsExtent: Vec3;
    geometryFile?: string;
  }>;
}

export interface CataloguePiece {
  inMenu: boolean;
  classPath: string;
  meshComponents: Array<{
    name: string;
    mesh: string | null;
    visible: boolean;
    tags?: Array<string>;
    overrideMaterials?: Array<string | null>;
  }>;
}

export interface Tables {
  pieces: ReadonlyArray<string>;
  pieceMeshes: Partial<Record<string, string>>;
  meshes: Partial<Record<string, MeshShape>>;
  profiles: Partial<Record<string, MeshProfile>>;
}

export interface Change {
  table: "pieces" | "pieceMeshes" | "meshes" | "profiles";
  key: string;
  was?: string;
  now?: string;
}

export const tail = (path: string) => path.split(/[./]/).at(-1) ?? path;

/* the editor's own selection marker (a light's or a decal's bulb), shown only while editing */
const EDITOR_MARKER = "MLESelectionHitbox";
/* a light card's beam or glow: a volumetric light, not a solid a player sees in a race */
const LIGHT_MATERIALS = "/Game/Art/Volumetrics/";

/* a component a player sees in a race as a solid */
const isSolid = (c: CataloguePiece["meshComponents"][number]) =>
  !!c.mesh &&
  c.visible &&
  !(c.tags ?? []).includes(EDITOR_MARKER) &&
  !(c.overrideMaterials ?? []).some((m) => m?.startsWith(LIGHT_MATERIALS));

/** the mesh a piece is drawn from: its Main component's when that is a solid one, else the first
    solid one, else none (a light or a decal: the viewer leaves it out of the picture) */
export function meshOf(piece: CataloguePiece) {
  const solid = piece.meshComponents.filter(isSolid);
  const pick = solid.find((c) => c.name === "Main") ?? solid.at(0);
  return pick?.mesh ? tail(pick.mesh) : null;
}

export const pieceOf = (piece: CataloguePiece) => tail(piece.classPath).replace(/_C$/, "");

/* the order every table keeps its keys in: by code point */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The tables with the catalogue's menu taken in: every menu piece added to the known pieces
 * (none is ever taken out, so an older Prefab still passes), each menu piece's mesh set to the
 * one the catalogue draws it from (or taken away when it has none), and each mesh that names
 * and the tables lack fitted by `fit`, its outline kept when it has one. A mesh or outline
 * already there is kept as it is.
 */
export function merge(
  tables: Tables,
  catalogue: Catalogue,
  fit: (mesh: string) => { shape: MeshShape; profile: MeshProfile | null },
): { tables: Tables; changes: Array<Change> } {
  const changes: Array<Change> = [];
  const pieces = new Set(tables.pieces);
  const pieceMeshes = { ...tables.pieceMeshes };
  const meshes = { ...tables.meshes };
  const profiles = { ...tables.profiles };
  for (const piece of catalogue.pieces.filter((p) => p.inMenu)) {
    const name = pieceOf(piece);
    if (!pieces.has(name)) {
      pieces.add(name);
      changes.push({ table: "pieces", key: name });
    }
    const mesh = meshOf(piece) ?? undefined;
    const was = pieceMeshes[name];
    if (mesh === was) continue;
    if (mesh) pieceMeshes[name] = mesh;
    else delete pieceMeshes[name];
    changes.push({ table: "pieceMeshes", key: name, was, now: mesh });
  }
  for (const mesh of new Set(Object.values(pieceMeshes))) {
    if (!mesh || meshes[mesh]) continue;
    const { shape, profile } = fit(mesh);
    meshes[mesh] = shape;
    changes.push({ table: "meshes", key: mesh, now: shape.kind });
    if (profile && !profiles[mesh]) {
      profiles[mesh] = profile;
      changes.push({ table: "profiles", key: mesh, now: profile.view });
    }
  }
  return {
    tables: { pieces: [...pieces].sort(byCodePoint), pieceMeshes, meshes, profiles },
    changes,
  };
}

/** a mesh's bounds as the tables keep them, in cm to two places, from the catalogue's */
export function boundsOf(origin: Vec3, extent: Vec3) {
  const round = (v: Array<number>) => v.map((n) => Math.round(n * 100) / 100 + 0) as Vec3;
  return {
    min: round(origin.map((o, i) => o - extent[i])),
    max: round(origin.map((o, i) => o + extent[i])),
  };
}

/** a value as a TypeScript literal, for Prettier to lay out */
export function literal(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (value && typeof value === "object")
    return `{ ${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${literal(v)}`)
      .join(", ")} }`;
  /* -0 as the tables write it (a bound rounded up to 0 from below), so it reads back the same */
  if (Object.is(value, -0)) return "-0";
  return JSON.stringify(value);
}

/**
 * `ts` with `export const <name>`'s whole body written anew from `value` (an object's keys or an
 * array's items sorted), keeping the declaration line and everything outside it: its header
 * comment, and the other tables. Throws when the body isn't laid out as a table, its closing
 * bracket on a line of its own; scripts/prefab-pieces.ts reads the written files back to check.
 */
export function writeTable(
  ts: string,
  name: string,
  value: Partial<Record<string, unknown>> | ReadonlyArray<string>,
) {
  const declared = ts.search(new RegExp(`^export const ${name}\\b`, "m"));
  if (declared < 0) throw new Error(`no export const ${name}`);
  const open = ts.indexOf("\n", declared) + 1;
  const opener = ts.slice(declared, open).trimEnd();
  const isArray = Array.isArray(value);
  if (!opener.endsWith(isArray ? "[" : "{"))
    throw new Error(`${name}: its declaration doesn't open ${isArray ? "an array" : "an object"}`);
  const close = ts.indexOf(isArray ? "\n];" : "\n};", open - 1);
  if (close < 0 || ts.slice(open, close).includes("\nexport "))
    throw new Error(
      `${name}: no closing ${isArray ? "];" : "};"} on a line of its own before the next table`,
    );
  const entries = isArray
    ? [...value].sort(byCodePoint).map((v) => `  ${JSON.stringify(v)},\n`)
    : Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => byCodePoint(a, b))
        .map(([k, v]) => `  ${literal({ [k]: v }).slice(2, -2)},\n`);
  return ts.slice(0, open) + entries.join("") + ts.slice(close + 1);
}

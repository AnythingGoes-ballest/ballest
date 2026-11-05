// tsx scripts/prefab-pieces.ts <pieces.json>: brings the piece tables up to the game's editor
// after an update. Every menu piece is added to lib/prefab-pieces.ts, which the upload check
// (lib/prefab-check.ts) takes; each menu piece's mesh in lib/prefab-meshes.ts is set to the one
// the game draws it from (its Main component's when that is a solid a player sees, else the
// first such component's, else none: a light or a decal, left out of the picture); and each mesh
// those name that the tables lack gets its bounds and the stand-in closest to its outlines
// (scripts/prefab-pieces/fit.ts), with its outline in lib/prefab-profiles.ts when it is drawn
// from one. Entries already there are kept, and no piece is ever taken out of the known ones.
//
// <pieces.json> is the piece catalogue that ballest-map-making/extract/pieces/ reads from the
// game's own packages (the editor's DT_MapItems table and its category data assets, with each
// piece's mesh components and each mesh's bounds, and its render geometry in
// geometry/<mesh>.json beside it). It stays local: only the numbers below come into the repo
// (ADR 0001). Each table is written out whole, sorted, under its header comment, and Prettier
// lays it out; the files are then read back to check they hold what was meant.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { format, resolveConfig } from "prettier";

import { MESHES, PIECE_MESHES } from "../lib/prefab-meshes";
import { PIECES } from "../lib/prefab-pieces";
import { PROFILES } from "../lib/prefab-profiles";
import type { MeshProfile, MeshShape } from "../lib/prefab";
import { standIn, type Geometry, type Vec3 } from "./prefab-pieces/fit";
import {
  boundsOf,
  type Catalogue,
  merge,
  tail,
  type Tables,
  writeTable,
} from "./prefab-pieces/tables";

const source = process.argv[2];
if (!source) {
  console.error("usage: tsx scripts/prefab-pieces.ts <pieces.json>");
  process.exit(2);
}
const catalogue = JSON.parse(readFileSync(source, "utf8")) as Catalogue;
const byMesh = new Map(catalogue.meshes.map((m) => [tail(m.meshPath), m]));

const fits = new Map<string, number>();
function fit(mesh: string): { shape: MeshShape; profile: MeshProfile | null } {
  const entry = byMesh.get(mesh);
  if (!entry) throw new Error(`${mesh}: not in the catalogue`);
  const bounds = boundsOf(entry.boundsOrigin, entry.boundsExtent);
  if (!entry.geometryFile) return { shape: { kind: "box", ...bounds }, profile: null };
  const geometry = JSON.parse(
    readFileSync(join(dirname(source), entry.geometryFile), "utf8"),
  ) as Geometry;
  /* fitted within the mesh's own bounds, not the rounded ones the table keeps */
  const exact = {
    min: entry.boundsOrigin.map((o, i) => o - entry.boundsExtent[i]) as Vec3,
    max: entry.boundsOrigin.map((o, i) => o + entry.boundsExtent[i]) as Vec3,
  };
  const found = standIn(geometry, exact);
  fits.set(mesh, found.fit);
  return { shape: { kind: found.kind, ...bounds }, profile: found.profile };
}

const before: Tables = {
  pieces: PIECES,
  pieceMeshes: PIECE_MESHES,
  meshes: MESHES,
  profiles: PROFILES,
};
const { tables, changes } = merge(before, catalogue, fit);

const file = (name: string) => fileURLToPath(new URL(`../lib/${name}`, import.meta.url));
const PIECES_FILE = file("prefab-pieces.ts");
const MESHES_FILE = file("prefab-meshes.ts");
const PROFILES_FILE = file("prefab-profiles.ts");

async function write(path: string, edit: (ts: string) => string) {
  const ts = edit(readFileSync(path, "utf8"));
  const options = { ...(await resolveConfig(path)), filepath: path };
  writeFileSync(path, await format(ts, options));
}
await write(PIECES_FILE, (ts) => writeTable(ts, "PIECES", tables.pieces));
await write(MESHES_FILE, (ts) =>
  writeTable(writeTable(ts, "MESHES", tables.meshes), "PIECE_MESHES", tables.pieceMeshes),
);
await write(PROFILES_FILE, (ts) => writeTable(ts, "PROFILES", tables.profiles));

/* read back, past the module cache, and compared with what was meant */
const fresh = async <T>(path: string) =>
  (await import(`${pathToFileURL(path).href}?written=${String(Date.now())}`)) as T;
const written = {
  pieces: (await fresh<{ PIECES: ReadonlyArray<string> }>(PIECES_FILE)).PIECES,
  ...(await fresh<{ MESHES: Tables["meshes"]; PIECE_MESHES: Tables["pieceMeshes"] }>(MESHES_FILE)),
  profiles: (await fresh<{ PROFILES: Tables["profiles"] }>(PROFILES_FILE)).PROFILES,
};
const unequal = [
  isDeepStrictEqual(written.pieces, tables.pieces) ? null : "PIECES",
  isDeepStrictEqual(written.PIECE_MESHES, tables.pieceMeshes) ? null : "PIECE_MESHES",
  isDeepStrictEqual(written.MESHES, tables.meshes) ? null : "MESHES",
  isDeepStrictEqual(written.profiles, tables.profiles) ? null : "PROFILES",
].filter(Boolean);
if (unequal.length) {
  console.error(`written but read back different: ${unequal.join(", ")}`);
  process.exit(1);
}

for (const change of changes) {
  const name = `${change.table} ${change.key}`;
  const was = change.was ? `${change.was} -> ` : "";
  const now = change.now ?? (change.table === "pieces" ? "added" : "none (not drawn)");
  const fitted =
    fits.has(change.key) && change.table === "meshes"
      ? ` (fit ${fits.get(change.key)?.toFixed(2) ?? ""})`
      : "";
  console.log(`${name}: ${was}${now}${fitted}`);
}
const count = (table: string) => changes.filter((c) => c.table === table).length;
console.log(
  [
    `${String(count("pieces"))} pieces added`,
    `${String(count("pieceMeshes"))} piece meshes set`,
    `${String(count("meshes"))} meshes`,
    `${String(count("profiles"))} outlines added`,
  ].join(", "),
);

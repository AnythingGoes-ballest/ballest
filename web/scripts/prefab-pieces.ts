// tsx scripts/prefab-pieces.ts <pieces.json>: adds every level-editor piece the game has that
// lib/prefab-meshes.ts lacks, so the upload check (lib/prefab-check.ts) takes it and the viewer
// draws it. Run it after a game update that adds pieces, then `pnpm format`.
//
// <pieces.json> is the piece catalogue read from the game's own packages (the editor's
// DT_MapItems table and its category data assets, with each piece's mesh components and each
// mesh's bounds and render geometry in geometry/<mesh>.json beside it), as the CUE4Parse
// extractor kept with the game files writes it. It stays local: only the numbers below come
// into the repo (ADR 0001).
//
// For each menu piece whose class PIECE_MESHES lacks, it adds the class and its mesh (the Main
// component's, else the first with one). For each such mesh, and any other menu piece's mesh
// MESHES lacks, it adds the bounds and the stand-in that best matches the mesh's top, front and
// side outlines: a box, cylinder, sphere or cone when one is as close as any, else a box drawn as
// its outline in one view (lib/prefab-profiles.ts), squeezed by a second's where that helps,
// traced from the mesh's own triangles. Entries already there are kept as they are.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { MeshProfile, ProfileView, ShapeKind } from "../lib/prefab";

type Vec3 = [number, number, number];

interface Catalogue {
  pieces: Array<{
    inMenu: boolean;
    classPath: string;
    meshComponents: Array<{ name: string; mesh: string | null; visible: boolean }>;
  }>;
  meshes: Array<{
    meshPath: string;
    boundsOrigin: Vec3;
    boundsExtent: Vec3;
    geometryFile?: string;
  }>;
}

interface Geometry {
  positions: Array<Vec3>;
  indices: Array<number>;
}

const source = process.argv[2];
if (!source) {
  console.error("usage: tsx scripts/prefab-pieces.ts <pieces.json>");
  process.exit(1);
}
const catalogue = JSON.parse(readFileSync(source, "utf8")) as Catalogue;

const MESHES_FILE = new URL("../lib/prefab-meshes.ts", import.meta.url);
const PROFILES_FILE = new URL("../lib/prefab-profiles.ts", import.meta.url);
let meshesTs = readFileSync(MESHES_FILE, "utf8");
let profilesTs = readFileSync(PROFILES_FILE, "utf8");

const tail = (path: string) => path.split(/[./]/).at(-1) ?? path;

/* the top-level keys of `export const <name> = { ... };` */
function keysOf(ts: string, name: string) {
  const start = ts.indexOf(`export const ${name}`);
  const end = ts.indexOf("\n};", start);
  return new Set([...ts.slice(start, end).matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]));
}

/* `ts` with each entry put into `export const <name>` in the order its keys are kept (by code
   point), as `  key: value,` lines for Prettier to lay out */
function insert(ts: string, name: string, entries: Map<string, string>) {
  const start = ts.indexOf(`export const ${name}`);
  let end = ts.indexOf("\n};", start);
  for (const [key, value] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const body = ts.slice(start, end);
    const next = [...body.matchAll(/^ {2}(\w+): /gm)].find((m) => m[1] > key);
    const at = next?.index === undefined ? end + 1 : start + next.index;
    const line = `  ${key}: ${value},\n`;
    ts = ts.slice(0, at) + line + ts.slice(at);
    end += line.length;
  }
  return ts;
}

const pieceMeshes = keysOf(meshesTs, "PIECE_MESHES");
const meshes = keysOf(meshesTs, "MESHES");
const profiles = keysOf(profilesTs, "PROFILES");
const byMesh = new Map(catalogue.meshes.map((m) => [tail(m.meshPath), m]));

/* the mesh a piece's file names: its Main component's, else the first component's with one */
function meshOf(piece: Catalogue["pieces"][number]) {
  const withMesh = piece.meshComponents.filter((c) => c.mesh);
  const main = withMesh.find((c) => c.name === "Main");
  const pick = main ?? withMesh.find((c) => c.visible) ?? withMesh.at(0);
  return pick?.mesh ? tail(pick.mesh) : null;
}

const newPieces = new Map<string, string>();
const wanted = new Set<string>();
for (const piece of catalogue.pieces.filter((p) => p.inMenu)) {
  const name = tail(piece.classPath).replace(/_C$/, "");
  const mesh = meshOf(piece);
  if (!mesh) {
    console.warn(`${name}: no mesh, left out`);
    continue;
  }
  if (!pieceMeshes.has(name)) newPieces.set(name, mesh);
  if (!meshes.has(mesh)) wanted.add(mesh);
}

/* ---- outlines ---------------------------------------------------------------------------- */

/* Unreal axes [across, up] of each view, and the one it looks along */
const VIEWS: Record<ProfileView, [number, number, number]> = {
  top: [0, 1, 2],
  front: [1, 2, 0],
  side: [0, 2, 1],
};
const VIEW_NAMES = Object.keys(VIEWS) as Array<ProfileView>;

/* a res x res grid, [across * res + up], of the cells the mesh covers in `view` (its points in
   0..1 of the bounds) */
function silhouette(points: Array<Vec3>, indices: Array<number>, view: ProfileView, res: number) {
  const [a, b] = VIEWS[view];
  const grid = new Uint8Array(res * res);
  const mark = (x: number, y: number) => {
    const i = Math.min(res - 1, Math.max(0, Math.floor(x * res)));
    const j = Math.min(res - 1, Math.max(0, Math.floor(y * res)));
    grid[i * res + j] = 1;
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [p, q, r] = [0, 1, 2].map((k) => points[indices[t + k]]);
    const [px, py, qx, qy, rx, ry] = [p[a], p[b], q[a], q[b], r[a], r[b]];
    /* its edges, so a triangle seen edge-on still counts */
    for (const [x0, y0, x1, y1] of [
      [px, py, qx, qy],
      [qx, qy, rx, ry],
      [rx, ry, px, py],
    ]) {
      const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * res * 2) + 1;
      for (let s = 0; s <= steps; s++)
        mark(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
    }
    const area = (qx - px) * (ry - py) - (qy - py) * (rx - px);
    if (Math.abs(area) < 1e-12) continue;
    const [i0, i1] = [Math.min(px, qx, rx), Math.max(px, qx, rx)].map((v) => Math.floor(v * res));
    const [j0, j1] = [Math.min(py, qy, ry), Math.max(py, qy, ry)].map((v) => Math.floor(v * res));
    for (let i = Math.max(0, i0); i <= Math.min(res - 1, i1); i++)
      for (let j = Math.max(0, j0); j <= Math.min(res - 1, j1); j++) {
        const [x, y] = [(i + 0.5) / res, (j + 0.5) / res];
        const u = ((qx - x) * (ry - y) - (qy - y) * (rx - x)) / area;
        const v = ((rx - x) * (py - y) - (ry - y) * (px - x)) / area;
        if (u >= 0 && v >= 0 && u + v <= 1) grid[i * res + j] = 1;
      }
  }
  return grid;
}

/* a closed outline's area, positive counter-clockwise */
const areaOf = (loop: Array<[number, number]>) =>
  loop.reduce((s, [x, y], i) => {
    const [nx, ny] = loop[(i + 1) % loop.length];
    return s + x * ny - nx * y;
  }, 0) / 2;

/* the outlines round a grid's cells, inside on the left: outer ones counter-clockwise, holes
   clockwise, in cell units */
function loopsOf(grid: Uint8Array, res: number) {
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < res && j < res && grid[i * res + j];
  const edges = new Map<string, Array<[number, number]>>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = `${String(x0)},${String(y0)}`;
    const list = edges.get(k) ?? [];
    list.push([x1, y1]);
    edges.set(k, list);
  };
  for (let i = 0; i < res; i++)
    for (let j = 0; j < res; j++) {
      if (!on(i, j)) continue;
      if (!on(i, j - 1)) add(i, j, i + 1, j);
      if (!on(i + 1, j)) add(i + 1, j, i + 1, j + 1);
      if (!on(i, j + 1)) add(i + 1, j + 1, i, j + 1);
      if (!on(i - 1, j)) add(i, j + 1, i, j);
    }
  const loops: Array<Array<[number, number]>> = [];
  for (const [startKey, outs] of edges) {
    while (outs.length) {
      const [sx, sy] = startKey.split(",").map(Number);
      const loop: Array<[number, number]> = [[sx, sy]];
      let [px, py] = [sx, sy];
      let next = outs.pop();
      while (next) {
        const [nx, ny] = next;
        if (nx === sx && ny === sy) break;
        loop.push([nx, ny]);
        const choices = edges.get(`${String(nx)},${String(ny)}`) ?? [];
        /* where two corners touch, turn left: each cell's outline stays its own */
        const [dx, dy] = [nx - px, ny - py];
        choices.sort(
          ([ax, ay], [bx, by]) =>
            dx * (by - ny) - dy * (bx - nx) - (dx * (ay - ny) - dy * (ax - nx)),
        );
        next = choices.shift();
        [px, py] = [nx, ny];
      }
      loops.push(loop);
    }
  }
  return loops;
}

/* fewer points, none further than `tolerance` from the outline (Douglas-Peucker, closed) */
function simplify(loop: Array<[number, number]>, tolerance: number) {
  const dp = (pts: Array<[number, number]>): Array<[number, number]> => {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len = Math.hypot(dx, dy) || 1;
    let [far, at] = [0, 0];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / len;
      if (d > far) [far, at] = [d, i];
    }
    if (far <= tolerance) return [a, b];
    return [...dp(pts.slice(0, at + 1)).slice(0, -1), ...dp(pts.slice(at))];
  };
  let split = 0;
  let best = 0;
  loop.forEach(([x, y], i) => {
    const d = Math.hypot(x - loop[0][0], y - loop[0][1]);
    if (d > best) [best, split] = [d, i];
  });
  const first = dp(loop.slice(0, split + 1));
  const second = dp([...loop.slice(split), loop[0]]);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

const inside = ([x, y]: [number, number], loop: Array<[number, number]>) => {
  let c = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

const OUTLINE_RES = 200;

/* a view's outline as MeshProfile shapes, in thousandths */
function shapesOf(grid: Uint8Array): MeshProfile["shapes"] {
  const res = OUTLINE_RES;
  const min = res * res * 0.002;
  const loops = loopsOf(grid, res).filter((l) => Math.abs(areaOf(l)) >= min);
  const outer = loops.filter((l) => areaOf(l) > 0);
  const holes = loops.filter((l) => areaOf(l) < 0);
  const flat = (l: Array<[number, number]>) =>
    simplify(l, 1.2).flatMap(([x, y]) => [
      Math.round((x * 1000) / res),
      Math.round((y * 1000) / res),
    ]);
  return outer
    .sort((a, b) => areaOf(b) - areaOf(a))
    .map((o) => [flat(o), ...holes.filter((h) => inside(h[0], o)).map(flat)]);
}

const SQUEEZE_STEPS = 24;

/* where `second`'s outline lets a prism from `view` reach through, at evenly spaced places along
   the axis the two share (lib/prefab.ts squeezeAt) */
function spansOf(view: ProfileView, second: ProfileView, grid: Uint8Array, res: number) {
  const [a, b] = VIEWS[view];
  const [sa, sb] = VIEWS[second];
  const shared = [a, b].find((x) => x === sa || x === sb);
  if (shared === undefined) return null;
  const sharedIsAcross = sa === shared;
  const spans: Array<number> = [];
  for (let k = 0; k < SQUEEZE_STEPS; k++) {
    const s = Math.min(res - 1, Math.floor(((k + 0.5) / SQUEEZE_STEPS) * res));
    let [lo, hi] = [res, -1];
    for (let t = 0; t < res; t++) {
      const cell = sharedIsAcross ? grid[s * res + t] : grid[t * res + s];
      if (cell) [lo, hi] = [Math.min(lo, t), Math.max(hi, t)];
    }
    if (hi < 0) [lo, hi] = [0, res - 1];
    spans.push(Math.round((lo * 1000) / res), Math.round(((hi + 1) * 1000) / res));
  }
  return spans;
}

/* ---- choosing a stand-in ----------------------------------------------------------------- */

const SCORE_RES = 64;

type Solid = (x: number, y: number, z: number) => boolean;

/* how well a solid in the unit box matches the mesh's three outlines, 0 to 1 */
function score(solid: Solid, outlines: Record<ProfileView, Uint8Array>) {
  const res = SCORE_RES;
  const seen = VIEW_NAMES.map(() => new Uint8Array(res * res));
  for (let x = 0; x < res; x++)
    for (let y = 0; y < res; y++)
      for (let z = 0; z < res; z++) {
        if (!solid((x + 0.5) / res, (y + 0.5) / res, (z + 0.5) / res)) continue;
        const c = [x, y, z];
        VIEW_NAMES.forEach((v, n) => {
          const [a, b] = VIEWS[v];
          seen[n][c[a] * res + c[b]] = 1;
        });
      }
  return (
    VIEW_NAMES.reduce((sum, v, n) => {
      let [both, either] = [0, 0];
      for (let i = 0; i < res * res; i++) {
        both += seen[n][i] & outlines[v][i];
        either += seen[n][i] | outlines[v][i];
      }
      return sum + (either ? both / either : 1);
    }, 0) / VIEW_NAMES.length
  );
}

const PRIMITIVES: Array<[ShapeKind, Solid]> = [
  ["box", () => true],
  ["cylinder", (x, y) => (x - 0.5) ** 2 + (y - 0.5) ** 2 <= 0.25],
  ["sphere", (x, y, z) => (x - 0.5) ** 2 + (y - 0.5) ** 2 + (z - 0.5) ** 2 <= 0.25],
  ["cone", (x, y, z) => Math.hypot(x - 0.5, y - 0.5) <= 0.5 * (1 - z)],
];

/* a prism of `view`'s outline (a grid at `res`), squeezed by `spans` along the shared axis */
function prism(
  view: ProfileView,
  grid: Uint8Array,
  res: number,
  squeeze: ProfileView | null,
  spans: Array<number> | null,
): Solid {
  const [a, b, through] = VIEWS[view];
  const shared = squeeze ? [a, b].find((x) => VIEWS[squeeze].includes(x)) : undefined;
  return (...p) => {
    const i = Math.min(res - 1, Math.floor(p[a] * res));
    const j = Math.min(res - 1, Math.floor(p[b] * res));
    if (!grid[i * res + j]) return false;
    if (!spans || shared === undefined) return true;
    const n = spans.length / 2;
    const k = Math.min(n - 1, Math.floor(p[shared] * n));
    return p[through] >= spans[2 * k] / 1000 && p[through] <= spans[2 * k + 1] / 1000;
  };
}

function standIn(name: string) {
  const entry = byMesh.get(name);
  if (!entry) throw new Error(`${name}: not in the catalogue`);
  const min = entry.boundsOrigin.map((o, i) => o - entry.boundsExtent[i]) as Vec3;
  const max = entry.boundsOrigin.map((o, i) => o + entry.boundsExtent[i]) as Vec3;
  const round = (v: Vec3) => v.map((n) => Math.round(n * 100) / 100 + 0);
  const bounds = `min: [${round(min).join(", ")}], max: [${round(max).join(", ")}]`;
  if (!entry.geometryFile) return { kind: "box" as ShapeKind, bounds, profile: null, fit: 0 };
  const geometry = JSON.parse(
    readFileSync(join(dirname(source), entry.geometryFile), "utf8"),
  ) as Geometry;
  const span = max.map((m, i) => m - min[i] || 1);
  const points = geometry.positions.map((p) => p.map((v, i) => (v - min[i]) / span[i]) as Vec3);
  const at = (res: number) =>
    Object.fromEntries(
      VIEW_NAMES.map((v) => [v, silhouette(points, geometry.indices, v, res)]),
    ) as Record<ProfileView, Uint8Array>;
  const coarse = at(SCORE_RES);
  const fine = at(OUTLINE_RES);
  const primitives = PRIMITIVES.map(([kind, solid]) => ({ kind, fit: score(solid, coarse) }));
  const profiled = VIEW_NAMES.flatMap((view) =>
    [null, ...VIEW_NAMES.filter((v) => v !== view)].map((second) => {
      const spans = second ? spansOf(view, second, fine[second], OUTLINE_RES) : null;
      const coarseSpans = second ? spansOf(view, second, coarse[second], SCORE_RES) : null;
      const fit = score(prism(view, coarse[view], SCORE_RES, second, coarseSpans), coarse);
      return { view, second, spans, fit };
    }),
  );
  const best = Math.max(...primitives.map((p) => p.fit), ...profiled.map((p) => p.fit));
  const primitive = primitives.find((p) => p.fit >= best - 0.03);
  if (primitive) return { kind: primitive.kind, bounds, profile: null, fit: primitive.fit };
  /* a squeeze only where it is clearly closer */
  const plain = profiled.filter((p) => !p.second).sort((x, y) => y.fit - x.fit)[0];
  const squeezed = profiled.filter((p) => p.second).sort((x, y) => y.fit - x.fit)[0];
  const pick = squeezed.fit > plain.fit + 0.02 ? squeezed : plain;
  const profile: MeshProfile = { view: pick.view, shapes: shapesOf(fine[pick.view]) };
  if (pick.second && pick.spans) profile.squeeze = { view: pick.second, spans: pick.spans };
  return { kind: "box" as ShapeKind, bounds, profile, fit: pick.fit };
}

/* ---- writing ----------------------------------------------------------------------------- */

const newMeshes = new Map<string, string>();
const newProfiles = new Map<string, string>();
for (const name of [...wanted].sort()) {
  const s = standIn(name);
  newMeshes.set(name, `{ kind: "${s.kind}", ${s.bounds} }`);
  if (s.profile && !profiles.has(name)) newProfiles.set(name, JSON.stringify(s.profile));
  console.log(
    `${name}: ${s.kind}${s.profile ? ` drawn from its ${s.profile.view} outline${s.profile.squeeze ? ` squeezed by its ${s.profile.squeeze.view}` : ""}` : ""} (fit ${s.fit.toFixed(2)})`,
  );
}
for (const [piece, mesh] of newPieces) console.log(`${piece}: ${mesh}`);

meshesTs = insert(meshesTs, "MESHES", newMeshes);
meshesTs = insert(
  meshesTs,
  "PIECE_MESHES",
  new Map([...newPieces].map(([piece, mesh]) => [piece, JSON.stringify(mesh)])),
);
profilesTs = insert(profilesTs, "PROFILES", newProfiles);
writeFileSync(MESHES_FILE, meshesTs);
writeFileSync(PROFILES_FILE, profilesTs);
console.log(
  `${String(newPieces.size)} pieces, ${String(newMeshes.size)} meshes and ${String(newProfiles.size)} outlines added; now run pnpm format`,
);

// The stand-in a mesh is drawn as (lib/prefab.ts), chosen from its own triangles: the box,
// cylinder, sphere or cone closest to its top, front and side outlines when one is as close as
// any, else a box drawn as its outline in one view (lib/prefab-profiles.ts), squeezed by a
// second's where that helps. Pure, so scripts/prefab-pieces.ts and the tests share it.
import type { MeshProfile, ProfileView, ShapeKind } from "../../lib/prefab";

export type Vec3 = [number, number, number];

/* a mesh's render geometry, as the catalogue's geometry/<mesh>.json holds it, in cm */
export interface Geometry {
  positions: Array<Vec3>;
  indices: Array<number>;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface StandIn {
  kind: ShapeKind;
  /* the outline a box is drawn from, null for a primitive */
  profile: MeshProfile | null;
  /* how close it comes to the mesh's three outlines, 0 to 1 */
  fit: number;
}

type Point = [number, number];

/* ---- outlines ---------------------------------------------------------------------------- */

/* Unreal axes [across, up] of each view, and the one it looks along */
const VIEWS: Record<ProfileView, Vec3> = {
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
      for (let step = 0; step <= steps; step++)
        mark(x0 + ((x1 - x0) * step) / steps, y0 + ((y1 - y0) * step) / steps);
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
const areaOf = (loop: Array<Point>) =>
  loop.reduce((sum, [x, y], i) => {
    const [nx, ny] = loop[(i + 1) % loop.length];
    return sum + x * ny - nx * y;
  }, 0) / 2;

/* the outlines round a grid's cells, inside on the left: outer ones counter-clockwise, holes
   clockwise, in cell units */
function loopsOf(grid: Uint8Array, res: number) {
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < res && j < res && grid[i * res + j];
  const edges = new Map<string, Array<Point>>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const key = `${String(x0)},${String(y0)}`;
    const list = edges.get(key) ?? [];
    list.push([x1, y1]);
    edges.set(key, list);
  };
  for (let i = 0; i < res; i++)
    for (let j = 0; j < res; j++) {
      if (!on(i, j)) continue;
      if (!on(i, j - 1)) add(i, j, i + 1, j);
      if (!on(i + 1, j)) add(i + 1, j, i + 1, j + 1);
      if (!on(i, j + 1)) add(i + 1, j + 1, i, j + 1);
      if (!on(i - 1, j)) add(i, j + 1, i, j);
    }
  const loops: Array<Array<Point>> = [];
  for (const [startKey, outs] of edges) {
    while (outs.length) {
      const [sx, sy] = startKey.split(",").map(Number);
      const loop: Array<Point> = [[sx, sy]];
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

/* an open line's points kept to within `tolerance` of it (Douglas-Peucker) */
function douglasPeucker(points: Array<Point>, tolerance: number): Array<Point> {
  const [first, last] = [points[0], points[points.length - 1]];
  const [dx, dy] = [last[0] - first[0], last[1] - first[1]];
  const length = Math.hypot(dx, dy) || 1;
  let [farthest, farthestAt] = [0, 0];
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs((points[i][0] - first[0]) * dy - (points[i][1] - first[1]) * dx) / length;
    if (d > farthest) [farthest, farthestAt] = [d, i];
  }
  if (farthest <= tolerance) return [first, last];
  return [
    ...douglasPeucker(points.slice(0, farthestAt + 1), tolerance).slice(0, -1),
    ...douglasPeucker(points.slice(farthestAt), tolerance),
  ];
}

/* fewer points, none further than `tolerance` from the outline: a closed loop cut in two at the
   point farthest from its first, each half simplified */
function simplify(loop: Array<Point>, tolerance: number) {
  let split = 0;
  let farthest = 0;
  loop.forEach(([x, y], i) => {
    const d = Math.hypot(x - loop[0][0], y - loop[0][1]);
    if (d > farthest) [farthest, split] = [d, i];
  });
  const first = douglasPeucker(loop.slice(0, split + 1), tolerance);
  const second = douglasPeucker([...loop.slice(split), loop[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/* whether a point is inside a closed outline (even-odd) */
function isInside([x, y]: Point, loop: Array<Point>) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const OUTLINE_RES = 200;

/* a view's outline as MeshProfile shapes, in thousandths */
function shapesOf(grid: Uint8Array): MeshProfile["shapes"] {
  const res = OUTLINE_RES;
  const smallest = res * res * 0.002;
  const loops = loopsOf(grid, res).filter((l) => Math.abs(areaOf(l)) >= smallest);
  const outer = loops.filter((l) => areaOf(l) > 0);
  const holes = loops.filter((l) => areaOf(l) < 0);
  const flat = (l: Array<Point>) =>
    simplify(l, 1.2).flatMap(([x, y]) => [
      Math.round((x * 1000) / res),
      Math.round((y * 1000) / res),
    ]);
  return outer
    .sort((a, b) => areaOf(b) - areaOf(a))
    .map((o) => [flat(o), ...holes.filter((h) => isInside(h[0], o)).map(flat)]);
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
    const row = Math.min(res - 1, Math.floor(((k + 0.5) / SQUEEZE_STEPS) * res));
    let [lo, hi] = [res, -1];
    for (let t = 0; t < res; t++) {
      const cell = sharedIsAcross ? grid[row * res + t] : grid[t * res + row];
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
        const cell = [x, y, z];
        VIEW_NAMES.forEach((v, n) => {
          const [a, b] = VIEWS[v];
          seen[n][cell[a] * res + cell[b]] = 1;
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

/** the stand-in closest to a mesh's three outlines, its geometry read within `bounds` */
export function standIn(geometry: Geometry, bounds: Bounds): StandIn {
  const { min, max } = bounds;
  const span = max.map((m, i) => m - min[i] || 1);
  const points = geometry.positions.map((p) => p.map((v, i) => (v - min[i]) / span[i]) as Vec3);
  const outlinesAt = (res: number) =>
    Object.fromEntries(
      VIEW_NAMES.map((v) => [v, silhouette(points, geometry.indices, v, res)]),
    ) as Record<ProfileView, Uint8Array>;
  const coarse = outlinesAt(SCORE_RES);
  const fine = outlinesAt(OUTLINE_RES);
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
  if (primitive) return { kind: primitive.kind, profile: null, fit: primitive.fit };
  /* a squeeze only where it is clearly closer */
  const plain = profiled.filter((p) => !p.second).sort((x, y) => y.fit - x.fit)[0];
  const squeezed = profiled.filter((p) => p.second).sort((x, y) => y.fit - x.fit)[0];
  const pick = squeezed.fit > plain.fit + 0.02 ? squeezed : plain;
  const profile: MeshProfile = { view: pick.view, shapes: shapesOf(fine[pick.view]) };
  if (pick.second && pick.spans) profile.squeeze = { view: pick.second, spans: pick.spans };
  return { kind: "box", profile, fit: pick.fit };
}

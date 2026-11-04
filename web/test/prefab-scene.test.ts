// The Prefab viewer's three.js scene (components/prefabs/scene.ts), built without a renderer.
import { describe, expect, test } from "vitest";

import { buildScene, loadThree } from "../components/prefabs/scene";
import type { PrefabFile } from "../lib/prefab";

const CUBE = "/Game/Blueprints/Editor/BP_Prim_Cube.BP_Prim_Cube_C";
const BOX = "/Game/Art/GreyBoxing/_GENERATED/PC/Box_C559BEB3.Box_C559BEB3";
const LIME = "/Game/M/MI_Env_Lime.MI_Env_Lime";
const RED = "/Game/M/MI_Env_Red.MI_Env_Red";

/* a file of unturned scale-1 cubes, each [location cm, material]; such a cube is 10 across */
function cubes(...items: Array<[Array<number>, string]>): PrefabFile {
  return {
    format: "BallestPrefab",
    version: 1,
    group: { rotation: [0, 0, 0], scale: [1, 1, 1] },
    items: items.map(([location, material]) => ({
      class: CUBE,
      transform: { location, rotation: [0, 0, 0], scale: [1, 1, 1] },
      meshes: [{ mesh: BOX, materials: [material] }],
    })) as PrefabFile["items"],
  };
}

const SPHERE = "/Game/Blueprints/Editor/BP_Prim_Sphere.BP_Prim_Sphere_C";
const SPHERE_MESH = "/Game/Maps/_GENERATED/PC/SM_Sphere.SM_Sphere";
const TORUS = "/Game/Blueprints/Editor/MP_RoundedTorus.MP_RoundedTorus_C";
const TORUS_MESH = "/Game/Maps/_GENERATED/PC/Torus.Torus";

/* n of one piece in a row, 50 m apart */
function row(n: number, piece: string, mesh: string): PrefabFile {
  return {
    ...cubes(),
    items: Array.from({ length: n }, (_, i) => ({
      class: piece,
      transform: { location: [i * 5000, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      meshes: [{ mesh, materials: [LIME] }],
    })),
  };
}

const three = await loadThree();

/* the triangles the scene draws, every instance counted */
const trianglesOf = (scene: import("three").Scene) => {
  let n = 0;
  scene.traverse((o) => {
    if (!(o instanceof three.THREE.InstancedMesh)) return;
    const g = o.geometry as import("three").BufferGeometry;
    n += ((g.index?.count ?? g.getAttribute("position").count) / 3) * o.count;
  });
  return n;
};

/* the scene's draws, as how many pieces each one draws, fewest first */
const drawsOf = (scene: import("three").Scene) => {
  const out: Array<number> = [];
  scene.traverse((o) => {
    if (o instanceof three.THREE.InstancedMesh) out.push(o.count);
    else if (o instanceof three.THREE.Mesh) out.push(1);
  });
  return out.sort((a, b) => a - b);
};

describe("a Prefab's scene", () => {
  test("pieces of one geometry and colour draw as one instanced mesh", () => {
    const row = Array.from({ length: 2000 }, (_, i): [Array<number>, string] => [
      [i * 1000, 0, 0],
      LIME,
    ]);
    const { scene } = buildScene(three, cubes(...row, [[0, 1000, 0], RED]), false);
    expect(drawsOf(scene)).toEqual([1, 2000]);
  });

  test("the framing still fits every piece", () => {
    /* two cubes 90 apart: 100 long, 10 high and deep */
    const { centre, radius } = buildScene(
      three,
      cubes([[0, 0, 0], LIME], [[9000, 0, 0], LIME]),
      false,
    );
    expect(centre.x).toBeCloseTo(45);
    expect(radius).toBeCloseTo(Math.sqrt(100 ** 2 + 10 ** 2 + 10 ** 2) / 2);
  });

  test("the ground grid is no more than 40 squares across, however big the file", () => {
    const { scene } = buildScene(three, cubes([[0, 0, 0], LIME], [[500000, 0, 0], LIME]));
    const grid = scene.children.find((o) => o instanceof three.THREE.GridHelper);
    if (!(grid instanceof three.THREE.GridHelper)) throw new Error("no grid");
    /* each line is two points, and the lines run both ways; 41 of them bound 40 squares */
    const lines = grid.geometry.getAttribute("position").count / 2 / 2;
    expect(lines).toBeLessThanOrEqual(41);
  });
});

describe("round pieces' detail", () => {
  /* the GIF of a Daily's Map is drawn in software (daily-spin.yml), at about a millisecond for
     every thousand triangles on a laptop and four times that on Actions: SPOOKY Rooms' 450
     spheres drew 547k a frame and timed out (2026-11-04), a Map of 2,727 spheres 3.3M */
  test("a few spheres or toruses keep their full detail", () => {
    const one = trianglesOf(buildScene(three, row(1, SPHERE, SPHERE_MESH), false).scene);
    const ten = trianglesOf(buildScene(three, row(10, SPHERE, SPHERE_MESH), false).scene);
    expect(ten).toBe(10 * one);
    expect(one).toBeGreaterThan(1000);
    const torus = trianglesOf(buildScene(three, row(1, TORUS, TORUS_MESH), false).scene);
    expect(torus).toBeGreaterThan(1000);
  });

  test.each([
    [450, "spheres", SPHERE, SPHERE_MESH],
    [2727, "spheres", SPHERE, SPHERE_MESH],
    [600, "toruses", TORUS, TORUS_MESH],
  ])("%i %s draw coarser, each still round", (n, _, piece, mesh) => {
    const all = trianglesOf(buildScene(three, row(n, piece, mesh), false).scene);
    expect(all / n).toBeGreaterThanOrEqual(150);
    /* within the budget, or each at the coarsest detail where even that can't be */
    expect(all).toBeLessThanOrEqual(Math.max(150_000, n * 170));
  });
});

describe("a Map's water", () => {
  /* a cube at height z spans z..z+1000 cm; the water's height is in cm too */
  const waterOf = (scene: import("three").Scene) =>
    scene.getObjectByName("water") as import("three").Mesh | undefined;

  test("water a piece reaches through is drawn at its height, around every piece", () => {
    const { scene } = buildScene(
      three,
      cubes([[0, 0, 0], LIME], [[9000, 0, 3000], LIME]),
      true,
      500,
    );
    const water = waterOf(scene);
    if (!water) throw new Error("no water");
    const box = new three.THREE.Box3().setFromObject(water);
    expect(box.min.y).toBeCloseTo(5);
    expect(box.max.y).toBeCloseTo(5);
    /* the pieces cover x -5..95 m and z -5..5 m; the water reaches past them both ways */
    expect(box.min.x).toBeLessThan(-5);
    expect(box.max.x).toBeGreaterThan(95);
    expect(box.min.z).toBeLessThan(-5);
    expect(box.max.z).toBeGreaterThan(5);
    /* it stands in for the ground grid, which would show through it */
    expect(scene.children.some((o) => o instanceof three.THREE.GridHelper)).toBe(false);
  });

  test("water no piece reaches is not drawn", () => {
    const above = buildScene(three, cubes([[0, 0, 600], LIME]), true, 500);
    const below = buildScene(three, cubes([[0, 0, -2000], LIME]), true, 500);
    expect(waterOf(above.scene)).toBeUndefined();
    expect(waterOf(below.scene)).toBeUndefined();
    /* and the ground grid stays */
    expect(above.scene.children.some((o) => o instanceof three.THREE.GridHelper)).toBe(true);
  });

  test("a Prefab, which has no water, draws none", () => {
    expect(waterOf(buildScene(three, cubes([[0, 0, -500], LIME])).scene)).toBeUndefined();
  });

  test("the water doesn't move the framing, which fits the pieces alone", () => {
    const plain = buildScene(three, cubes([[0, 0, 0], LIME]), false);
    const wet = buildScene(three, cubes([[0, 0, 0], LIME]), false, 500);
    expect(wet.radius).toBeCloseTo(plain.radius);
    expect(wet.centre.y).toBeCloseTo(plain.centre.y);
  });
});

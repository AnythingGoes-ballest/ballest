// The piece tables' generator (scripts/prefab-pieces.ts): merging a catalogue into the tables,
// writing each table out whole, and the stand-in fitted to a mesh's own triangles.
import { describe, expect, test } from "vitest";

import type { MeshShape } from "../lib/prefab";
import { standIn, type Geometry, type Vec3 } from "../scripts/prefab-pieces/fit";
import {
  type Catalogue,
  type CataloguePiece,
  literal,
  merge,
  meshOf,
  type Tables,
  writeTable,
} from "../scripts/prefab-pieces/tables";

const solid = (name: string, mesh: string): CataloguePiece["meshComponents"][number] => ({
  name,
  mesh: `/Game/Meshes/${mesh}.${mesh}`,
  visible: true,
  tags: [],
  overrideMaterials: [],
});

const piece = (name: string, ...meshComponents: CataloguePiece["meshComponents"]) => ({
  inMenu: true,
  classPath: `/Game/LevelEditor/${name}.${name}_C`,
  meshComponents,
});

/* a raw point light as the catalogue reads it (2026-11-01): the editor's bulb and its own sphere,
   both hidden in a race */
const LIGHT = piece(
  "MP_RawPointLight",
  {
    ...solid("LightMarker", "Sphere"),
    visible: false,
    tags: ["SKGMapEditor", "MLESelectionHitbox"],
  },
  { ...solid("Main", "Sphere"), visible: false },
);

describe("the mesh a piece is drawn from", () => {
  test("its Main component's, else the first solid one", () => {
    expect(meshOf(piece("A", solid("Rail", "SM_Rail"), solid("Main", "SM_Main")))).toBe("SM_Main");
    expect(
      meshOf(
        piece("B", { ...solid("Main", "SM_Hidden"), visible: false }, solid("Rail", "SM_Rail")),
      ),
    ).toBe("SM_Rail");
  });

  test("none for a light, a light card's beam or a decal", () => {
    expect(meshOf(LIGHT)).toBeNull();
    const card = piece("MP_LightCard_03", {
      ...solid("Main", "Shape_Sphere"),
      overrideMaterials: ["/Game/Art/Volumetrics/MI_EV_LightCardGlow_01.MI_EV_LightCardGlow_01"],
    });
    expect(meshOf(card)).toBeNull();
    const decal = piece("BP_UGCCircuitDecal", { ...solid("Main", ""), mesh: "" });
    expect(meshOf(decal)).toBeNull();
  });
});

const BOX = (size: number): MeshShape => ({ kind: "box", min: [0, 0, 0], max: [size, size, size] });

describe("merging a catalogue into the tables", () => {
  const before: Tables = {
    pieces: ["BP_Old", "BP_Pipe_Half1"],
    pieceMeshes: { BP_Old: "SM_Old", BP_Pipe_Half1: "SM_1000" },
    meshes: { SM_1000: BOX(1000), SM_Old: BOX(1) },
    profiles: {},
  };
  const catalogue: Catalogue = {
    pieces: [
      piece("BP_Pipe_Half1", solid("Main", "SM_1000_180")),
      piece("BP_New", solid("Main", "SM_New")),
      LIGHT,
      { ...piece("BP_NotInMenu", solid("Main", "SM_Nope")), inMenu: false },
    ],
    meshes: [],
  };
  const fitted: Array<string> = [];
  const fit = (mesh: string) => {
    fitted.push(mesh);
    return {
      shape: BOX(2),
      profile:
        mesh === "SM_New" ? { view: "top" as const, shapes: [[[0, 0, 1000, 0, 0, 1000]]] } : null,
    };
  };
  const { tables, changes } = merge(before, catalogue, fit);

  test("adds the menu's pieces and keeps the ones it no longer has", () => {
    expect(tables.pieces).toEqual(["BP_New", "BP_Old", "BP_Pipe_Half1", "MP_RawPointLight"]);
  });

  test("sets a piece whose mesh changed, and draws a light from nothing", () => {
    expect(tables.pieceMeshes).toEqual({
      BP_New: "SM_New",
      BP_Old: "SM_Old",
      BP_Pipe_Half1: "SM_1000_180",
    });
    expect(changes).toContainEqual({
      table: "pieceMeshes",
      key: "BP_Pipe_Half1",
      was: "SM_1000",
      now: "SM_1000_180",
    });
  });

  test("fits only the meshes the tables lack, and keeps those it has", () => {
    expect(fitted).toEqual(["SM_1000_180", "SM_New"]);
    expect(tables.meshes.SM_1000).toEqual(BOX(1000));
    expect(Object.keys(tables.profiles)).toEqual(["SM_New"]);
  });

  test("a second run changes nothing", () => {
    const again = merge(tables, catalogue, fit);
    expect(again.changes).toEqual([]);
    expect(again.tables).toEqual(tables);
  });
});

describe("writing a table", () => {
  const TS = `// a header
import type { MeshShape } from "./prefab";

/* a note on the whole table */
export const MESHES: Partial<Record<string, MeshShape>> = {
  B: { kind: "box", min: [0, 0, -0], max: [1, 1, 1] },
};

export const PIECE_MESHES: Partial<Record<string, string>> = {
  BP_B: "B",
};

export const PIECES: ReadonlyArray<string> = [
  "BP_B",
];
`;

  test("writes every entry sorted, between the table's own lines", () => {
    const meshes = { C: BOX(3), A: BOX(1), B: { kind: "box", min: [0, 0, -0], max: [1, 1, 1] } };
    const ts = writeTable(TS, "MESHES", meshes);
    expect(ts).toContain(`/* a note on the whole table */
export const MESHES: Partial<Record<string, MeshShape>> = {
  A: { kind: "box", min: [0, 0, 0], max: [1, 1, 1] },
  B: { kind: "box", min: [0, 0, -0], max: [1, 1, 1] },
  C: { kind: "box", min: [0, 0, 0], max: [3, 3, 3] },
};`);
    expect(ts.slice(ts.indexOf("export const PIECE_MESHES"))).toBe(
      TS.slice(TS.indexOf("export const PIECE_MESHES")),
    );
  });

  test("an array table too, and a second write changes nothing", () => {
    const once = writeTable(TS, "PIECES", ["BP_C", "BP_A", "BP_B"]);
    expect(once).toContain(`[\n  "BP_A",\n  "BP_B",\n  "BP_C",\n];`);
    expect(writeTable(once, "PIECES", ["BP_C", "BP_A", "BP_B"])).toBe(once);
  });

  test("refuses a table it can't find whole, instead of guessing", () => {
    expect(() => writeTable(TS, "PROFILES", {})).toThrow(/PROFILES/);
    expect(() =>
      writeTable(
        TS.replace("\n};\n\nexport const PIECE", "};\n\nexport const PIECE"),
        "MESHES",
        {},
      ),
    ).toThrow();
    expect(() => writeTable(TS, "MESHES", ["A"])).toThrow(/array/);
  });

  test("a key that isn't a plain name is quoted", () => {
    expect(literal({ "SM-1": 1, ok: [1, -0] })).toBe('{ "SM-1": 1, ok: [1, -0] }');
  });
});

/* ---- the stand-in fitted to a mesh's triangles ---- */

/* a box's 12 triangles, corner `lo` to corner `hi` */
function cuboid(lo: Vec3, hi: Vec3): Geometry {
  const corner = (k: number): Vec3 => [
    k & 1 ? hi[0] : lo[0],
    k & 2 ? hi[1] : lo[1],
    k & 4 ? hi[2] : lo[2],
  ];
  const faces = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  return {
    positions: [0, 1, 2, 3, 4, 5, 6, 7].map(corner),
    indices: faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]),
  };
}

const joined = (...parts: Array<Geometry>): Geometry =>
  parts.reduce<Geometry>(
    (all, g) => ({
      positions: [...all.positions, ...g.positions],
      indices: [...all.indices, ...g.indices.map((i) => i + all.positions.length)],
    }),
    { positions: [], indices: [] },
  );

/* a sphere of radius 50 round the origin, 16 x 12 quads */
function sphere(): Geometry {
  const positions: Array<Vec3> = [];
  const indices: Array<number> = [];
  const [around, up] = [16, 12];
  for (let j = 0; j <= up; j++)
    for (let i = 0; i <= around; i++) {
      const [t, p] = [(j / up) * Math.PI, (i / around) * 2 * Math.PI];
      positions.push([
        50 * Math.sin(t) * Math.cos(p),
        50 * Math.sin(t) * Math.sin(p),
        50 * Math.cos(t),
      ]);
    }
  for (let j = 0; j < up; j++)
    for (let i = 0; i < around; i++) {
      const a = j * (around + 1) + i;
      const b = a + around + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { positions, indices };
}

describe("fitting a stand-in", () => {
  test("a sphere mesh is a sphere", () => {
    const found = standIn(sphere(), { min: [-50, -50, -50], max: [50, 50, 50] });
    expect(found.kind).toBe("sphere");
    expect(found.profile).toBeNull();
    expect(found.fit).toBeGreaterThan(0.9);
  });

  test("a box mesh is a box", () => {
    const found = standIn(cuboid([0, 0, 0], [100, 50, 20]), { min: [0, 0, 0], max: [100, 50, 20] });
    expect(found).toMatchObject({ kind: "box", profile: null });
  });

  test("an L-shaped one is drawn from its outline seen from above", () => {
    /* an L lying flat: a long arm along x and a short one along y */
    const l = joined(cuboid([0, 0, 0], [100, 30, 20]), cuboid([0, 30, 0], [30, 100, 20]));
    const found = standIn(l, { min: [0, 0, 0], max: [100, 100, 20] });
    expect(found.kind).toBe("box");
    expect(found.profile?.view).toBe("top");
    /* one outline, no holes, six corners */
    expect(found.profile?.shapes).toHaveLength(1);
    expect(found.profile?.shapes[0]).toHaveLength(1);
    expect(found.profile?.shapes[0][0]).toHaveLength(12);
  });
});

// GET /api/prefab-list and /api/prefabs/<slug>/thumb (ADR 0016): the game browsing the gallery
// a page at a time, on a throwaway database, read through the same cached reads the gallery
// and the Prefab's page use.
import { inflateSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { GET } from "../app/api/prefab-list/route";
import { GET as thumb } from "../app/api/prefabs/[slug]/thumb/route";
import type { Db } from "../db/client";
import { addPrefab, prefabOf } from "../db/prefabs";
import { prefabBans, prefabs } from "../db/schema";
import { cubesFile } from "../db/seed/datasets/tiny";
import { freshDb } from "./pg";

/* the cached reads run uncached outside Next, on this file's database */
const testDb = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("next/cache", () => ({ cacheTag: () => undefined, cacheLife: () => undefined }));
vi.mock("../db/client", async (original) => {
  const { connect } = await original<typeof import("../db/client")>();
  return { connect: (url: string) => testDb.db ?? connect(url) };
});

const UPLOADER = "76561199000000051";
const BANNED = "76561199000000052";
const SITE = "https://ballestrecords.com";
let t: Awaited<ReturnType<typeof freshDb>>;

beforeAll(async () => {
  t = await freshDb();
  testDb.db = t.db;
  process.env.DATABASE_URL ??= "postgres://unused";
  const add = (name: string, day: number, tags = ["Ramp"]) =>
    addPrefab(t.db, {
      name,
      description: "Shown in the game.",
      tags,
      uploader: UPLOADER,
      uploaderName: "Builder",
      file: cubesFile(3),
      createdAt: new Date(`2026-10-${String(day).padStart(2, "0")}T10:00:00Z`),
    });
  for (let day = 1; day <= 5; day++) await add(`Ramp ${String(day)}`, day);
  await add("Wrong way sign", 6, ["Decoration"]);
  await add("Deleted ramp", 7);
  await t.db.execute(`update prefabs set deleted_at = now() where slug = 'deleted-ramp'`);
});
afterAll(() => t.drop());

interface Entry {
  slug: string;
  file?: string;
  [k: string]: unknown;
}
const list = async (q: string) => {
  const r = await GET(new Request(`${SITE}/api/prefab-list${q}`));
  return {
    status: r.status,
    cache: r.headers.get("cache-control"),
    body: (await r.json()) as { total: number; next: number | null; prefabs: Array<Entry> },
  };
};

describe("the list", () => {
  test("is a page of live Prefabs with what a Prefab's page shows, its thumbnail and its file", async () => {
    const { status, cache, body } = await list("?sort=newest&limit=2");
    expect(status).toBe(200);
    expect(cache).toBe("public, max-age=60, s-maxage=60");
    expect(body.total).toBe(6);
    expect(body.next).toBe(2);
    expect(body.prefabs.map((p) => p.slug)).toEqual(["wrong-way-sign", "ramp-5"]);
    const [sign] = body.prefabs;
    expect(Object.keys(sign).sort()).toEqual(
      [
        "slug",
        "name",
        "description",
        "tags",
        "uploader",
        "createdAt",
        "updatedAt",
        "pieces",
        "bytes",
        "favorites",
        "size",
        "thumb",
        "file",
      ].sort(),
    );
    expect(sign).toMatchObject({
      name: "Wrong way sign",
      description: "Shown in the game.",
      tags: ["Decoration"],
      uploader: { steamId: UPLOADER, name: "Builder" },
      createdAt: "2026-10-06T10:00:00.000Z",
      pieces: 3,
      favorites: 0,
      file: "/api/prefabs/wrong-way-sign/file",
      thumb: `/api/prefabs/wrong-way-sign/thumb?v=${String(Date.parse("2026-10-06T10:00:00Z"))}`,
    });
    expect(sign.bytes).toBe(Buffer.byteLength(cubesFile(3)));
    const size = sign.size as { w: number; d: number; h: number };
    for (const v of [size.w, size.d, size.h]) expect(v).toBeGreaterThan(0);
  });

  test("the cursor walks on to the end; deleted ones never show", async () => {
    const slugs: Array<string> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const { body } = await list(`?sort=newest&limit=4&cursor=${String(cursor)}`);
      slugs.push(...body.prefabs.map((p) => p.slug));
      cursor = body.next;
    }
    expect(slugs).toEqual(["wrong-way-sign", "ramp-5", "ramp-4", "ramp-3", "ramp-2", "ramp-1"]);
  });

  test("a Prefab whose file can't be measured is listed without a size, not the page lost", async () => {
    await t.db.insert(prefabs).values({
      slug: "odd-file",
      name: "Odd file",
      description: "",
      tags: [],
      uploader: UPLOADER,
      file: '{"items":[null,null]}',
      pieces: 2,
      bytes: 21,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const { status, body } = await list("?sort=newest&limit=100");
    expect(status).toBe(200);
    expect(body.prefabs.find((p) => p.slug === "odd-file")?.size).toBeNull();
    await t.db.execute(`delete from prefabs where slug = 'odd-file'`);
  });

  test("searches and filters by tag; a bad query is a 400", async () => {
    expect((await list("?q=wrong")).body.prefabs.map((p) => p.slug)).toEqual(["wrong-way-sign"]);
    expect((await list("?tag=Decoration")).body.total).toBe(1);
    expect((await list("?tag=Spaceship")).status).toBe(400);
    expect((await list("?limit=500")).status).toBe(400);
  });
});

describe("the thumbnail", () => {
  const draw = (slug: string, search: string) =>
    thumb(new Request(`${SITE}/api/prefabs/${slug}/thumb${search}`), {
      params: Promise.resolve({ slug }),
    });
  /* the address the list gives for `slug` */
  const listed = async (slug: string) =>
    new URL(
      String((await list("?limit=100")).body.prefabs.find((p) => p.slug === slug)?.thumb),
      SITE,
    ).search;

  test("at the address the list gives, is a 320 × 200 PNG with the Prefab drawn on it", async () => {
    const r = await draw("ramp-1", await listed("ramp-1"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    const bytes = Buffer.from(await r.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([320, 200]);
    // some pixel isn't clear: the Prefab is in the picture
    const idat = bytes.indexOf("IDAT");
    const raw = inflateSync(bytes.subarray(idat + 4, idat + 4 + bytes.readUInt32BE(idat - 4)));
    const row = 320 * 4 + 1;
    expect(raw.some((b, i) => i % row !== 0 && (i % row) % 4 === 0 && b > 0)).toBe(true);
  });

  test("any other query is sent to the current address, so a new query string can't make it be drawn again", async () => {
    const good = await listed("ramp-2");
    for (const search of ["", "?v=1", `${good}0`, `${good}&x=1`, `?x=1&${good.slice(1)}`]) {
      const r = await draw("ramp-2", search);
      expect(r.status, search).toBe(307);
      expect(r.headers.get("location")).toBe(`/api/prefabs/ramp-2/thumb${good}`);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
    }
    expect((await draw("ramp-2", good)).status).toBe(200);
  });

  test("a Prefab deleted, taken down or hidden by a ban has none, even at its own address", async () => {
    /* `slug`'s address as the list gave it while it was live */
    const at = async (slug: string) => {
      const p = await prefabOf(t.db, slug);
      return `?v=${String(Date.parse(p?.updatedAt ?? ""))}`;
    };
    const added = (name: string, uploader: string) =>
      addPrefab(t.db, {
        name,
        description: "",
        tags: [],
        uploader,
        uploaderName: null,
        file: cubesFile(2),
      });
    await added("Taken ramp", UPLOADER);
    await added("Banned ramp", BANNED);
    const taken = await at("taken-ramp");
    const banned = await at("banned-ramp");
    expect((await draw("taken-ramp", taken)).status).toBe(200);
    expect((await draw("banned-ramp", banned)).status).toBe(200);
    await t.db.execute(`update prefabs set taken_down_at = now() where slug = 'taken-ramp'`);
    await t.db.insert(prefabBans).values({ steamId: BANNED, bannedBy: UPLOADER });
    expect((await draw("deleted-ramp", await at("deleted-ramp"))).status).toBe(404);
    expect((await draw("taken-ramp", taken)).status).toBe(404);
    expect((await draw("banned-ramp", banned)).status).toBe(404);
    expect((await draw("no-such-thing", "?v=1")).status).toBe(404);
  });
});

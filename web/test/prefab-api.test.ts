// The Prefab API routes (db/prefab-api.ts) as a browser calls them, signed in or not, against
// a throwaway database: what each answers, and what the gallery and pages then read.
import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  banUploader,
  editPrefab,
  favoritePrefab,
  takeDownPrefab,
  uploadPrefab,
  limitUploader,
  uploadQuota,
  type PrefabDeps,
} from "../db/prefab-api";
import { pingOf, type PrefabPing } from "../db/prefab-ping";
import { ADMIN_STEAM_ID, HOURLY_PREFAB_WRITES, galleryOf } from "../lib/prefabs";
import { addPrefab, prefabList, prefabOf } from "../db/prefabs";
import { prefabBans } from "../db/schema";
import { cubesFile } from "../db/seed/datasets/tiny";
import { freshDb } from "./pg";
import { ENV, NOW, SITE, gameToken, signIn } from "./session";

const UPLOADER = "76561199000000011";
const HOUR = 3_600_000;
const MINUTE = 60_000;
const bench = readFileSync(new URL("../../prefabs/samples/bench.json", import.meta.url), "utf8");

let t: Awaited<ReturnType<typeof freshDb>>;
let pings: Array<PrefabPing>;
let changes: number;
let clock: number;
const deps = (): PrefabDeps => ({
  db: t.db,
  auth: { ...ENV, now: clock },
  ping: (p) => {
    pings.push(p);
    return Promise.resolve();
  },
  persona: () => Promise.resolve("Uploader on Steam"),
  changed: () => changes++,
});

beforeAll(async () => {
  t = await freshDb();
});
afterAll(() => t.drop());
beforeEach(() => {
  pings = [];
  changes = 0;
  clock = NOW;
});

/* the session cookie of a browser signed in as `id` */
const sessionOf = async (id: string) => `ballest-session=${(await signIn(id)).session}`;

/* POST /api/prefabs as the upload form sends it */
function uploading(
  fields: {
    name?: string;
    description?: string;
    tags?: Array<string>;
    file?: string;
    picture?: Uint8Array<ArrayBuffer>;
    angle?: string;
  },
  cookie = "",
  headers: Record<string, string> = {},
) {
  const body = new FormData();
  body.set("name", fields.name ?? "Park bench");
  body.set("description", fields.description ?? "");
  for (const tag of fields.tags ?? []) body.append("tags", tag);
  body.set("file", new Blob([fields.file ?? bench]), "bench.json");
  if (fields.picture) body.set("picture", new Blob([fields.picture]), "prefab.png");
  if (fields.angle !== undefined) body.set("angle", fields.angle);
  return new Request(SITE + "/api/prefabs", {
    method: "POST",
    body,
    headers: { cookie, origin: SITE, ...headers },
  });
}

describe("uploading a Prefab", () => {
  test("signed out, nothing is saved", async () => {
    const r = await uploadPrefab(uploading({}), deps());
    expect(r.status).toBe(401);
    expect(await prefabList(t.db)).toEqual([]);
  });

  test("from another site, nothing is saved", async () => {
    const cookie = await sessionOf(UPLOADER);
    const r = await uploadPrefab(uploading({}, cookie, { origin: "https://evil.example" }), deps());
    expect(r.status).toBe(403);
    expect(await prefabList(t.db)).toEqual([]);
  });

  test("a file the game wouldn't spawn is refused with every reason", async () => {
    const cookie = await sessionOf(UPLOADER);
    const r = await uploadPrefab(uploading({ file: '{"format":"BallestMap"}' }, cookie), deps());
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      problems: [
        'It isn\'t a prefab: "format" should be "BallestPrefab".',
        "Its group transform is missing.",
        "It has no pieces.",
      ],
    });
  });

  test("a name, description or tag out of bounds is refused", async () => {
    const cookie = await sessionOf(UPLOADER);
    const bad = async (fields: Parameters<typeof uploading>[0]) =>
      (
        (await (await uploadPrefab(uploading(fields, cookie), deps())).json()) as {
          problems: Array<string>;
        }
      ).problems;
    expect(await bad({ name: "   " })).toEqual(["Give it a name."]);
    expect(await bad({ name: "x".repeat(65) })).toEqual(["Keep the name to 64 characters."]);
    expect(await bad({ description: "x".repeat(501) })).toEqual([
      "Keep the description to 500 characters.",
    ]);
    expect(await bad({ tags: ["Ramp", "Loop", "Scenery", "Obstacle"] })).toEqual([
      "Pick up to 3 tags.",
    ]);
    expect(await bad({ tags: ["Spaceship"] })).toEqual(["Spaceship isn't one of the tags."]);
    expect(await prefabList(t.db)).toEqual([]);
  });

  test("a good one is live at once, credited to the uploader, and pinged", async () => {
    const cookie = await sessionOf(UPLOADER);
    const r = await uploadPrefab(
      uploading({ name: " Park bench ", description: "Sit.", tags: ["Decoration"] }, cookie),
      deps(),
    );
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ slug: "park-bench" });
    expect(await prefabOf(t.db, "park-bench")).toMatchObject({
      name: "Park bench",
      description: "Sit.",
      tags: ["Decoration"],
      uploader: { steamId: UPLOADER, name: "Uploader on Steam", isPlayer: false },
      pieces: 28,
      file: bench,
    });
    expect(changes).toBe(1);
    expect(pings).toEqual([
      {
        slug: "park-bench",
        name: "Park bench",
        pieces: 28,
        tags: ["Decoration"],
        uploader: { steamId: UPLOADER, name: "Uploader on Steam" },
        picture: null,
      },
    ]);
  });

  test("the preview still the browser sends rides along with the ping, if it is a PNG", async () => {
    const cookie = await sessionOf("76561199000000013");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await uploadPrefab(uploading({ name: "Pictured", picture: png }, cookie), deps());
    await uploadPrefab(
      uploading({ name: "Not a picture", picture: new TextEncoder().encode("<svg/>") }, cookie),
      deps(),
    );
    const big = new Uint8Array(1_000_001);
    big.set(png);
    await uploadPrefab(uploading({ name: "Too big", picture: big }, cookie), deps());
    expect(pings.map((p) => [p.name, p.picture])).toEqual([
      ["Pictured", png],
      ["Not a picture", null],
      ["Too big", null],
    ]);
  });

  test("a sixth in an hour waits until the oldest is an hour old", async () => {
    const id = "76561199000000012";
    const cookie = await sessionOf(id);
    const quota = async (): Promise<unknown> =>
      (await uploadQuota(uploading({}, cookie), deps())).json();
    expect(await quota()).toEqual({
      signedIn: true,
      banned: false,
      left: 5,
      limit: 5,
      nextAt: null,
    });
    for (let i = 0; i < 5; i++) {
      clock = NOW + i * 10 * MINUTE;
      expect(
        (
          await uploadPrefab(
            uploading({ name: `Cubes ${String(i)}`, file: cubesFile(2) }, cookie),
            deps(),
          )
        ).status,
      ).toBe(201);
    }
    clock = NOW + 50 * MINUTE;
    expect(await quota()).toEqual({
      signedIn: true,
      banned: false,
      left: 0,
      limit: 5,
      nextAt: new Date(NOW + HOUR).toISOString(),
    });
    // refused before Steam is asked for their persona
    let asked = 0;
    const counting = {
      ...deps(),
      persona: () => {
        asked++;
        return Promise.resolve("Uploader on Steam");
      },
    };
    const refused = await uploadPrefab(uploading({ name: "One more" }, cookie), counting);
    expect(refused.status).toBe(429);
    expect(asked).toBe(0);
    clock = NOW + HOUR + 1000;
    expect(await quota()).toMatchObject({ left: 1 });
    expect((await uploadPrefab(uploading({ name: "One more" }, cookie), deps())).status).toBe(201);
  });

  test("a banned player can't upload, and the form says so", async () => {
    const id = "76561199000000013";
    await t.db.insert(prefabBans).values({ steamId: id, bannedBy: "76561198047685844" });
    const cookie = await sessionOf(id);
    expect(await (await uploadQuota(uploading({}, cookie), deps())).json()).toMatchObject({
      banned: true,
      left: 0,
    });
    // refused before Steam is asked for their persona
    let asked = 0;
    const counting = {
      ...deps(),
      persona: () => {
        asked++;
        return Promise.resolve("Banned on Steam");
      },
    };
    expect((await uploadPrefab(uploading({ name: "Sneaky" }, cookie), counting)).status).toBe(403);
    expect(asked).toBe(0);
  });

  test("signed out, the quota says so", async () => {
    expect(await (await uploadQuota(uploading({}), deps())).json()).toEqual({
      signedIn: false,
      banned: false,
      left: 0,
      limit: 0,
      nextAt: null,
    });
  });
});

describe("favorites", () => {
  /* a request to /api/prefabs/<slug>/favorite */
  const fav = (slug: string, method: string, cookie = "") =>
    new Request(`${SITE}/api/prefabs/${slug}/favorite`, {
      method,
      headers: { cookie, origin: SITE },
    });
  const said = async (r: Response) => ({ status: r.status, body: (await r.json()) as unknown });

  test("a signed-in player hearts a Prefab once, and can take it back", async () => {
    const owner = await sessionOf("76561199000000021");
    await uploadPrefab(uploading({ name: "Heart me" }, owner), deps());
    changes = 0;
    const a = await sessionOf("76561199000000022");
    const b = await sessionOf("76561199000000023");
    expect(await said(await favoritePrefab(fav("heart-me", "GET", a), deps(), "heart-me"))).toEqual(
      {
        status: 200,
        body: { on: false, favorites: 0 },
      },
    );
    expect(await said(await favoritePrefab(fav("heart-me", "PUT", a), deps(), "heart-me"))).toEqual(
      {
        status: 200,
        body: { on: true, favorites: 1 },
      },
    );
    // twice is still once
    await favoritePrefab(fav("heart-me", "PUT", a), deps(), "heart-me");
    expect(await said(await favoritePrefab(fav("heart-me", "PUT", b), deps(), "heart-me"))).toEqual(
      {
        status: 200,
        body: { on: true, favorites: 2 },
      },
    );
    expect((await prefabOf(t.db, "heart-me"))?.favorites).toBe(2);
    expect(
      await said(await favoritePrefab(fav("heart-me", "DELETE", a), deps(), "heart-me")),
    ).toEqual({
      status: 200,
      body: { on: false, favorites: 1 },
    });
    // the repeated PUT changed nothing, so it expired nothing
    expect(changes).toBe(3);
    await favoritePrefab(fav("heart-me", "DELETE", a), deps(), "heart-me");
    expect(changes).toBe(3);
  });

  test("a player has 60 hearts and edits an hour; past that nothing changes and nothing expires", async () => {
    const owner = await sessionOf("76561199000000024");
    await uploadPrefab(uploading({ name: "Heart me lots" }, owner), deps());
    const fan = await sessionOf("76561199000000025");
    const slug = "heart-me-lots";
    for (let i = 0; i < HOURLY_PREFAB_WRITES; i++) {
      const r = await favoritePrefab(fav(slug, i % 2 ? "DELETE" : "PUT", fan), deps(), slug);
      expect(r.status).toBe(200);
    }
    changes = 0;
    const over = await favoritePrefab(fav(slug, "PUT", fan), deps(), slug);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "that's your hearts and edits for the last hour" });
    expect((await prefabOf(t.db, slug))?.favorites).toBe(0);
    // spent, a heart that changes nothing (taking back one not there) still answers
    expect((await favoritePrefab(fav(slug, "DELETE", fan), deps(), slug)).status).toBe(200);
    expect(changes).toBe(0);
    // an hour on, they have them again
    clock = NOW + HOUR + MINUTE;
    expect((await favoritePrefab(fav(slug, "PUT", fan), deps(), slug)).status).toBe(200);
    expect((await prefabOf(t.db, slug))?.favorites).toBe(1);
    // and leave it unhearted for the gallery's order below
    await favoritePrefab(fav(slug, "DELETE", fan), deps(), slug);
  });

  test("many hearts at once can't take more than the hour's writes", async () => {
    const fan = await sessionOf("76561199000000026");
    const slugs = await Promise.all(
      Array.from({ length: HOURLY_PREFAB_WRITES + 10 }, (_, i) =>
        addPrefab(t.db, {
          name: `Rush ${String(i)}`,
          description: "",
          tags: [],
          uploader: "76561199000000027",
          uploaderName: null,
          file: bench,
        }).then((p) => p.slug),
      ),
    );
    const said = await Promise.all(
      slugs.map(async (s) => (await favoritePrefab(fav(s, "PUT", fan), deps(), s)).status),
    );
    expect(said.filter((s) => s === 200).length).toBe(HOURLY_PREFAB_WRITES);
    expect(said.filter((s) => s === 429).length).toBe(10);
    // leave them unhearted for the gallery's order below
    await t.db.execute(sql`delete from prefab_favorites where steam_id = '76561199000000026'`);
  });

  test("the same heart sent twice at once lands once and costs one write", async () => {
    const fan = await sessionOf("76561199000000028");
    const { slug } = await addPrefab(t.db, {
      name: "Double tap",
      description: "",
      tags: [],
      uploader: "76561199000000027",
      uploaderName: null,
      file: bench,
    });
    for (const method of ["PUT", "DELETE"]) {
      const said = await Promise.all(
        [0, 1].map(async () => (await favoritePrefab(fav(slug, method, fan), deps(), slug)).status),
      );
      expect(said).toEqual([200, 200]);
    }
    expect((await prefabOf(t.db, slug))?.favorites).toBe(0);
    const { rows } = await t.db.execute(
      sql`select count(*)::int as n from hourly_spends where key = '76561199000000028'`,
    );
    expect(rows[0]).toEqual({ n: 2 });
  });

  test("signed out it only counts, and asks to sign in to change", async () => {
    expect(await said(await favoritePrefab(fav("heart-me", "GET"), deps(), "heart-me"))).toEqual({
      status: 200,
      body: { on: false, favorites: 1 },
    });
    expect((await favoritePrefab(fav("heart-me", "PUT"), deps(), "heart-me")).status).toBe(401);
  });

  test("a Prefab nobody uploaded can't be hearted", async () => {
    const a = await sessionOf("76561199000000022");
    expect((await favoritePrefab(fav("nope", "PUT", a), deps(), "nope")).status).toBe(404);
  });

  test("the gallery puts the most hearted first", async () => {
    const cards = galleryOf(await prefabList(t.db), "popular", null);
    expect(cards[0].slug).toBe("heart-me");
  });
});

describe("editing and deleting your own", () => {
  const OWNER = "76561199000000031";
  /* PATCH or DELETE /api/prefabs/<slug> */
  const change = (slug: string, method: string, cookie: string, body?: object) =>
    new Request(`${SITE}/api/prefabs/${slug}`, {
      method,
      headers: { cookie, origin: SITE, "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });

  test("the uploader renames, redescribes and retags it, and its link stays", async () => {
    const owner = await sessionOf(OWNER);
    await uploadPrefab(uploading({ name: "Mine to edit", tags: ["Ramp"] }, owner), deps());
    changes = 0;
    const r = await editPrefab(
      change("mine-to-edit", "PATCH", owner, {
        name: "Edited",
        description: "Now described.",
        tags: ["Loop", "Scenery"],
      }),
      deps(),
      "mine-to-edit",
    );
    expect(r.status).toBe(200);
    expect(await prefabOf(t.db, "mine-to-edit")).toMatchObject({
      slug: "mine-to-edit",
      name: "Edited",
      description: "Now described.",
      tags: ["Loop", "Scenery"],
      state: "live",
    });
    expect(changes).toBe(1);
  });

  test("edits count against the same hourly writes as hearts", async () => {
    const owner = await sessionOf("76561199000000033");
    await uploadPrefab(uploading({ name: "Edit me lots" }, owner), deps());
    const edit = { name: "Edit me lots", description: "", tags: [] };
    for (let i = 0; i < HOURLY_PREFAB_WRITES; i++)
      expect(
        (await editPrefab(change("edit-me-lots", "PATCH", owner, edit), deps(), "edit-me-lots"))
          .status,
      ).toBe(200);
    expect(
      (await editPrefab(change("edit-me-lots", "PATCH", owner, edit), deps(), "edit-me-lots"))
        .status,
    ).toBe(429);
    expect((await prefabOf(t.db, "edit-me-lots"))?.state).toBe("live");
    // deleting their own happens once, so it isn't held back
    expect(
      (await editPrefab(change("edit-me-lots", "DELETE", owner), deps(), "edit-me-lots")).status,
    ).toBe(200);
    expect((await prefabOf(t.db, "edit-me-lots"))?.state).toBe("deleted");
  });

  test("an edit landing after a take-down changes nothing", async () => {
    const owner = await sessionOf("76561199000000034");
    await uploadPrefab(uploading({ name: "Taken mid edit" }, owner), deps());
    // the take-down lands between the edit's checks and its write
    const deps2 = deps();
    const racing: PrefabDeps = {
      ...deps2,
      db: new Proxy(deps2.db, {
        get(target, key, receiver) {
          if (key !== "transaction") return Reflect.get(target, key, receiver) as unknown;
          return async (fn: Parameters<typeof target.transaction>[0]) => {
            await target.execute(
              sql`update prefabs set taken_down_at = now() where slug = 'taken-mid-edit'`,
            );
            return target.transaction(fn);
          };
        },
      }),
    };
    const r = await editPrefab(
      change("taken-mid-edit", "PATCH", owner, { name: "Sneaked", description: "", tags: [] }),
      racing,
      "taken-mid-edit",
    );
    expect(r.status).toBe(404);
    expect((await prefabOf(t.db, "taken-mid-edit"))?.name).toBe("Taken mid edit");
  });

  test("fields out of bounds are refused as on upload", async () => {
    const owner = await sessionOf(OWNER);
    const r = await editPrefab(
      change("mine-to-edit", "PATCH", owner, { name: "", description: "", tags: [] }),
      deps(),
      "mine-to-edit",
    );
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ problems: ["Give it a name."] });
  });

  test("nobody else can edit or delete it, signed in or not", async () => {
    const other = await sessionOf("76561199000000032");
    const edit = { name: "Mine now", description: "", tags: [] };
    expect(
      (await editPrefab(change("mine-to-edit", "PATCH", other, edit), deps(), "mine-to-edit"))
        .status,
    ).toBe(403);
    expect(
      (await editPrefab(change("mine-to-edit", "PATCH", "", edit), deps(), "mine-to-edit")).status,
    ).toBe(401);
    expect(
      (await editPrefab(change("mine-to-edit", "DELETE", other), deps(), "mine-to-edit")).status,
    ).toBe(403);
    expect((await prefabOf(t.db, "mine-to-edit"))?.name).toBe("Edited");
  });

  test("deleting it takes it out of the gallery, its page reads gone, and it still counts", async () => {
    const owner = await sessionOf(OWNER);
    const before = (await (await uploadQuota(uploading({}, owner), deps())).json()) as {
      left: number;
    };
    expect(
      (await editPrefab(change("mine-to-edit", "DELETE", owner), deps(), "mine-to-edit")).status,
    ).toBe(200);
    expect((await prefabOf(t.db, "mine-to-edit"))?.state).toBe("deleted");
    expect((await prefabList(t.db)).map((c) => c.slug)).not.toContain("mine-to-edit");
    expect(await (await uploadQuota(uploading({}, owner), deps())).json()).toMatchObject({
      left: before.left,
    });
    // and once deleted it can't be edited or deleted again
    expect(
      (await editPrefab(change("mine-to-edit", "DELETE", owner), deps(), "mine-to-edit")).status,
    ).toBe(404);
  });
});

describe("from the game, signed in with a Steam ticket (ADR 0016)", () => {
  const PLAYER = "76561199000000061";
  const OTHER = "76561199000000062";
  /* a request as the game sends it: the token as a bearer, no cookie, no Origin */
  const fromGame = (path: string, method: string, token: string, body?: BodyInit) =>
    new Request(SITE + path, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body,
    });
  const form = (name: string) => {
    const body = new FormData();
    body.set("name", name);
    body.set("description", "");
    body.set("file", new Blob([bench]), "bench.json");
    return body;
  };
  const json = (body: object) => JSON.stringify(body);

  test("without a token nothing is uploaded, edited, deleted or hearted", async () => {
    const owner = await gameToken(PLAYER);
    await uploadPrefab(fromGame("/api/prefabs", "POST", owner, form("Game bench")), deps());
    const before = await prefabOf(t.db, "game-bench");
    expect(
      (await uploadPrefab(fromGame("/api/prefabs", "POST", "", form("Sneaky")), deps())).status,
    ).toBe(401);
    for (const method of ["PATCH", "DELETE"])
      expect(
        (
          await editPrefab(
            fromGame("/api/prefabs/game-bench", method, "", json({ name: "Mine now" })),
            deps(),
            "game-bench",
          )
        ).status,
      ).toBe(401);
    expect(
      (
        await favoritePrefab(
          fromGame("/api/prefabs/game-bench/favorite", "PUT", ""),
          deps(),
          "game-bench",
        )
      ).status,
    ).toBe(401);
    expect(await prefabOf(t.db, "game-bench")).toEqual(before);
    expect((await prefabList(t.db)).map((c) => c.slug)).not.toContain("sneaky");
  });

  test("an upload is credited to the ticket's player, whatever the form says", async () => {
    const token = await gameToken(PLAYER);
    const body = form("Credited bench");
    body.set("uploader", OTHER);
    const r = await uploadPrefab(fromGame("/api/prefabs", "POST", token, body), deps());
    expect(r.status).toBe(201);
    expect((await prefabOf(t.db, "credited-bench"))?.uploader.steamId).toBe(PLAYER);
  });

  test("the player edits and deletes their own, and nobody else's", async () => {
    const mine = await gameToken(PLAYER);
    const theirs = await gameToken(OTHER);
    await uploadPrefab(fromGame("/api/prefabs", "POST", theirs, form("Their bench")), deps());
    const edit = json({ name: "Mine now", description: "", tags: [] });
    for (const [method, body] of [
      ["PATCH", edit],
      ["DELETE", undefined],
    ] as const)
      expect(
        (
          await editPrefab(
            fromGame("/api/prefabs/their-bench", method, mine, body),
            deps(),
            "their-bench",
          )
        ).status,
      ).toBe(403);
    expect(await prefabOf(t.db, "their-bench")).toMatchObject({
      name: "Their bench",
      state: "live",
    });
    // their own: renamed, then deleted
    expect(
      (
        await editPrefab(
          fromGame("/api/prefabs/game-bench", "PATCH", mine, edit),
          deps(),
          "game-bench",
        )
      ).status,
    ).toBe(200);
    expect((await prefabOf(t.db, "game-bench"))?.name).toBe("Mine now");
    expect(
      (await editPrefab(fromGame("/api/prefabs/game-bench", "DELETE", mine), deps(), "game-bench"))
        .status,
    ).toBe(200);
    expect((await prefabOf(t.db, "game-bench"))?.state).toBe("deleted");
  });

  test("the upload quota reads the token", async () => {
    const id = "76561199000000063";
    const token = await gameToken(id);
    await uploadPrefab(fromGame("/api/prefabs", "POST", token, form("Quota bench")), deps());
    expect(
      await (await uploadQuota(fromGame("/api/prefabs", "GET", token), deps())).json(),
    ).toEqual({
      signedIn: true,
      banned: false,
      left: 4,
      limit: 5,
      nextAt: null,
    });
  });

  test("a token can't reach the admin's take-down, ban or limits, not even the admin's own", async () => {
    for (const token of [await gameToken(PLAYER), await gameToken(ADMIN_STEAM_ID)]) {
      expect(
        (
          await takeDownPrefab(
            fromGame("/api/prefabs/their-bench/takedown", "POST", token),
            deps(),
            "their-bench",
          )
        ).status,
      ).toBe(401);
      expect(
        (await banUploader(fromGame(`/api/prefab-bans/${OTHER}`, "PUT", token), deps(), OTHER))
          .status,
      ).toBe(401);
      for (const [method, body] of [
        ["GET", undefined],
        ["PUT", json({ perHour: 1000 })],
        ["DELETE", undefined],
      ] as const) {
        expect(
          (
            await limitUploader(
              fromGame(`/api/prefab-limits/${PLAYER}`, method, token, body),
              deps(),
              PLAYER,
            )
          ).status,
        ).toBe(401);
        // checked after each, so a DELETE later can't hide a PUT that landed
        const { rows } = await t.db.execute(
          sql`select count(*)::int as n from prefab_limits where steam_id = ${PLAYER}`,
        );
        expect(rows[0]).toEqual({ n: 0 });
      }
    }
    expect((await prefabOf(t.db, "their-bench"))?.state).toBe("live");
  });
});

describe("the angle its picture is drawn from", () => {
  const OWNER = "76561199000000041";
  const angle = { from: [0, 2, 0], zoom: 1.23456, pan: [0.1, 0, 0] };
  const tidied = { from: [0, 1, 0], zoom: 1.2346, pan: [0.1, 0, 0] };
  const patch = (body: object, cookie: string) =>
    new Request(`${SITE}/api/prefabs/angled`, {
      method: "PATCH",
      headers: { cookie, origin: SITE, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("an upload without one reads as the default, and one with one keeps it tidied", async () => {
    const owner = await sessionOf(OWNER);
    await uploadPrefab(uploading({ name: "Plain" }, owner), deps());
    expect((await prefabOf(t.db, "plain"))?.angle).toBeNull();
    const r = await uploadPrefab(
      uploading({ name: "Angled", angle: JSON.stringify(angle) }, owner),
      deps(),
    );
    expect(r.status).toBe(201);
    expect((await prefabOf(t.db, "angled"))?.angle).toEqual(tidied);
    expect((await prefabList(t.db)).find((p) => p.slug === "angled")?.angle).toEqual(tidied);
  });

  test("an upload with one that can't be an angle is refused", async () => {
    const owner = await sessionOf(OWNER);
    for (const bad of ["not json", '{"from":[0,0,0],"zoom":1,"pan":[0,0,0]}'])
      expect(
        await (await uploadPrefab(uploading({ name: "Bad", angle: bad }, owner), deps())).json(),
      ).toEqual({ problems: ["That view can't be saved. Pick it again."] });
    expect(await prefabOf(t.db, "bad")).toBeNull();
  });

  test("the uploader changes only the angle, or puts it back to the default", async () => {
    const owner = await sessionOf(OWNER);
    const turned = { from: [1, 0, 0], zoom: 2, pan: [0, 0, 0] };
    expect((await editPrefab(patch({ angle: turned }, owner), deps(), "angled")).status).toBe(200);
    expect(await prefabOf(t.db, "angled")).toMatchObject({ name: "Angled", angle: turned });
    await editPrefab(patch({ angle: null }, owner), deps(), "angled");
    expect((await prefabOf(t.db, "angled"))?.angle).toBeNull();
    const r = await editPrefab(patch({ angle: { zoom: 1 } }, owner), deps(), "angled");
    expect(r.status).toBe(400);
    expect((await editPrefab(patch(5 as unknown as object, owner), deps(), "angled")).status).toBe(
      400,
    );
  });

  test("Edit saves the angle with the name, description and tags, and can reset it with them", async () => {
    const owner = await sessionOf(OWNER);
    const turned = { from: [0, 0, 1], zoom: 3, pan: [0, 0, 0] };
    const words = { name: "Angled", description: "Turned", tags: [] };
    expect(
      (await editPrefab(patch({ ...words, angle: turned }, owner), deps(), "angled")).status,
    ).toBe(200);
    expect(await prefabOf(t.db, "angled")).toMatchObject({ description: "Turned", angle: turned });
    await editPrefab(
      patch({ ...words, description: "Reset", angle: null }, owner),
      deps(),
      "angled",
    );
    expect(await prefabOf(t.db, "angled")).toMatchObject({ description: "Reset", angle: null });
  });

  test("nobody else can change it", async () => {
    const other = await sessionOf("76561199000000042");
    const r = await editPrefab(patch({ angle: angle }, other), deps(), "angled");
    expect(r.status).toBe(403);
  });
});

describe("the admin's take down and ban", () => {
  const ADMIN = "76561198047685844";
  const BAD = "76561199000000041";
  const post = (path: string, method: string, cookie: string) =>
    new Request(SITE + path, { method, headers: { cookie, origin: SITE } });
  const states = async () =>
    Object.fromEntries(
      await Promise.all(
        ["bad-one", "bad-two"].map(async (s) => [s, (await prefabOf(t.db, s))?.state]),
      ),
    ) as Record<string, string>;

  test("only the admin can take a Prefab down, and it reads gone", async () => {
    const bad = await sessionOf(BAD);
    await uploadPrefab(uploading({ name: "Bad one" }, bad), deps());
    await uploadPrefab(uploading({ name: "Bad two" }, bad), deps());
    const other = await sessionOf("76561199000000042");
    expect(
      (
        await takeDownPrefab(
          post("/api/prefabs/bad-one/takedown", "POST", other),
          deps(),
          "bad-one",
        )
      ).status,
    ).toBe(403);
    expect(
      (await takeDownPrefab(post("/api/prefabs/bad-one/takedown", "POST", bad), deps(), "bad-one"))
        .status,
    ).toBe(403);
    changes = 0;
    const admin = await sessionOf(ADMIN);
    expect(
      (
        await takeDownPrefab(
          post("/api/prefabs/bad-one/takedown", "POST", admin),
          deps(),
          "bad-one",
        )
      ).status,
    ).toBe(200);
    expect(await states()).toEqual({ "bad-one": "taken-down", "bad-two": "live" });
    expect((await prefabList(t.db)).map((c) => c.slug)).not.toContain("bad-one");
    expect(changes).toBe(1);
  });

  test("a ban stops the player uploading and hides their Prefabs; an unban brings them back", async () => {
    const admin = await sessionOf(ADMIN);
    const bad = await sessionOf(BAD);
    const other = await sessionOf("76561199000000042");
    expect(
      (await banUploader(post(`/api/prefab-bans/${BAD}`, "PUT", other), deps(), BAD)).status,
    ).toBe(403);
    expect(
      (await banUploader(post(`/api/prefab-bans/${BAD}`, "PUT", admin), deps(), BAD)).status,
    ).toBe(200);
    expect(await states()).toEqual({ "bad-one": "taken-down", "bad-two": "hidden" });
    expect((await prefabList(t.db)).map((c) => c.slug)).not.toContain("bad-two");
    expect((await uploadPrefab(uploading({ name: "Bad three" }, bad), deps())).status).toBe(403);
    expect(
      (await banUploader(post(`/api/prefab-bans/${BAD}`, "DELETE", admin), deps(), BAD)).status,
    ).toBe(200);
    expect(await states()).toEqual({ "bad-one": "taken-down", "bad-two": "live" });
    expect((await prefabList(t.db)).map((c) => c.slug)).toContain("bad-two");
  });

  test("the admin gives a player their own hourly limit, and can put them back on the default", async () => {
    const id = "76561199000000043";
    const url = `/api/prefab-limits/${id}`;
    const admin = await sessionOf(ADMIN);
    const them = await sessionOf(id);
    const set = (perHour: unknown, cookie = admin) =>
      limitUploader(
        new Request(SITE + url, {
          method: "PUT",
          body: JSON.stringify({ perHour }),
          headers: { cookie, origin: SITE, "content-type": "application/json" },
        }),
        deps(),
        id,
      );
    const left = async () =>
      ((await (await uploadQuota(uploading({}, them), deps())).json()) as { left: number }).left;
    expect(await (await limitUploader(post(url, "GET", admin), deps(), id)).json()).toEqual({
      steamId: id,
      perHour: 5,
      own: false,
    });
    expect((await set(25, them)).status).toBe(403);
    for (const bad of [0, 2.5, "25", 1001]) expect((await set(bad)).status).toBe(400);
    expect(await (await set(25)).json()).toEqual({ steamId: id, perHour: 25, own: true });
    for (let i = 0; i < 6; i++)
      await uploadPrefab(
        uploading({ name: `Sign ${String(i)}`, file: cubesFile(2) }, them),
        deps(),
      );
    expect(await left()).toBe(19);
    expect(await (await set(6)).json()).toMatchObject({ perHour: 6 });
    expect(await left()).toBe(0);
    const refused = await uploadPrefab(uploading({ name: "Sign 7" }, them), deps());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      limit: 6,
      nextAt: new Date(NOW + HOUR).toISOString(),
    });
    expect(await (await limitUploader(post(url, "DELETE", admin), deps(), id)).json()).toEqual({
      steamId: id,
      perHour: 5,
      own: false,
    });
    expect(await left()).toBe(0);
  });

  test("the admin can't ban themselves", async () => {
    const admin = await sessionOf(ADMIN);
    expect(
      (await banUploader(post(`/api/prefab-bans/${ADMIN}`, "PUT", admin), deps(), ADMIN)).status,
    ).toBe(400);
  });
});

describe("the ping to the Prefabs channel", () => {
  const ping: PrefabPing = {
    slug: "park-bench",
    name: "Park bench",
    pieces: 28,
    tags: ["Decoration", "Scenery"],
    uploader: { steamId: UPLOADER, name: "Uploader on Steam" },
    picture: new Uint8Array([0x89, 0x50]),
  };

  test("shows the picture and links the page, the take-down and the ban", () => {
    const { embeds, components } = pingOf(ping);
    expect(embeds).toEqual([
      {
        title: "Park bench",
        url: "https://ballestrecords.com/prefab/park-bench",
        description: "by Uploader on Steam · 28 pieces · Decoration, Scenery",
        image: { url: "attachment://prefab.png" },
      },
    ]);
    expect(components[0].components.map((b) => [b.label, b.url])).toEqual([
      ["Open", "https://ballestrecords.com/prefab/park-bench"],
      ["Take down", "https://ballestrecords.com/prefab/park-bench?admin=take-down"],
      ["Ban uploader", "https://ballestrecords.com/prefab/park-bench?admin=ban"],
    ]);
  });

  test("without a picture, the embed has none", () => {
    expect(pingOf({ ...ping, picture: null }).embeds[0]).not.toHaveProperty("image");
  });
});

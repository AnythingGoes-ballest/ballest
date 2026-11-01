// Signing in from the game (lib/auth.ts signInFromGame, lib/steam-ticket.ts, ADR 0016): a
// Steam ticket in, a game token out for the Prefab API only, with a stand-in for Steam's
// AuthenticateUserTicket.
import { expect, test } from "vitest";

import {
  GAME_SESSION_SECONDS,
  prefabSessionOf,
  sessionOf,
  signInFromGame,
  type AuthEnv,
} from "../lib/auth";
import { APP_ID, AUTHENTICATE, GAME_IDENTITY } from "../lib/steam-ticket";
import { ENV, ID, NOW, SITE, gameToken, signIn, steamTicketIs } from "./session";

const TICKET = "14000000aabbccdd00112233";
const GAME: AuthEnv = { ...ENV, steam: steamTicketIs(ID), steamKey: "test-key" };

/* POST /api/auth/steam/ticket as the game sends it: no cookie, no Origin */
const ticketIn = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(SITE + "/api/auth/steam/ticket", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/* a request to the Prefab API carrying `token` as the game sends it */
const withBearer = (token: string, cookie = "") =>
  new Request(SITE + "/api/prefabs", {
    headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) },
  });

test("a ticket Steam accepts answers the player's Steam ID and a token the Prefab API takes", async () => {
  const asked: Array<string> = [];
  const r = await signInFromGame(ticketIn({ ticket: TICKET }), {
    ...GAME,
    steam: (url, init) => {
      asked.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      return steamTicketIs(ID)(url, init);
    },
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.getSetCookie()).toEqual([]);
  const { id, token, expiresIn } = (await r.json()) as {
    id: string;
    token: string;
    expiresIn: number;
  };
  expect(id).toBe(ID);
  expect(expiresIn).toBe(GAME_SESSION_SECONDS);
  expect(prefabSessionOf(withBearer(token), ENV)).toBe(ID);
  // Steam is asked about this ticket, for this game, made out to the Prefabs plugin only
  const q = new URL(asked[0]).searchParams;
  expect(asked[0].startsWith(AUTHENTICATE)).toBe(true);
  expect(Object.fromEntries(q)).toEqual({
    key: "test-key",
    appid: APP_ID,
    ticket: TICKET,
    identity: GAME_IDENTITY,
  });
  expect(GAME_IDENTITY).toBe("ballest-plugin:prefabs");
});

test("the game's token works only on the Prefab API, and only as a bearer; a cookie never as one", async () => {
  const token = await gameToken();
  const { session } = await signIn();
  // not as the browser's cookie: the skin, the Discord link and the admin read sessionOf
  expect(sessionOf(withBearer(token), ENV)).toBeNull();
  expect(sessionOf(withBearer("", `ballest-session=${token}`), ENV)).toBeNull();
  // and a browser's cookie value can't be sent as a game token
  expect(prefabSessionOf(withBearer(session), ENV)).toBeNull();
  expect(token).not.toBe(session);
  // the Prefab API still takes the browser's cookie when no token is sent
  const browser = new Request(SITE + "/api/prefabs", {
    headers: { cookie: `ballest-session=${session}` },
  });
  expect(prefabSessionOf(browser, ENV)).toBe(ID);
});

test("the game's token lasts a day", async () => {
  const token = await gameToken();
  const at = (s: number) => ({ ...ENV, now: NOW + s * 1000 });
  expect(prefabSessionOf(withBearer(token), at(GAME_SESSION_SECONDS - 1))).toBe(ID);
  expect(prefabSessionOf(withBearer(token), at(GAME_SESSION_SECONDS))).toBeNull();
  expect(GAME_SESSION_SECONDS).toBe(86_400);
});

test("a ticket Steam refuses signs nobody in, with Steam's reason", async () => {
  // Steam's error for a made-up ticket, as its errordesc read on 2026-10-30 through the MK
  // Mushroom Cup hiscores server, which passes it on
  const refused: typeof fetch = () =>
    Promise.resolve(Response.json({ response: { error: { errordesc: "Invalid parameter" } } }));
  const r = await signInFromGame(ticketIn({ ticket: TICKET }), { ...GAME, steam: refused });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "Steam didn't accept the ticket: Invalid parameter" });
  // nor does an answer that isn't OK, or names no Steam ID
  for (const params of [
    { result: "Invalid ticket", steamid: ID },
    { result: "OK", steamid: "not-an-id" },
  ]) {
    const odd: typeof fetch = () => Promise.resolve(Response.json({ response: { params } }));
    expect(
      (await signInFromGame(ticketIn({ ticket: TICKET }), { ...GAME, steam: odd })).status,
    ).toBe(401);
  }
});

test("Steam unreachable, or refusing the site's key, is Steam's fault, not the player's", async () => {
  // a key Steam doesn't know: HTTP 403, as Steam answered key=0 on 2026-10-30
  const badKey: typeof fetch = () => Promise.resolve(new Response("Forbidden", { status: 403 }));
  const down: typeof fetch = () => Promise.reject(new Error("offline"));
  for (const steam of [badKey, down]) {
    const r = await signInFromGame(ticketIn({ ticket: TICKET }), { ...GAME, steam });
    expect(r.status).toBe(502);
    expect(r.headers.getSetCookie()).toEqual([]);
  }
});

test("something that isn't a ticket is refused before Steam is asked", async () => {
  let asked = 0;
  const steam: typeof fetch = (url, init) => {
    asked++;
    return steamTicketIs(ID)(url, init);
  };
  for (const body of [{}, { ticket: 5 }, { ticket: "not hex" }, { ticket: "ab" }, "{", null])
    expect((await signInFromGame(ticketIn(body), { ...GAME, steam })).status).toBe(400);
  expect(asked).toBe(0);
});

test("past the address's limit Steam isn't asked; something that isn't a ticket doesn't count", async () => {
  let asked = 0;
  let counted = 0;
  const env = (left: boolean): AuthEnv => ({
    ...GAME,
    steam: (url, init) => {
      asked++;
      return steamTicketIs(ID)(url, init);
    },
    allowGameSignIn: () => {
      counted++;
      return Promise.resolve(left);
    },
  });
  const r = await signInFromGame(ticketIn({ ticket: TICKET }), env(false));
  expect(r.status).toBe(429);
  expect([asked, counted]).toEqual([0, 1]);
  expect((await signInFromGame(ticketIn({ ticket: "nope" }), env(true))).status).toBe(400);
  expect([asked, counted]).toEqual([0, 1]);
  expect((await signInFromGame(ticketIn({ ticket: TICKET }), env(true))).status).toBe(200);
  expect([asked, counted]).toEqual([1, 2]);
});

test("any other Authorization, a preview's Basic, leaves the cookie to say who it is", async () => {
  const { session } = await signIn();
  const basic = new Request(SITE + "/api/prefabs", {
    headers: { authorization: "Basic dXNlcjpwYXNz", cookie: `ballest-session=${session}` },
  });
  expect(prefabSessionOf(basic, ENV)).toBe(ID);
});

test("with no secret or no Web API key configured, nobody signs in from the game", async () => {
  for (const env of [
    { ...GAME, secret: undefined },
    { ...GAME, steamKey: "" },
  ]) {
    const r = await signInFromGame(ticketIn({ ticket: TICKET }), env);
    expect(r.status).toBe(503);
  }
});

test("another site's page can't post a ticket", async () => {
  const r = await signInFromGame(
    ticketIn({ ticket: TICKET }, { origin: "https://evil.example" }),
    GAME,
  );
  expect(r.status).toBe(403);
});

test("an altered, foreign or future token is nobody, even beside a good cookie", async () => {
  const token = await gameToken();
  const [, issued, , sig] = token.split(".");
  for (const bad of [
    token.replace(ID, "76561198008697958"),
    `${ID}.${String(Number(issued) + 1)}.game.${sig}`,
    `${ID}.${issued}.${sig}`,
    `${ID}.${issued}.game.`,
    "garbage",
    "",
  ])
    expect(prefabSessionOf(withBearer(bad), ENV), bad).toBeNull();
  expect(prefabSessionOf(withBearer(token), { ...ENV, secret: "another" })).toBeNull();
  expect(prefabSessionOf(withBearer(token), { ...ENV, now: NOW - 120_000 })).toBeNull();
  // a bad token isn't rescued by the browser's cookie: what the game sent is what counts
  const { session } = await signIn("76561198000000001");
  expect(prefabSessionOf(withBearer("garbage", `ballest-session=${session}`), ENV)).toBeNull();
});

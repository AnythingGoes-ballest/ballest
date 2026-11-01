// Sign in with Steam as the routes see it (lib/auth.ts), with a stand-in for Steam's
// check_authentication: a test signs a browser in and sends its session cookie. Or the game
// signs in with a ticket, with a stand-in for AuthenticateUserTicket, and sends its token.
import { finishSignIn, signInFromGame, startSignIn, type AuthEnv } from "../lib/auth";

export const SITE = "https://ballestrecords.com";
export const ID = "76561198008697957";
export const NOW = Date.parse("2026-10-08T12:00:30Z");
export const ENV: AuthEnv = { secret: "s3cret", now: NOW, steam: steamSays("is_valid:true\n") };

export function steamSays(answer: string): typeof fetch {
  return () => Promise.resolve(new Response(answer));
}

/* Steam's AuthenticateUserTicket accepting a ticket as `id`'s. The body is the documented
   success shape (partner.steamgames.com/doc/webapi/ISteamUserAuth); the MK Mushroom Cup
   hiscores server reads the same `result` and `steamid` from real players' tickets. */
export function steamTicketIs(id: string): typeof fetch {
  return () =>
    Promise.resolve(
      Response.json({
        response: {
          params: {
            result: "OK",
            steamid: id,
            ownersteamid: id,
            vacbanned: false,
            publisherbanned: false,
          },
        },
      }),
    );
}

/* the game signed in as `id` through POST /api/auth/steam/ticket: its bearer token */
export async function gameToken(id = ID, env: AuthEnv = ENV): Promise<string> {
  const r = await signInFromGame(
    new Request(SITE + "/api/auth/steam/ticket", {
      method: "POST",
      body: JSON.stringify({ ticket: "14000000aabbccdd00112233" }),
    }),
    { ...env, steam: steamTicketIs(id), steamKey: "test-key" },
  );
  return ((await r.json()) as { token: string }).token;
}

/* the Set-Cookie headers of a response, by name */
export function setCookies(r: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of r.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    out[pair.slice(0, eq)] = c;
  }
  return out;
}
export const valueOf = (c: string | undefined) =>
  c?.split(";")[0].split("=").slice(1).join("=") ?? "";

/* a browser's request with `cookies` */
export const asking = (
  path: string,
  cookies: Record<string, string> = {},
  init: RequestInit = {},
) =>
  new Request(SITE + path, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
  });

/* start a sign-in from `next`, and come back from Steam having logged in as `id` */
export async function signIn(id = ID, env: AuthEnv = ENV, next = "/board/Map_Track13") {
  const started = startSignIn(asking("/api/auth/steam?next=" + encodeURIComponent(next)));
  const state = valueOf(setCookies(started)["ballest-signin"]);
  const login = new URL(started.headers.get("location") ?? "");
  const back = new URL(login.searchParams.get("openid.return_to") ?? "");
  const claimed = "https://steamcommunity.com/openid/id/" + id;
  for (const [k, v] of Object.entries({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": claimed,
    "openid.identity": claimed,
    "openid.return_to": back.toString(),
    "openid.response_nonce": "2026-10-08T12:00:00Zabc",
    "openid.assoc_handle": "1234567890",
    "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "c2ln",
  }))
    back.searchParams.set(k, v);
  const returned = back.pathname + back.search;
  const done = await finishSignIn(asking(returned, { "ballest-signin": state }), env);
  return { started, state, returned, done, session: valueOf(setCookies(done)["ballest-session"]) };
}

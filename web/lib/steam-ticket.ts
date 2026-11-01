// Sign in from the game (ADR 0016). A plugin in the player's running game asks the game's own
// Steam for a Web API ticket (ISteamUser::GetAuthTicketForWebApi) made out to GAME_IDENTITY,
// and the site hands it to Steam's AuthenticateUserTicket, which answers whose it is. The one
// thing taken from the answer is the Steam ID, as with the browser's sign-in (ADR 0008).
import { isSteamId } from "./rules";

export const APP_ID = "3339810";
/* the identity the plugin manager stamps on every ticket the Prefabs plugin asks for
   ("ballest-plugin:<plugin id>"): a ticket made out to any other service is refused, so one
   minted for another plugin's server can't sign in here */
export const GAME_IDENTITY = "ballest-plugin:prefabs";
export const AUTHENTICATE =
  "https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/";
/* a ticket as the game hands it over: hex, a few hundred bytes long in practice */
const TICKET = /^[0-9a-f]{16,5120}$/i;

export type TicketCheck =
  { ok: true; id: string } | { ok: false; status: 400 | 401 | 502; error: string };

/* whether `ticket` has a ticket's shape, so a request that can't be one is refused before it
   costs a sign-in or a call to Steam */
export const isTicket = (ticket: unknown): ticket is string =>
  typeof ticket === "string" && TICKET.test(ticket);

/* whose `ticket` is, by Steam's own answer under the site's Web API `key`; refused before
   Steam is asked when it isn't a ticket's shape */
export async function verifyTicket(
  ticket: unknown,
  key: string,
  check: typeof fetch = fetch,
): Promise<TicketCheck> {
  if (!isTicket(ticket)) return { ok: false, status: 400, error: "that isn't a Steam ticket" };
  const q = new URLSearchParams({ key, appid: APP_ID, ticket, identity: GAME_IDENTITY });
  let answer: AuthenticateAnswer;
  try {
    const r = await check(`${AUTHENTICATE}?${q}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { ok: false, status: 502, error: "Steam didn't answer" };
    answer = (await r.json()) as AuthenticateAnswer;
  } catch {
    return { ok: false, status: 502, error: "Steam didn't answer" };
  }
  const p = answer.response?.params;
  if (p?.result !== "OK" || !isSteamId(p.steamid))
    return {
      ok: false,
      status: 401,
      error: `Steam didn't accept the ticket${answer.response?.error?.errordesc ? `: ${answer.response.error.errordesc}` : ""}`,
    };
  return { ok: true, id: p.steamid };
}

interface AuthenticateAnswer {
  response?: {
    params?: { result?: string; steamid?: string };
    error?: { errordesc?: string };
  };
}

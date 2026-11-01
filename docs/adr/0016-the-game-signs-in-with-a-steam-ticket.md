# The game signs in with a Steam ticket

Status: proposed (2026-10-30), by AnythingGoes for the Prefabs plugin.

Players asked to browse, download and upload Prefabs from inside the game rather than the
site. A plugin for AnythingGoes's plugin manager does the reading signed out, like the
gallery: `GET /api/prefab-list` pages through it, 50 at a time by default, Popular or
Newest, by tag or by words, each entry what a Prefab's page shows beside its viewer plus a
small thumbnail (`/api/prefabs/<slug>/thumb`, 320 × 200, drawn like the share image) and its
file, which downloads as before (`/api/prefabs/<slug>/file`). The list never carries files,
so a page stays small however many Prefabs there are. Writing can't work that
way. Every write checks the Sign in with Steam cookie (ADR 0008, ADR 0009), which only a
browser that went through Steam's login page holds, and asking a player to copy a cookie
into a game is how sessions get stolen.

The player is already signed in to Steam in the running game, so the game proves who they
are instead. The plugin manager (host 0.26.0 and later) gives each plugin a Steam Web API
ticket of its own player (`Steam::RequestWebTicket`, ISteamUser::GetAuthTicketForWebApi),
made out to the identity `ballest-plugin:<plugin id>`, so a plugin can't mint a ticket for
another plugin's service. The plugin posts it to `POST /api/auth/steam/ticket`; the site
asks Steam's `ISteamUserAuth/AuthenticateUserTicket` with its Web API key, the game's app ID
and the identity `ballest-plugin:prefabs`, and takes only the Steam ID from the answer. It
answers a game token: the browser's signed session with `game` signed in too, good for a
day, which the game sends as `Authorization: Bearer`. Only the Prefab API's player routes
take it (`prefabSessionOf`: the bearer when there is one, else the cookie), so every Prefab
rule stays exactly where it was: no session, no write; an upload is credited to the
session's Steam ID; only a Prefab's uploader edits or deletes it. Everything else reads the
browser's cookie alone (`sessionOf`): a game token can't choose a Skin, link Discord, or take
down, ban or limit anything, even the admin's own, and neither kind passes as the other. A
browser never adds an `Authorization` header by itself, so another site can't borrow the
token the way it could a cookie, and the cross-site check stays for both.

This adds the site's first Web API key use: `STEAM_API_KEY` on Vercel. Without it, or
without `SESSION_SECRET`, the route answers 503 and the browser's sign-in is unchanged.
Anyone can post a ticket, and each one costs a call against the key's daily quota, so an
address may sign in 30 times an hour and everyone 2,000 (`db/hourly-limit.ts`; an IPv6 address
counts by its /64), counted only once the ticket has a ticket's shape and before Steam is
asked. The cap on everyone keeps the key under half its daily quota, but a flood can still
fill the cap and keep players out for the hour, so the key should not be the collector's
(the Refresh must never be the one stopped), and Vercel's firewall can add a per-IP limit in
front. A game token ends after a day, or with a new
`SESSION_SECRET`.

The game makes writing easy to script, so the writes that expire the cached Prefab reads are
held to 60 an hour per player (the same rolling-hour limit): every edit,
and every heart added or taken back; a heart that changes nothing costs nothing, and deleting
one's own Prefab, which happens once, is never held back. Reading costs little whatever
is asked: a page holds at most 100 entries and never a file; each size is read from a file
once and kept apart from the Prefab reads, since a file never changes after upload; a
thumbnail is drawn once per Prefab and edit, from its file read fresh (a cached read inside
another passes its tags out, so reading it through the Prefab reads would let every write
throw the drawing away), kept for days, and only at the address the list gives, any other
being sent there, so a new query string can't make it be drawn again.

## Considered Options

- A personal upload token made on the site and pasted into the plugin: no Steam key, but
  one more secret for players to handle and leak, and a table to keep them in.
- Open the site's Steam login in a browser from the game and hand the cookie back: needs
  a local redirect listener in the game and still ends in a copied cookie.
- The browser's own session value as the game's token: one format and one check, but a
  token copied out of the game would then be a year-long session good for everything,
  the admin's included.

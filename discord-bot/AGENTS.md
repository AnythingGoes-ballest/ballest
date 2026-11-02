# Multiballs (`discord-bot/`)

The unofficial Discord Match bot: TypeScript on Effect 3 with discord.js and steam-user
(ADR 0003; spec in issue #21, design summary in #20). Domain terms are in the root
`GLOSSARY.md`.

## Checking a change

`pnpm test` and `pnpm typecheck` here, and `pnpm check` at the repo root for formatting and lint
(`docs/linting.md`). The tests drive the whole Match engine through fake Steam and
Discord ports, SQLite in memory and Effect's TestClock, and the Discord Surface (where Cards,
Match Threads and the Footer go) over an in-memory channel. Every message the bot sends is built
in `messages.ts` from plain data; `test/messages.test.ts` checks each one's buttons and pings, so
a new button or post gets a case there. The discord.js calls (`client.ts`, `channel.ts`,
`interactions.ts`) are checked by running the bot against the test server, in the sandbox below.

Every image the bot posts is drawn by `src/render/` (Satori and resvg, fonts from
`@fontsource`); `pnpm render:samples` writes each one as a PNG to `.logs/samples/` to check by
eye against the design prototype on branch `claude/prototype-discord-bot-surfaces`.

The real Steam adapter is tested only where it recovers: `test/steamSession.test.ts` drives
`src/steam/session.ts` over a fake steam-user client to check it logs on afresh once Steam stops
answering. `pnpm smoke:steam` runs it against live Steam with the
bot account's secrets, and is the check to run after changing `src/steam/`;
`pnpm smoke:steam-outage` does the same with a client that stops hearing Steam's replies, and
passes once the session has logged on afresh and read again (a few minutes). Steam drops
leaderboard replies when requests overlap, so `src/steam/session.ts` sends them strictly one at
a time; keep it that way.

## Running it

`pnpm dev` runs the bot for iterating, from any checkout: it uses the main checkout's `.env`
(the "Multiballs (dev)" app on the test server), its own database in `.logs/dev.sqlite`, and
writes its log to `.logs/bot.log`, emptied at each start. Grep that file for what happened.

Every local run is the dev app on the test server: `pnpm dev`, or `pnpm smoke:steam` for the
Steam adapter. Production lives only on Fly (below): change it by merging to `main`, inspect it
with `fly status -a multiballs` and `fly logs -a multiballs`, and bring it back with
`fly machine restart -a multiballs`. A local copy logged in as the production app answers every
click alongside Fly, so a checkout never holds production's token or starts production, not even
to restore it while it is down.

One copy runs per home channel on a machine: a second start stops with "already running (pid
N)". Stop the running copy by that pid before starting another. On Windows, stopping a background
shell leaves its Node process running.

## Venues

One process plays in every Venue (GLOSSARY.md, spec #315): a server, its Match channel and its
@Multiplayer ping role. The home Venue, the game Discord, is `DISCORD_GUILD_ID`,
`DISCORD_CHANNEL_ID` and `DISCORD_PING_ROLE_ID`, and its name is `home`. Every other server the
bot is in is a Venue it set up itself (spec #321, `src/venues.ts`), named by the server's id,
which is the key stored on its Matches.

A server becomes a Venue by inviting the bot. The production app is private, so only Will can
invite it, and any server it is invited to becomes a Venue. The invite link is

```
https://discord.com/oauth2/authorize?client_id=<DISCORD_APPLICATION_ID>&scope=bot%20applications.commands&permissions=326686198800
```

(scopes `bot applications.commands`; permissions `326686198800` are the channel permissions the
bot checks for, Mention @everyone, @here and All Roles, Manage Roles and Manage Channels).

Which servers are wanted (`makeVenueJoiner` in `src/venues.ts`, kept in SQLite's
`known_servers`): on the first start of this build, every server the bot is already in (other
than home) and joined before `VENUES_SINCE` (2026-10-22 00:00 UTC, or at an unknown time) is
recorded as known but not wanted, so a deploy never adds a channel to a server nobody invited it
to; one it joined since then (invited by hand that day) is wanted. To make one of those a Venue, remove the bot there and invite it again.
From then on any other server is wanted: one that invites it while it runs (the Guilds intent's
guild create event), one the bot finds at startup or at a retry without knowing it (invited
while it was down or starting), or a not-wanted one it joined after the baseline was taken
(removed and invited again while it was down). Servers recorded under a build that kept no
baseline time keep what they were recorded as; the time is filled in as that start's, so only a
later rejoin counts.

**The running Venues are fixed for the life of the process, and home never waits on the
others.** At startup home is checked; then each wanted server with a stored Venue whose channel
and role are in discord.js's cache is checked from the cache alone (no Discord calls), and those
are the guests that run. Home's Surface starts first, then the guests' side by side, each in the
background: the engine waits on one at most 30 seconds, and a slower one runs once it is up.
Each try may take a minute; past that it counts as failed, though what it was doing (its Footer's
post, the write of its id) runs on, never interrupted. One whose Footer can't be put right (it
can't be posted, or an old one can't be deleted) or that takes too long is left out, ops told
once, and tried again in place every five minutes, with no setup and no restart. A guest is
offered (clicks answered, listed in the Activity) only once its Footer is up; until then a click
there gets "Multiballs is being repaired in this server, try again in a few minutes." Everything that needs Discord calls runs in the background
once that is under way: setting up a new server, or repairing one (a deleted channel or role, a
channel deleted while the bot runs), each with a 30-second limit (a setup past it runs on, never
interrupted, and a retry skips its server till it ends, so it can't make a second channel). It runs 20 seconds
after startup, every five minutes, and when Discord says a server is available again. Once a
server sets up, and when a running Venue's server (broken or not) removes the bot, the bot
restarts (`src/restart.ts`); a retry before that restart sets the server up again, which
changes nothing, and asking again joins the restart already asked for. The
restart waits until the app is fully up (home's Footer, recovery, interactions) and has run a
minute; then its scope closes, every finalizer running, and it exits 0 (after 20 seconds it exits
anyway); Fly's `[[restart]] policy = "always"` brings it back, and `pnpm dev` just exits. So an
invite or a fixed permission means a quick restart, about 30 s, and live Matches carry on through
the engine's restart recovery. A brake kept in SQLite (`venue_restarts`) allows at most three such
restarts in any hour; one beyond that is logged and waits for the hour's first to age out, so a
server whose availability flaps can't keep the bot restarting. Re-authorizing an invite with more
permissions fires no event; the five-minute retry picks it up. The bot listens for invites,
removals and outages before startup, so none is missed while it starts.

Ops hears each kind of failure once per server, not at every retry: a missing permission, a
Discord error by its code (50001 Missing Access), Discord down (any 5xx), a timeout, a bug
("setting it up failed (see the log)"); a server that removes the bot is forgotten, so its next
failure is news. No ops alert is ever waited on: posts queue up and one background fiber sends
them in order, each with a 10-second limit; when the bot stops, the post under way is finished
and what is still queued gets five seconds. Each setup asks only for what it does: Manage Channels to make the channel, Manage
Roles to make the role or set a reused channel's overwrites.

The bot sets a wanted server up:

- **Channel:** a text channel named `multiballs`, reused if there is one, else created. @everyone
  is denied Send Messages (members talk in Match Threads), and the bot's own member is allowed
  every permission it checks for.
- **Role:** a role named `Multiplayer ping`, reused if there is one below the bot's highest role,
  else created, mentionable (Discord puts a new role below the bot's, so it can manage it).
- **Stored:** the ids go in SQLite's `venues` table. At each start a stored Venue whose channel or
  role is gone is set up again the same way; one with both still there is left as it is.

Where each guest stands (starting, up, or broken) is kept in one place, `src/guests.ts`, which
clicks, the Activity and the retry all read. Then it is checked as home is. A guest Venue whose channel is deleted while the bot runs
(Discord's Unknown Channel, told to ops once) is broken, the only way one breaks: it is no longer
offered (as above), and
the retry, which no longer counts it as running, repairs it within five minutes and restarts the
bot to run it, under the brake. Home logs the same and runs, as it always has. A server that removes the
bot keeps its row, so inviting it again picks it back up.
The setup rules are tested on a fake server behind the `SetupGuild` port (`test/venues.test.ts`);
`src/discord/setupGuild.ts` is the port on discord.js, checked live by inviting the dev app to a
second server while `pnpm dev` runs. The sandbox sets no server up and ignores joins
(`MULTIBALLS_SANDBOX`), so it and `pnpm dev` never both set one up.

Each Venue has its own Footer, Cards and Match Threads (a `venue_layouts` row each, behind the
router in `src/discord/surface.ts`), its own queue (a Match's `venue`), its own ping role and its
own ping-offer answers. Links, Chosen Skins, the Steam session and "one Match at a time" are
shared. Clicks are handled in the Venue they came from; anywhere else they get "Multiballs only
works in its own channel." The Daily Report, Daily Posts, #new-tracks and ops stay home's only.
The Activity serves every running Venue: opened in a Venue's server it shows and opens that
Venue's Matches only, linked into its channel (#317).

Each Venue is checked as it starts: its channel permissions, and its ping role. Home failing a
check stops the bot, as before; a server the bot can't set up (it lacks Manage Channels or Manage
Roles, say) or whose Venue fails a check is left out, and tried again as above. A Match open in a Venue that isn't running still runs to its Result and is stored,
unseen, but keeps none of its Players Busy (the Surface port's `runs`). Each channel denies Send
Messages to `@everyone` to stay read-only, so the bot needs an explicit Send Messages allow on
it: in a Venue it set up, its own overwrite; in home, set by hand on the bot's role.

The ping role (Lobby pings, spec #87) is a different role for the dev app's test server and for
production; set `DISCORD_PING_ROLE_ID` in the main checkout's `.env` and in `fly secrets`. In
each Venue the role must exist, the bot needs Manage Roles with its own role above @Multiplayer
ping, and the role must be mentionable or the bot allowed to Mention @everyone, @here and All
Roles (a role the bot made is mentionable). That is the only role the bot ever adds or removes
(`src/discord/pingRole.ts`, behind the `PingRole` port), and `src/pings.ts` is the one place both surfaces go through for it; its words
are in `src/pingWords.ts`.

## The sandbox: driving the bot on the test server

`pnpm sandbox` runs the real bot on the dev app in a channel of its own, with two swaps: the
tests' fake Steam (any profile links, as `fake-<name>`, and times are set on demand), and a
driver on `127.0.0.1:8741` that clicks buttons, picks and submits forms as any member. Discord
lets only people press an app's buttons, so the driver hands `interactions.ts` a stand-in
Interaction (`scripts/sandbox/driver.ts`): everything from there inwards runs as for a real click,
and what the bot answers privately comes back to the caller. A fresh database each start; log
in `.logs/sandbox.log`. It leaves clicks in other channels alone, so it runs beside `pnpm dev`.

`pnpm --silent devserver` is how an agent uses it (`--silent` keeps pnpm's echo out; AXI style: run it bare for the state of things, every answer
ends with next steps). It reads as the Admin app ("Multiballs Dev Server Admin"), `ADMIN_DISCORD_TOKEN` in the
dev `.env`, which sees the channel and Match Threads as a member does:

```
pnpm --silent devserver sandbox create                # once: a channel the bot can post in
pnpm --silent devserver sandbox start                 # the bot in the background, back once logged in
pnpm --silent devserver press "New Match" --as admin  # labels: the last private answer, the channel, its threads
pnpm --silent devserver read                          # the channel; `show <id>` saves its images to read
pnpm --silent devserver time <match> 18.2 --as admin  # a finished run, read on the engine's next poll
pnpm --silent devserver wait "Go!" --in <thread>
pnpm --silent devserver steam down                    # every fake Steam read fails until `steam up`
pnpm --silent devserver sandbox stop                  # then `sandbox delete`
```

It works the rest of the test server too, by channel name: `channels` lists them (loose ones,
outside every category, are leftovers to tidy), `ops` reads #ops, where the bot's alerts land
(production's included), `post` and `variants` post as the Admin app without pinging anyone (a
design round of a bot post is one `variants <channel> A=a.png B=b.png --title ...`, one link per
variant for Will), `channel create|delete` and `webhook <channel> <name> --out <file>` make what a
feature needs, the webhook's URL only ever in that file.

Without `ADMIN_DISCORD_TOKEN` it reads with the dev bot's token: its own messages only, and no
sandbox setup. `--as` takes a member id, `admin`, or a name; pinging a member pings them for
real, so play as `admin` and members who expect it.

It needs a machine that reaches Discord with the dev app's tokens: a cloud thread does (the cloud
environment holds them), and so does Will's PC, through Remote Control, when it can't. The bare
`pnpm --silent devserver` says which: its `as:` line, or that discord.com didn't answer. The Admin app is
set up once. In the Developer Portal it has the Message Content
intent (to read other bots' posts) and the Server Members intent (for `devserver members`), and it was
invited to the test server with Administrator, so it can make and delete channels. To make it
private, set Installation → Install Link to None before turning off Public Bot; Discord refuses
the other order. The `discord-sandbox` skill is the run, step by step.

What to check where: Match rules in `test/engine.test.ts`, what lands in the channel in
`test/surface.test.ts`, each message's buttons and pings in `test/messages.test.ts`, and the
discord.js calls (what Discord actually renders, threads, pings, edits) in the sandbox.

## Chosen Skins

A player's Chosen Skin (GLOSSARY.md, spec #276) replaces their hue marble in every image the
Renderer draws and in Match Thread lines; the bot reads no Ghosts, so its order is Chosen Skin,
then hue. `src/chosenSkins.ts` reads `chosen_skins` at `DATABASE_URL` at most once a minute;
with no database (`pnpm dev`, the sandbox) or one it can't read, everyone keeps their hue. Run
the sandbox with `DATABASE_URL` set to a local database to see picks. The engine reads the
`ChosenSkins` port as it builds each Card view and thread post, which carry their Players' Skins
(`skins` on a `CardView`, `skin` on a post about one Player), so a redraw draws exactly what the
post brought; the Link confirmation and the Daily Report read them as they build their image.
`SkinPictures` (`src/render/skins.ts`) reads the pictures once at startup for the Renderer,
`Marbles` and the Activity, which serves them at `/skins/` beside its fonts and draws a Player's
Chosen Skin from what its API sends (`skins` on a Match view, `skin` on the viewer's Link, the
Challenge picker and the Link preview). The Skin list and its
pictures are copies of the site's (`src/render/skinList.ts`, `assets/skins/`, made by
`scripts/skin_pngs.py`), since resvg reads no WebP and the Fly image is built from
`discord-bot/` alone; `test/skins.test.ts` holds them to `web/lib/skins.ts`. `Marbles` uploads
one application emoji per Skin (`skin_<name>`) at startup beside the hue marbles.

`test/chosenSkins.test.ts` reads a throwaway database on the Postgres at `TEST_DATABASE_URL`
(default the local one), migrated by `web/scripts/migrate.mjs`, so `pnpm test` needs Postgres
running and `pnpm install` in `web/` too. `test/effectFnRule.test.mjs` runs the lint rule
`bot/effect-fn` through ESLint's RuleTester, whose ESLint and typescript-eslint come from the
repo root, so it needs `pnpm install` at the root as well; `bot.yml` gives CI all three.

## The Activity

`src/activity/` is a Discord Activity (spec #46): the same Matches in a page Discord shows in an
iframe, from Link Steam to the live standings and the Result. `api.ts` is an HTTP API over the
Engine, tested in `test/activity.test.ts` like the engine tests. `/api/config` lists the running
Venues' servers; the page refuses any other, and names its server in the `x-discord-guild`
header of every request (`GUILD_HEADER`; one without it, from a page loaded before Venues, is
home's). The API serves that Venue: it checks the member is in that server, names Players as
that server does, and lists, opens, links and pings that Venue's only, answering another Venue's
Match as not found. Links, Chosen Skins and Busy are shared (Busy by the engine's `isBusy`, which
skips a Venue that isn't running). `auth.ts` swaps the SDK's OAuth code for an
access token and holds the ports for Discord sign-in and server members. `server.ts` serves the
page, its fonts from `@fontsource`, each Map's Workshop preview (from `src/previews.ts`) and
each Skin's picture, because Discord's proxy blocks every other host. The page arrives with its
config and the signing-in screen in it, and its script named by its hash and sent compressed.

The page (`web/`) is React with TanStack Query, bundled by esbuild at startup from `main.tsx`.
`session.ts` signs in and signs in again after a 401 (no token outlives the page); `client.ts` is
the API; the board (`/api/me` with `/api/matches`) is one query polled every two seconds, and
each member's action one mutation at a time, after which the board is read again. `nav.ts` turns
each board and each press into which Match is on screen (the lock, watching, a Result staying
up, Go!), and is pure and tested (`test/activityNav.test.ts`, `test/activitySession.test.ts`);
`ui/` only draws it. The visual reference is the prototype on branch
`claude/prototype-activity-surfaces`.

The Activity's art in the Developer Portal (the app icon, and the cover and grid-view background
under Activities -> Art Assets) is drawn by `src/render/` too: `pnpm render:activity-art` writes it
to `assets/activity/`, with a DEV-tagged icon and cover for the dev app in `assets/activity/dev/`.
The PNGs are committed; upload them by hand after changing them.

The channel and the Activity show the same Matches, so what they say comes from one place, and a
change there reaches both: the Board Slab's rows and a Match's words from `src/present.ts`, every
PB's rank, gain and world record from `progress` in `domain.ts` (the engine posts exactly that),
marbles and Medals from `render/art.ts`, each Map's preview from `src/previews.ts`, and each
member's buttons from `actionsFor`. Test those in
`test/present.test.ts` and at the API; the surfaces only lay them out.

`pnpm activity:demo` (or the `activity-demo` launch config) runs the page and API on port 8740
over the tests' fake Steam, with no Discord: pick a member to sign in as, or add `?as=d-bob` for a
second tab (alice starts unlinked; paste `https://steamcommunity.com/id/alice`), and `?pip` for
the small view Discord's picture-in-picture window gets. Fake racers set
times once a Match is live. The page is bundled at startup, so restart the demo after editing it.

The bot serves it on `PORT` (default 8080) only when `DISCORD_CLIENT_SECRET` and
`DISCORD_APPLICATION_ID` are set; otherwise nothing listens. Trying it in Discord needs, in the
Developer Portal: Activities enabled, a URL Mapping from `/` to the server's public host, and the
OAuth2 client secret. Locally that host is a Cloudflare quick tunnel (`cloudflared`, installed
on the PC): `pnpm dev` opens one, prints its `*.trycloudflare.com` address, and closes it on
exit. The address is new every start, so the human pastes it into the dev app's URL Mapping for
`/` each time; tell them the address when you start the bot. Fixed addresses were tried and
dropped: ngrok's free plan shows browsers a warning page that renders as a blank Activity, and
the others needed a domain move or more setup than it was worth. A blank Activity means Discord
can't reach the page: no tunnel running, or the mapping still holding an old address. To see
exactly what Discord gets, fetch `https://<DISCORD_APPLICATION_ID>.discordsays.com/` with a
browser User-Agent: that is Discord's own proxy to the mapping. `pnpm dev` does this itself
after opening the tunnel and says when Discord serves the page, so the human relaunches the
Activity once it does. Fetching the tunnel's address
from Will's PC proves nothing either way: his home network (Xfinity Advanced Security) blocks
new hosts, and https to them fails with a TLS "wrong version number".
Production serves it at `https://multiballs.fly.dev` (`fly.toml`'s `http_service`), with
`DISCORD_APPLICATION_ID` and `DISCORD_CLIENT_SECRET` in `fly secrets` and the production app's
URL Mapping pointing there.

## The Daily Report

`src/report/` posts the Daily Report (spec #126, design on branch
`claude/prototype-daily-report`) in `STATS_CHANNEL_ID` at 16:00 UTC: the day, the counts and
Since yesterday in the channel with the standings as an image, and one link button under it,
"Where do I stand?", to the site's `/you` (spec #221), and the map lists and longest-standing
records in a thread on it. The image leads with the latest final Daily (headed "Yesterday's
Daily" when it is the day before, "Latest Daily" when older): its Map's preview as a banner,
fetched through `MapPreviews` (the stand-in art when Steam gives none), and its top 10. Overall
runs under it (spec #373), then Most Maps played, Most Author Medals, Most world records and Most
Daily wins, which replaced Most top 5s. The button and the message's Map links go to the live
site whatever `SITE_URL` says, so a sandbox post's button opens the real `/you`; the bot never
hears a press of a link button, and it never edits the message. The standings and the Daily come
from the site: it counts them and serves them at `GET /api/standings` (ADR 0011), which
`standings.ts` reads at `SITE_URL` (default the live site) with the baseline 24 hours before the
post, so the image's places are the site's shared places. The payload's `daily` side (the Daily
wins and the latest final Daily) is required, so the site must serve it before a bot that reads
it deploys. Everything else reads the leaderboard database at
`DATABASE_URL` (ADR 0006: plain SQL over the schema `web/` owns, in `source.ts`), and records are
dated from their ghost replays through the Steam Web API. A site or database that can't be read
fails that day's post, and ops hears. It is off unless `STATS_CHANNEL_ID` and `DATABASE_URL` are both set, so `pnpm dev` and
the sandbox never post it. Each posted day is recorded in SQLite (`daily_reports`); a bot that
was down at 16:00 posts once when it starts, and a day whose last Refresh is over 48 hours old
is skipped with a note to the ops channel, as is a post that fails.

What it says is pure and tested: the standings and the Daily (from a fake of the site's payload), lists and Since
yesterday in `report.ts` (`test/report.test.ts`), the words and the button in `messages.ts` (the
button in `test/messages.test.ts`), the schedule in `daily.ts` over fakes on the
TestClock (`test/daily.test.ts`). The SQL and the Discord REST calls are checked by posting one:

```
pnpm --silent devserver sandbox create
DATABASE_URL=postgres://postgres:postgres@localhost:5432/ballest_dev pnpm report
pnpm --silent devserver read --full
```

`pnpm report` posts the report now into the sandbox channel (or `--channel <id>`), skipping the
schedule's checks, and refuses any database but a local one. Its Workshop standings come from `SITE_URL`;
set it to a local `pnpm dev` of `web/` on the same database to have them agree with the rest. Fill a local Postgres with real
history by migrating it (`web/scripts/migrate.mjs`) and replaying `tools/db_backfill.py` into it
(`docs/data.md`); the database must be UTF-8.

In production the bot's role needs View Channel, Send Messages, Attach Files, Create Public
Threads and Send Messages in Threads in #stats-by-will, and `fly secrets` needs `STATS_CHANNEL_ID`
and `DATABASE_URL` (the collector's Neon URL).

## The Daily Post

`src/dailyPost/` posts each Daily's Daily Post (spec #268, design on branch
`claude/prototype-daily-post`) in `DAILY_CHANNEL_ID` (in `fly.toml`). From 01:00 UTC it asks the
developers' Daily API (`BALLEST_DAILY_URL` with the date appended, `BALLEST_API_KEY` in the
`BallestAPIKey` header; both secrets, never logged) every minute until today's Daily answers, then
posts its card, a Components V2 message with the Workshop screenshot attached, and a thread on it.
Every 15 minutes it reads the Daily's own Steam board (ranks 1 to 3 and the entry count, one
request through the bot's session) and edits the card only when what it shows changed; the first
read at or after the Daily's end is its last, and always turns the card into the result: "🏆 X
wins" (everyone on the fastest time shares it; a read sees only the top 3), the winning time and
player count, the final podium, the pictures and the lead graph drawn without "now", `Closed
<t:f> · final`, and the site button reading "Final board" for "Today's board", or "No winner"
when nobody set a time. A bot that was down at the close makes
that read as it starts. Each post is recorded in SQLite (`daily_posts`), so
a restart resumes the live one and never posts a date twice. Each read that changes the lead (its
time or who holds it) is recorded too (`daily_leads`, `lead.ts`): once the card shows it, with the
lead graph under the podium redrawn by `src/render/` (`leadGraphScene`), the thread gets a quiet
`-#` line for the first time, a steal (with how long the Reign it ended lasted), a tie, or the
leader improving their own time; several changes between two reads are one line, the latest. A
Components V2 message lists its files only in its components' `media` items, not under
`attachments`, so an edit that replaces the graph reads them from there to keep the rest. A failed read keeps the card; the API
failing, no Daily an hour after 01:00, and a post, thread or edit refused each reach ops once until
they clear. It is off unless all three settings are set and the bot has View Channel, Send
Messages, Embed Links, Attach Files, Create Public Threads and Send Messages in Threads there; then
it says why in the log and the bot runs on.

The spinning 3D GIF beside the podium (`spin.ts`) is drawn in GitHub Actions, since it needs a
browser with WebGL: as the card goes up, the bot starts the site repo's `daily-spin.yml` on `main`
for the Map (`GITHUB_DISPATCH_TOKEN`, a fine-grained token with Actions read and write on
`will-ness-ai/ballest` only), which stores the GIF in the leaderboard
database's `map_spins` (`docs/data.md`). Each read, it looks there (`DATABASE_URL`, plain SQL) and
edits the GIF in once one is drawn from the Map's current file or since it asked. A Map with no
`map_files` row gets no GIF and no run, and one already drawn from the same file is used without
a run. A run that fails tells ops itself at once, naming the Map (`daily-spin.yml`'s last step);
a run that can't be started, or no GIF an hour after asking, reaches ops once from the bot. The
card stays without it. Without both settings the card has no GIF. An edit that attaches a file names
every picture the card keeps, read from its components (a Components V2 message lists none under
`attachments`).

A Daily already over can be posted closed from the leaderboard database (`postPast` in
`schedule.ts`, used by `pnpm daily-post` below; at launch the bot backfilled the three Dailies
before its first this way, once). Its data is read by `history.ts` (plain SQL): the final board is
the Daily's open Entries, and the lead is rebuilt from its Score history, every score the board
held (closed ones included) from when its Ghost says it was set (`ghosts.set_at`, used only when it
falls after the last read before the Refresh that first saw it, and before that Refresh ended) or
else from that Refresh, until the same player's next score. A line timed by a Ghost reads like a
live one; one timed by a Refresh says `by the <t:…:t> Refresh`. The graph steps at those times,
clamped to the close. The SQL is tested against web/'s `tiny` dataset with more Daily rows
(`test/dailyHistory.test.ts`, the Postgres at `TEST_DATABASE_URL`, after `pnpm install` in
`web/`).

What the card says is pure (`card.ts`, `test/dailyPost.test.ts`), its layout and buttons are in
`messages.ts` (`test/messages.test.ts`), and the schedule in `schedule.ts` runs over ports on the
TestClock (`test/dailyPostSchedule.test.ts`). The real adapters (`live.ts`) are checked by posting
one: `pnpm daily-post <date>` posts that date's live card and thread into the sandbox channel (or
`--channel <id>`, never the production one) with the bot account's Steam session, and records
nothing. With `--close` it then keeps the card current as the schedule does until the Daily's
end, so a past date is posted and at once closed by the schedule's own final edit (no GIF, ops
warnings to the log only). With `DATABASE_URL` set to a local Postgres (it refuses any other)
holding that date's Daily, a past date is posted closed instead, from that database. Read it back
with `pnpm --silent devserver show <id> --in <channel>`, which lists and saves the files a
Components V2 card shows.

## The Traffic Report

`src/traffic/` posts the Traffic Report in the dev server's #search-analytics at 13:00 UTC, through
that channel's webhook (`TRAFFIC_WEBHOOK_URL`), apart from the ops channel. It has two halves, each
on only when its keys are set:

- Visits, yesterday, from the site's Plausible (`plausible.ts`: Stats API v1 at `PLAUSIBLE_URL`,
  in `fly.toml`, with `PLAUSIBLE_API_KEY` for `PLAUSIBLE_SITE_ID`, default `ballest.willness.dev`,
  the name the site's script reports under): visitors and pageviews against the week before, visit
  length, bounce rate, top pages and top sources.
- Google search, the newest final day Search Console has, about two days back (`searchConsole.ts`:
  the Domain property `sc-domain:ballestrecords.com`, read as a Google Cloud service account whose
  JSON key is `GSC_SERVICE_ACCOUNT` and which the property lists as a Restricted user): clicks,
  impressions, position, the top searches and pages, searches new against the 28 days before, and
  each sitemap's errors.

A half that can't be read (a revoked key, say) says so in the post and in the ops channel, and a
post that fails goes to the ops channel. A day counts against the mean of the seven before it, a
day Search Console has no row for counting as 0.
The schedule is shared with the Daily Report (`src/everyDay.ts`): a bot that was down at 13:00
posts once when it starts, and each posted day is recorded in SQLite (`traffic_reports`). What it
says and the schedule are tested in `test/traffic.test.ts`. `pnpm traffic` builds the report now
from whichever keys the environment has and prints it, and `pnpm traffic --post` posts it too,
recording nothing. Plausible's host answers Fly but not a cloud session.

## New tracks

`src/newTracks.ts` gets a new Workshop Map onto the site within minutes (spec #259). The game
Discord's #new-tracks (`NEW_TRACKS_CHANNEL_ID`, in `fly.toml`) gets a post from the HubUpdates app as each Map
goes up; a minute after a post the bot asks the collector's service on Fly to add them
(`POST /add-maps` at `COLLECTOR_URL`, in `fly.toml`: Fly's private network, no secret; ADR 0012),
and posts within that minute share the request. It never reads a post's words: the GuildMessages
intent only says one arrived, and the collector finds what is new (`docs/data.md`, "New Maps").
A request the collector refuses or can't take goes to the ops channel; a failed add reaches it
from the collector. It is off unless both
settings are set and the bot can view that channel, and then says why in the log; the bot runs on.
The batching is tested on the TestClock (`test/newTracks.test.ts`).

## My stats

`src/discord/myStats.ts` keeps `#my-stats` (spec #323): at startup the bot makes it in its server,
beside the Match channel, or at the top of the server `MY_STATS_GUILD_ID` names (production: Ballest
Racing, `fly.toml`), when it holds none or the one it made is gone, with `@everyone` denied
Send Messages, both Create Threads, Send Messages in Threads and Add Reactions, and the bot allowed
what the panel needs, and keeps one panel there with a **See my stats** button. Its id,
the panel's and the panel's fingerprint are in SQLite (`my_stats_channel`), so it is found by id and
admins may rename or move it; the panel is edited only when this build draws it differently, like
the Footer, and posted again if deleted. Presses there reach `interactions.ts` through
`Discord.answerIn`, as the home Venue's, ahead of the Venue lookup (`routeClick`), wherever its server is. Before making the channel it checks the bot holds every permission in
`NEEDED_TO_CREATE` where the channel will be, the Match channel's category or else the server
(in Ballest Racing, Add Reactions and Create Private Threads are beyond its invite's permissions)
(Discord refuses an overwrite, allow or deny, naming a permission the bot lacks): any missing is
named to the ops channel, and no channel is made without them. A channel already there needs
none of them, so it raises no alert. On any
other failure it tells the ops channel too, and the bot runs on. It is off in the sandbox, whose fresh database would make a channel at every start;
check the discord.js calls with `pnpm dev`, whose database lasts. The rules are tested over an
in-memory server in `test/myStats.test.ts`, the panel in `test/messages.test.ts`.

A press of See my stats is `src/seeMyStats.ts`. With a Stats Link in `stats_links` (GLOSSARY.md,
ADR 0014) the private answer is the Stat Card, fetched from the site at `SITE_URL` (default the
live site) as `/og/stats/<steamid>?v=<the site's /api/refreshed>`, with a Player page link and
"Not you? Pair again". Without one, or on Pair again, the bot writes a link request to
`stats_link_requests` (one insert, pruning those past a day: the only rows it writes in the
leaderboard database) and answers with a Sign in with Steam link to the site's
`/discord/link?t=<token>`; then it looks every 5 seconds for 14 minutes whether the request has
been used, and once it has, edits that answer into the card through the interaction's own token
(which lasts 15). A card the site can't draw answers "Couldn't draw your card, try again" and tells
the ops channel, at most once an hour (`CARD_ALERT_EVERY`), since a site outage fails every press;
with no `DATABASE_URL` (or one it can't read) the answer says stats aren't available. The Stats
Links share one `pg` pool, made at start, which connects only when a call needs it (giving up
after 5 seconds), so a database that can't be reached fails that press alone. The ops alert of a
failed draw is posted in the background, never holding up the member's answer. The site and
the database must be the same one's: for `pnpm dev` against a local database, set `SITE_URL` to a
local `pnpm dev` of `web/` on it. The rules run over fake ports on the TestClock in
`test/seeMyStats.test.ts`, the SQL against Postgres in `test/statsLinks.test.ts`, the answers'
buttons in `test/messages.test.ts`, and the clicks through `interactions.ts` in
`test/driver.test.ts`.

In production the bot's role needs, where #my-stats is made (the Match channel's category, or the
server), Manage Channels, Manage Roles, View Channel, Send Messages, Embed Links, Read Message
History, both Create Threads, Send Messages in Threads and Add Reactions (`NEEDED_TO_CREATE`).

## The Weekly Cup

`src/weeklyCup/` runs the Weekly Cup (GLOSSARY.md, spec #353) in each server `WEEKLY_CUP_GUILD_IDS`
names (comma-separated, `fly.toml`: Ballest Racing); unset, or in the sandbox, it is off. At
startup, in the background, it keeps `#weekly-cup` there (`channel.ts`): the stored one by id
(`weekly_cup_channels`), else a text channel of that name with the Match channel's overwrites set
(Manage Roles), else a new one with them (Manage Channels); a server it can't set up is told to
ops, and its Cup waits for the next start. Presses there reach `interactions.ts` through
`Discord.answerIn`, as #my-stats's do, never through a Venue's "being repaired".

The code is split by stage. `model.ts` holds the views, constants and ports (`CupChannel`,
`CupLinks`); `record.ts` the SQLite record (`CupLog`, one migration, `0016_weekly_cup`); `kit.ts`
what every stage shares (the lock, `attempt`, which tells ops once and retries in a minute, and
`show`/`enter`/`callOff`); `vote.ts` the draw and the vote; `race.ts` the reads, standings and
results; `presses.ts` the buttons; `slots.ts` how each view is kept on Discord; `messages.ts`
every Cup message. The two one-shots, never retried (the call-off notice and the Shortlist's
close), each tell ops every time under a kind of their own, so neither hides a later failure of
something that is. The migration was 0016-0019 before the Cup shipped: a local dev database
that ran those must be deleted, since the migrator skips the new 0016 there.

`schedule.ts` is one state machine per server, every boundary US Central (`week.ts`, through
`Intl`, so daylight saving holds): Monday 00:00 the week's post goes up (Components V2, with the
rules, the schedule as Discord timestamps and the Entrants; a skipped week's says only that) with Sign up, Withdraw and Skip this
week; Thursday 12:00 a week with fewer than 2 Entrants is cancelled (post redrawn, Entrants pinged
in a notice), else it moves to voting, Friday 09:00 to racing, Sunday 20:00 to final (sign-up
closes). Sign up needs a Link (an unlinked member gets Link Steam first, then is signed up); Skip
asks a member with Manage Server to confirm, only while the week is open, and pings its Entrants.
Every press is answered privately, for the week its button names: an earlier week's post says
it's over. Each week (`weekly_cups`) and its Entrants (`weekly_cup_entrants`, with when each
signed up) are in SQLite, and each step works from that and the clock, so a restart resumes
without posting again and acts at once on a boundary passed while it was down; a week the bot
first starts in after Thursday 12:00 gets no post, and an earlier week still racing (the bot was
down over its close) is finished as the bot starts. A failed post is retried every minute and a
failed edit at the next change, each told to ops once until it lands (OpsAlerts' `post` with a
key, and `forget`). Each one-time post (the week's post, the Shortlist, the Cup Maps, each part of
the results) goes with a nonce of its server, week and kind that Discord enforces (`sentOnce` in
`slots.ts`), so a send repeated after a restart is dropped, and its record is written straight
after it. Discord matches a nonce across every channel the bot posts in, which is why the server
is part of it. Each message is kept as one of four slots of the week's record (post, Shortlist,
standings, results: `weekly_cups.messages`): `CupChannel.show` posts a slot with no messages yet,
edits only the parts that change, posts or drops parts when a view takes more or fewer, and
reposts a slot whose message someone deleted (Unknown Message), handing back the ids it now has.
Sign up and Withdraw close at Sunday 20:00.

The Shortlist (Thursday 12:00) is the engine's Eligible Map search (`src/eligibleMaps.ts`, shared
with a Match's draw) with an author limit of 3:00, drawing until 10 Maps none of the Entrants
signed up by then has Played (their Links' Steam accounts) are found, at most 100 board checks.
It is recorded (`weekly_cup_maps`) before it is posted, so a restart or a refused post never draws
again; a Steam failure retries the draw each minute, ops told once; fewer than 10 make a shorter
Shortlist that says so, and none cancels the week. Its post is a Components V2 message: each Map's
Workshop picture (`MapPreviews`, attached as a thumbnail), its name linked to its page on
ballestrecords.com, its maker and author time, and a string select for up to 3. A vote
(`weekly_cup_votes`, the latest per Entrant) is Entrants' only and changeable until Friday 09:00,
and a pick after that is told the vote has closed. At Friday 09:00 the votes of the Entrants still
signed up are counted, the Shortlist shuffled and sorted by votes (so a tie falls at random), and
the top 3 recorded as Cup Maps with their ranks, votes and board ids before the announcement,
which lists them with their pages and pings the Entrants; a refused announcement is tried again
each minute with the same Maps. Once it is out, the Shortlist's post is edited to say "Vote
closed", without its select (best effort, ops told if refused; a Shortlist someone deleted is not
posted again).

Racing (Friday 09:00 to Sunday 20:00) reads each Cup Map every 5 minutes, one `readPlayers` call
per Map for the current Entrants' Links. Every Entrant has a bar (`weekly_cup_baselines`): their
PBs on the Cup Maps as racing opens (read once, before the announcement;
`weekly_cups.bars_at`), or, for one who signs up later, as they sign up (read before they are
added; Steam down refuses the sign-up, to try again). A time counts once it beats the bar, so
practice on the Shortlist during the vote counts not. Each counted best is kept
(`weekly_cup_times`) with when the Entrant's first counted time on that Map was seen, and when it
was set by its Ghost (`first_set_at`, `src/steam/ghosts.ts`); a PB set more than 30 minutes after
that is a Flag, timed between the two Ghosts when both give a date that could be their run's, else
between the reads that saw them (approximate, and the Flag says so), told to ops once per Entrant
per Map (`flagged`), and still counts. A failed read keeps that Map's
last times, ops told once until the reads land, and the next tick reads again.
`points.ts` ranks each Map (equal times share a place), pays the site's `trackPoints` (pinned by
`test/weeklyCupPoints.test.ts`, which imports `web/lib/rules.ts`), totals them and breaks a tie
on more Map wins. The live standings are a picture the Renderer draws (`cupStandingsScene`, from
`cupStandingsImage` in `src/weeklyCup/messages.ts`, with each Entrant's name in the server): a row
per Entrant with their place, points and Map wins, and each Cup Map's place. **Times stay secret
until the Cup ends**: the live picture shows a place alone ("#1"), and nothing posted in the
channel before the results (the picture, its words and alt text) holds an Entrant's time, which
`test/weeklyCupSlots.test.ts` checks over every pre-results post; ops' Flags keep theirs. The
standings are posted at the first read and edited only when they change (the slot compares what
it last drew, and draws the picture again only when what it shows changed); a picture that can't
be drawn fails the show, ops told, and the next read tries again. At Sunday 20:00 each Cup
Map's final read is recorded as it lands (`final_reads`), and a retry each minute while Steam
fails reads only the Maps still missing, up to 20:30, when those stand on their last reads; the
results, which say which Maps were read late or not at all, are posted once (their slot, recorded
as they go up) with the same picture, each time beside its place, and ping each Entrant once
(past 2,000 characters of mentions, in more messages). Then the live standings are edited to say
racing has closed and the results are below, their picture dropped.

The schedule runs over ports on the TestClock (`test/weeklyCup.test.ts`), the week in
`test/weeklyCupWeek.test.ts`, the channel over a fake server (`test/weeklyCupChannel.test.ts`),
the slots over a fake channel (`test/weeklyCupSlots.test.ts`), the post's buttons, the
Shortlist's vote and the standings' picture and words in `test/weeklyCupMessages.test.ts`, the points in

`test/weeklyCupPoints.test.ts`, and the presses and votes
through `interactions.ts` in `test/driver.test.ts` (the driver's `manageServer` press field stands
for Manage Server; a `select` press reaches a user or a string select by its custom id). The
discord.js calls (`live.ts`) are checked in the sandbox: `pnpm sandbox --cup` runs the Cup in the
test server's #weekly-cup on a clock `pnpm --silent devserver clock <time>` moves forward (so a week
plays out in minutes), `devserver run <map> <seconds> --as <member>` sets a time on any Map, and
`pnpm sandbox --cup --keep` restarts on the same database and clock, to check a restart resumes.
Its catalogue is twelve real Workshop Maps, so the Shortlist shows Steam's pictures.

## Production

Production is the "Multiballs" app on the community server, running on Fly.io (`fly.toml`,
`Dockerfile`). `.github/workflows/bot.yml` tests every PR and deploys every push to `main` that
touches `discord-bot/`; nothing else deploys, and no checkout holds production's secrets. They
live in `fly secrets`, and the repo holds only `FLY_API_TOKEN`, a deploy token for the one app
(`FLY_COLLECTOR_TOKEN` is the collector's, ADR 0012).
`.dockerignore` keeps `.env` and databases out of the image; keep it that way.

A deploy stops the old copy before starting the new one (one volume, one machine), and the
engine's restart recovery resumes live Matches. `src/ops.ts` pings Healthchecks.io every minute
(`HEALTHCHECK_URL`), which alerts the private `#multiballs-ops` channel when pings stop, and
posts there daily (`OPS_WEBHOOK_URL`) once the Steam refresh token has 30 days left (the Traffic
Report has its own channel, above); renew it
with `tools/steampy_mint.py` and `fly secrets set STEAM_REFRESH_TOKEN=...`. Logs: `fly logs`.
`.github/workflows/bot-cost.yml` posts a weekly cost estimate there for the bot and for the
collector's app (`scripts/cost_report.py`, once per app with that app's deploy token;
Fly has no billing API, so it prices what is provisioned with the rates in that script, and
reads payment health, billing status and card on file, from Fly's undocumented GraphQL API).
`.github/workflows/vercel-usage.yml` posts the site's Vercel plan and usage there on Mondays,
and whenever it nears a limit (`tools/vercel_usage.py`).

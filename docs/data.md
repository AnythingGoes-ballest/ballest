# The data

The collector writes every Refresh to Postgres on Neon, and the site reads only that. Until
phase 5 of `docs/nextjs-migration.md` the collector also committed its boards as JSON under
`data/`; that stopped, and the commit that removed `data/` ends its history. That history is
still the record of every score up to then: `tools/db_backfill.py` replays it (below).

## The database (ADR 0005)

Postgres on Neon: the only copy of the scores, and what the site reads. It holds only
what Steam reports, as Score history: no ranks and no derived boards. The schema is
`web/db/schema.ts` (Drizzle), and its migrations in `web/db/migrations/` are generated from
it with `pnpm db:generate` and applied by `pnpm db:migrate`, which `pnpm build` runs first,
so each Vercel deploy migrates the database it reads. Never edit a migration by hand.
Drizzle applies only migrations newer than the newest one a database holds, so the step
(`web/scripts/migrations.mjs`, which tests and CI use too) fails, changing nothing, on a
migration that isn't applied but sorts at or before that one, as one merged after another
branch's newer migration reached production would: regenerate it so it sorts last. A
preview reads production for now (below), so its build skips the migration: a branch's
schema reaches production when it merges, or earlier through `migrate.yml` (by hand, with
Will's OK; `docs/agents/feature-workflow.md`), and until then its preview fails on any page
that needs the new tables.

The database sits in a Neon organization that Vercel manages, not in anyone's own Neon
account, so it opens from Vercel: the `ballest` project's Storage tab, the database, then
Open in Neon.

- `refreshes`: one per collector Refresh, per Daily read (`GLOSSARY.md`; `source = 'daily'`),
  or per git snapshot replayed by the backfill (`source`, and `commit_sha` for a backfill),
  and `full_sweep`, whether its Workshop step read every Map's board. Everything that counts
  Refreshes or says when the boards were refreshed leaves the Daily reads out.
- `boards`: every Steam board, Tracks, Overall boards, each Map's, each Daily's and each
  Event board's, with its kind, Season, display name, leaderboard ID and whether it scores
  points. An Event board (`kind = 'event'`, `EVENT_BOARDS` in `tools/campaign_common.py`) is
  read by the Refreshes until one reads it ok (`read_events` over `events_due`, from the
  collector's memory), and
  never again, so its Entries are never closed. A failed one never fails the Refresh.
- `board_reads`: which boards each Refresh read and whether the read succeeded. A Map not
  read in a Refresh has no row, and that says nothing about play.
- `players` and `persona_history`: the current profile, and every persona with the first
  and last Refresh that saw it.
- `entries`: Score history. A row per score a player has held on a board, with the first
  and last Refresh that saw it and the Refresh that closed it. At most one open row per
  board and player (`entries_one_open`). An unchanged score moves only
  `last_seen_refresh`, and a player gone from a board that was read successfully is
  closed, never deleted. An Overall board (`scores_points`) keeps current points only: a
  changed score updates its open row in place, so its first-seen is when the player first
  appeared there (ADR 0005).
- `maps` and `map_history`: what a Map never changes (its board, creator, created time),
  and a row per change of its title, creator name, preview, Medals, sessions,
  subscriptions or entry count.
- `dailies`: one per Daily (`GLOSSARY.md`), by date: its board (`kind = 'daily'`, named
  exactly as the developers' API returns it), the Map's pfid (no foreign key: a Map can
  leave the Workshop) and title, its window (`starts_at`, `ends_at`), and
  `final_refresh`, the first Refresh that read the board ok at or after `ends_at`.
- `ghosts`: one per Ghost (`GLOSSARY.md`) the collector has read, by UGC ID: its state
  (`ok`; `empty`, a Ghost with no samples; `gone`, one Steam has no file for), the Skin
  and the hat as the object paths the Ghost names (raw, as `skinMaterial` and `accessory`
  write them, or for a Skin with no material, Snow Globe, its `?SpecialSkinClass`), the
  date the run was set (`set_at`), its top speed in km/h, its profile, and when it was
  read. The profile is the run's time in seconds at each eightieth of its own path length
  (80 numbers, `PROFILE_POINTS`), empty for a path with no length; the race drawer compares
  two of them. A Ghost never changes, so a row with a profile is final. An Entry's Ghost is
  its `ugc_id`; the boards draw the Skin (`docs/site.md`, "Ball skins").
- `map_files`: one per Workshop Map whose file the collector holds, by pfid (no foreign key:
  a Map can leave the Workshop): the file's `version` (Steam's content handle for it,
  `hcontent_file`, which changes with each update), its size before compression
  (`raw_size`), the file gzip-compressed (`gzipped`, bytes) and when it was read. Only the
  current version is kept (ADR 0010).
- `map_activity`: one per Workshop Map, by pfid (no foreign key to `maps`, as `map_files`): its
  Workshop plays over the last 7 days (`week_plays`, Steam's `playtime_stats` with
  `return_playtime_stats=7`) and its votes (`votes_up`, `votes_down`, and `vote_score`,
  Steam's own score, discounted for few votes: 0 with none), with the Refresh that wrote
  them (`refresh_id`), as of the latest catalogue that listed the Map. Each Refresh whose Workshop result is written overwrites the rows for
  the Maps its catalogue listed, and `add_maps` writes the ones it adds; a Refresh with no
  Workshop result leaves them. Not history: the plays move every Refresh, which would add a
  `map_history` row per Map each time. The homepage's Trending this week ranks by them
  (`docs/site.md`).
- `map_spins`: one per Map whose spinning GIF has been drawn for a Daily Post (spec #268), by
  pfid (no foreign key): the `map_files` version it was drawn from, the GIF (`gif`, bytes,
  about 4 MB) and when (`drawn_at`). Only the latest drawing is kept. Not the collector but
  `daily-spin.yml` writes it (ADR 0013: drawing it needs a browser with WebGL), started by
  Multiballs with a pfid (or by hand): `web/scripts/map-spin.ts` opens the Map's
  3D view on ballestrecords.com in Chromium with software WebGL, drags it one full turn in 160
  frames and encodes a 360 px GIF at 12.8 frames a second with ffmpeg. It refuses a Map with
  no `map_files` row. The bot only reads it (`discord-bot/AGENTS.md`, "The Daily Post"). To
  look at one without a database: `pnpm exec tsx scripts/map-spin.ts <pfid> --no-db --out
spin.gif` in `web/`.

### Ghosts

The Ghost step (`tools/ghosts.py`) runs after the database write, into the same database,
and never blocks or fails the run: an error is a warning. It reads the Ghost of every open
Entry in the top `TOP` (100) of each time board, Tracks, Maps and Dailies (Overall boards
have none), whose UGC ID has no `ghosts` row, best rank first, then those whose `ok` row
has no profile (rows read before profiles were kept, read once more and updated in place;
one whose file is now gone or empty keeps its skin and gets an empty profile), also best
rank first: `GetUGCFileDetails` with the
Web API key, then the file at the CDN URL it returns, which costs no quota. A few run at
once, and the step starts no read after `BUDGET` (four minutes) and keeps what it has read
(a read still going then can hold the run up by its own timeouts, not past them), so a backlog,
such as the first run's, is read over several Refreshes. A read that fails writes nothing
and is tried again next run, and the log counts the failures by error; Steam saying the
file is gone (an HTTP 404 whose body is `{"status":{"code":9}}`) is final. A Ghost
can name no Skin at all (`skinMaterial` and `?SpecialSkinClass` both "None", seen on a
few recent runs): it is `ok` with no skin, and the board draws the marble. When it wrote any
Ghost it revalidates the site again, since the boards draw them. It is skipped without
`STEAM_API_KEY` or a database, and with `--dev` writes only `DEV_DATABASE_URL`, as the
database step does.

The Ghost's `locations` and `velocities` are lists of `{x, y, z}` in cm and cm/s, one per
`elapsedTime` sample (~10 a second), and its `timestamp` reads `2026.09.28-22.48.51`, in
UTC, or a year-1 date when unset. Only the set date, the top speed and the profile come
from them; the path, the velocities, the checkpoint splits and the texture slider in
`ballerSkinPrefs` are not stored. Ghosts from
before about 2026-01 have no `?SpecialSkinClass`, and from before about 2026-07 no
`ballerSkinPrefs`.

### Map files

The Map file step (`tools/map_files.py`, ADR 0010) runs after the Ghost step, on the
Refresh's Steam session, into the same database, and never blocks or fails the run:
an error is a warning. The Workshop catalogue gives each Map's `hcontent_file` and
`file_size` but no `file_url` for this app, so the file comes through steam.py's content
servers: the Map's published file, its manifest, and the one file in it whose bytes start
with `{` or a UTF-8 BOM (the manifest also holds the preview JPEG). It downloads every
catalogue Map with no `map_files` row or one of another version, most subscribed first; an
unchanged Map is never downloaded. A few run at once, each file is written (an upsert) as
it arrives, and no download starts after `BUDGET` (four minutes), so the first catch-up
(1,521 Maps, 454 MB raw, ~16 MB gzipped, on 2026-10-17) spreads over several Refreshes and
later runs fetch only what changed. A failed download writes nothing and keeps the old
file; a manifest with no map file is logged and skipped; both are tried again next run, and
the log counts the failures by error. So a Map whose manifest holds no map file stays due and
is downloaded again every run. That is deliberate: its creator's next update may add one,
and it costs one download a run. When it wrote any file it revalidates the site. It is
skipped without a catalogue or a database, and with `--dev` writes only `DEV_DATABASE_URL`.
To fill a backlog in one go, ask the collector's service (`tools/runner.py`):
`fly ssh console -a ballest-collector -C "python /app/runner.py ask map-files?budget=3600"` runs the same
step alone (`map_files.download_due`, or `python tools/map_files.py --budget <seconds>` on its
own) on the service's one Steam login. The Refresh and the downloads take turns, so a Refresh due
meanwhile waits for it, and it fails when it wrote no file. The service runs it too on just the Maps
a #new-tracks post added, read from the newest page (`--maps`; "New Maps"). A cloud session
downloads too (`--dev`): `*.steamcontent.com` is in its Allowed domains, and `steam_download` has
steam.py's session use the session's proxy, which it otherwise skips. The site serves each
file from `/map/<pfid>/file` for the Map page's 3D view (`docs/site.md`, "Maps in 3D"), and
`getWorkshop` carries each Map's stored version.

### Dailies

A Daily's read follows the same rule as any board's: a failed or empty read is a
`board_reads` row with `ok = false`, and its Entries stay as they were.

The Daily step (`collect_dailies` in `tools/steampy_common.py`) runs after the Workshop
step and never blocks it or the Circuit. Without `BALLEST_API_KEY` and
`BALLEST_DAILY_URL` (GitHub secrets, given to the collector step only; the URL is a prefix
the collector appends the date to) it is skipped with a log line. It plans from the
Dailies the database holds (`known_dailies`, part of the collector's memory), and `daily.plan` picks every date since the first Daily
(2026-08-20) with no final Daily: one the database doesn't hold is looked up in the API
(one call a second at most, well under the API's limit; a date with no Daily, or a failed call, is
tried again next run), and one that has opened is read by its `leaderboard_id` through
`fetch_board`, the ones it holds before the ones it looked up. So the first run catches
up on every Daily, and later runs read today's, plus yesterday's until a read after its
close makes it final. The step stops at `daily.BUDGET` (five minutes) with what it has
read (`daily.collect`), abandoning a call still going, so a slow API or board read never
holds up the Circuit and Workshop write; the rest waits for the next run. Nothing assumes a window:
they ran 00:00 to 00:00 UTC through 2026-09-04, 25 hours on 09-05, and 01:00 to 01:00
since. The collector never prints the key or the URL.

Between Refreshes the Daily watcher (`tools/daily_watch.py`) runs the same step every
`DAILY_EVERY` seconds (a minute) on the service's one Steam login (ADR 0015), for today's and yesterday's dates only
(`daily.watch_since`; older ones are the Refresh's), so today's Daily is on the site within a
minute of opening and follows its board all day. It writes a Daily read (`source = 'daily'`,
the Dailies only) for a Daily the database doesn't hold yet, even with no times, and then only
when its board moved since it was last written or the read makes it final (`daily.Watch`), and
nothing otherwise, so a quiet board leaves the database asleep. It starts from the open
Entries of each Daily not yet final, so a restart rewrites nothing. Its
revalidate names the Dailies it wrote (`?daily=<board>`), which expires only the reads tagged
`dailies` and those boards' own tags. `runner.py` reads through file downloads too, and skips a
minute only while a Refresh runs, since the Refresh reads and writes the Dailies itself; after
each Refresh it starts again from what the database holds. Each read checks the Steam login
first, whatever is due, and fails without one; the next minute's read rides out Steam's short
drops, so ops hears only once reads have failed for half an hour.

### Chosen Skins

A table the site writes (ADR 0009), which the collector never touches: `chosen_skins` is one
row per player who picked a Chosen Skin (GLOSSARY.md), the Skin as the object path a Ghost
names (a key of `web/lib/skins.ts`) and when they chose it; clearing the pick deletes the row.
`chosen_skin_saves` is one row per save, pick or clear, which the limit of 10 in a rolling hour
counts (`PUT` and `DELETE /api/me/skin`, `web/db/chosen-skin-api.ts`); each save prunes the rows
older than an hour. The site reads every
pick, as its object path, in one cached read under its own tag, which only a save expires (`docs/site.md`, "Ball
skins"). `tiny` seeds two, one the site has no picture for. Multiballs reads `chosen_skins` too,
at most once a minute, for its images and Match Thread emojis (`discord-bot/AGENTS.md`, "Chosen
Skins").

### Stats Links

Two tables for See my stats (spec #323, ADR 0014), which the collector never touches.
`stats_link_requests` is the one table Multiballs writes: a row per press of See my stats with
no Stats Link (or of Pair again), by `token` (128 random bits, 32 hex characters), with the
Discord account's ID and name (the name only for the link page to ask about), `created_at` and
`used_at`, null until the page's confirm uses it. A request can be used for 15 minutes
(`REQUEST_MS` in `web/db/stats-link.ts`), and once; it is kept a day (`KEEP_MS`), so an expired
link still says it has expired and a reloaded Done page still says done. The bot keeps its own
copy of both, `REQUEST_FOR` and `REQUEST_KEPT` in `discord-bot/src/seeMyStats.ts`: change them
together (`discord-bot/test/statsLinks.test.ts` fails while they differ). The bot prunes the
requests older than a day as it writes, and so does the confirm. `stats_links` is one row per Discord account paired (GLOSSARY.md, Stats Link):
the Steam ID it signed in as and when, written only by the confirm
(`POST /api/discord/link?t=<token>`), which marks the request used in the same transaction;
pairing again replaces the row. Multiballs reads it, and watches its request's `used_at`. `tiny`
seeds one request, dated far ahead so it never expires, for the link page's smoke and qa views.

### Prefabs

The other tables the site writes (ADR 0009); the collector never touches them. `prefabs`
holds each upload: a slug from its first name that never changes, the name, description,
Tags, the uploader's Steam ID and their Steam persona when they uploaded, the file's text
exactly as sent, its piece count and size, the `angle` its picture is drawn from (null for the
default; `docs/site.md`, "Prefabs"), and `deleted_at` / `taken_down_at`, which hide it
without removing the row (it still counts against the uploader's hourly limit).
`prefab_favorites` is one row per player per Prefab. `prefab_bans` is a player the admin
stopped uploading; the reads hide their Prefabs while the row is there. `prefab_limits` is a
player the admin gave their own hourly upload limit in place of the 5; no row is the default.
`hourly_spends` holds the rolling-hour limits of `db/hourly-limit.ts`, one row per spend by
bucket and key, pruned to the last hour (ADR 0016): `prefab-write`, an edit or a heart added
or taken back, 60 an hour per player; `game-sign-in`, a sign-in from the game by the address
it came from (an IPv6 one by its /64), 30 an hour per address and 2,000 in all. `tiny` seeds two
Prefabs. `scripts/prefab-samples.ts` adds the two samples in `prefabs/samples/` (Will's,
from before uploads) to a database once, idempotently.

### New Maps

A Map published since the last Refresh is added on its own, within minutes, when the game
Discord's #new-tracks gets a post (spec #259): Multiballs asks the collector's service a minute
after the post (`discord-bot/src/newTracks.ts`, `POST /add-maps`), which runs `tools/add_maps.py` (`add_new`). That
reads the newest page of the catalogue (`campaign_common.newest_maps`, one Steam Web API request,
no Steam login) and `db_writer.add_maps` writes each Map the database lacks in one transaction:
its `boards` row with no board ID, `maps`, and one `map_history` row. It writes no Refresh and
reads no board. The row's first and last seen are the newest catalogue's Refresh
(`max(last_seen_refresh)`), as if that catalogue had seen it, so the site counts the Map as
listed and serves its page (with an empty board until it has times; `docs/site.md`, Routes), and its
sessions and subscriptions are empty, so the next Refresh reads them as moved and looks its board
up. While nothing is new it reads the page again, up to five reads a minute apart, since Steam's
list can lag the post. Before any catalogue was written it adds nothing. Ghosts come with the
next Refresh.

The collector's service on Fly (`tools/runner.py`, ADR 0012) runs it on `POST /add-maps`,
then downloads the added Maps' files (`map_files.download_due`, two minutes of downloads) in its
turn after any Refresh, so their 3D view comes within minutes too; a failed download leaves the
file to the next Refresh, as any due file is. Adding runs beside a Refresh, since it reads no board, so a
Refresh that read the catalogue before the Map was published and commits after `add_maps` leaves
the Map unlisted, its link sending players home again, until the next Refresh.

### What the collector remembers

The database is also the collector's only memory between runs. Before it logs into Steam,
`db_writer.load_memory` reads back:

- every player's persona, picture and profile (`players`), carried forward so a run looks up
  only players with no name or who set a score in the latest Refresh, plus one slice of the
  rest (`names_due`) picked by how many Refreshes the database holds, so every name is
  looked up again within `NAME_REFRESH_SLICES` Refreshes however late GitHub starts them;
- every Map's board ID (`boards.leaderboard_id`, set on its first finish), and from its
  latest `map_history` row the Workshop sessions, subscriptions and entry count as of its
  last good read, with how many open Entries its board holds;
- how many Maps the latest catalogue listed, for the shrink guard;
- when the latest Refresh with `full_sweep` started;
- every Daily it holds, for the Daily step to plan from, and each open Daily's open Entries
  (`daily_boards`), for the Daily watcher to compare its reads with.

`collect_workshop` in `tools/steampy_collect.py` reads a Map's board only when its Workshop
session or subscription count moved since its last read, plus every board once every
`FULL_SWEEP_SECONDS`. Without a database to read this from the collector stops before
logging in: it would have nowhere to write either.

### How a Refresh gets there

The collector's service on Fly (`tools/runner.py`, ADR 0012) runs a Refresh every three hours on
the hour (UTC), and at once on start when the last slot passed with none, since a deploy stops a
running one. Until 2026-10 GitHub Actions ran it, starting it three to five times a day, often an
hour or more late, so a three-hour window could pass with no run. Work spread across Refreshes
counts Refreshes for that reason: a slice keyed on the clock window was skipped for weeks
(PR #247), and a failed or killed run still skips a window now.

`record_refresh` in `tools/db_writer.py` is the collector's database step, called from
`on_ready` with what that run read: the Circuit boards, the names of those whose read
failed (`failed`, with no rows), the Workshop result (None when the Workshop step failed or
its guards declined) and the Dailies. `write_refresh` writes it in one transaction,
rows loaded by COPY into temp tables and each step one statement, since a Refresh carries
~155k rows across ~1,100 boards (about 5s against a local Postgres):

1. the Refresh, and every board it carries upserted: Tracks and Overall boards from
   `BOARDS`, with `scores_points` from the `Overall` name prefix, and every Map's board.
2. `board_reads`: a Circuit board is ok unless it is in `failed` or came back empty. A Map
   is read only if the Workshop result has its rows (ok) or lists it in `failed` (not ok,
   a read `collect_workshop` tried and lost). A Map not read gets no row.
3. `players` upserted from the rows (a blank persona or picture never overwrites a known
   one), and `persona_history` appended when a persona differs from the player's latest,
   else that row's `last_seen_refresh` moves.
4. `entries`, for boards read ok only: an open Entry whose (player, score) is still on the
   board moves `last_seen_refresh`; one whose score changed, or whose player is gone, is
   closed by this Refresh; a score with no open Entry opens one. The UGC ID is the one first
   seen with that score. On an Overall board a changed score is written into the open
   Entry instead, so only a player who left closes one.
5. `maps` upserted, and `map_history` appended when the title, creator name, preview,
   Medals, sessions, subscriptions or entry count differ from the latest row. Sessions and
   subscriptions are as of each Map's last board read, which is what the next run compares
   the catalogue's against. `map_activity` takes each listed Map's plays this week and votes
   as this catalogue gave them.
6. Each Daily the Daily step read: its board and `dailies` row upserted, a `board_reads`
   row (ok unless the read failed or came back empty), and its Entries as in step 4.
   `final_refresh` is set by the first ok read at or after `ends_at`, and never moves.

Which database: `DATABASE_URL`, or with `--dev` only `DEV_DATABASE_URL` (a local Postgres
for now). A failure is logged as a GitHub `::error::` and fails the run, since nothing else
holds the Refresh. After a commit, if `SITE_URL` and `REVALIDATE_SECRET` are set, it POSTs
`${SITE_URL}/api/revalidate` with `Authorization: Bearer <secret>`, which revalidates the
`data` tag; a failed call is a warning.

`tools/db_backfill.py` replays every commit on the first-parent line that touched
`data/boards`, `data/workshop` or `data/workshop.json`, oldest first, through
`write_refresh` as `source = 'backfill'` Refreshes dated at the commit, with its SHA. A
snapshot's Circuit boards (in `BOARDS`) count as read ok; a Map counts as read only if its
file changed in that commit or first appears in it, and the commit that removed `data/` is
skipped. It refuses a database holding any Refresh unless given `--rebuild`, which
truncates every table first, and refuses even then once the database holds a collector
Refresh newer than the last snapshot, which nothing could bring back: production, from
phase 5 on. `backfill.yml` runs it by hand, so it can only ever fill an empty production.
On 2026-10-04 it replayed 150 snapshots in ~7.5 minutes locally to 1.24M Entries and 470
MB, 1.05M of those Entries on the Season 2 Overall board, whose points move for most
players on every Refresh.

**Snapshot before anything that could lose rows.** With no JSON in git, a Neon snapshot is
the only way back from a bad migration or a leaderboard reset by the developers, which is
expected. Take one in the Neon console (the `ballest` project's Storage tab, the database,
then Open in Neon) before either.

Tests in `web/test/` each get a throwaway database on the Postgres at `TEST_DATABASE_URL`
(`postgres://postgres:postgres@localhost:5432/postgres` by default), which `web.yml`
provides in CI. The collector's tests in `tools/tests/` use the same Postgres, each on a
copy of a template database `web/scripts/migrate.mjs` builds, and run in `check.yml`.

### The read layer

The app reads the database only through `web/db/data.ts`, whose functions are
`"use cache: remote"` (shared by every server instance), tagged `data` (`web/db/tags.ts`; the
Daily reads also `dailies`, and a board's reads `board:<name>`, for a Daily read to expire), with the `max` lifetime: what every page's frame needs
(`getSite`: when the boards were read, every Circuit board's count, the podium tallies), the
Workshop's Maps with their figures (`getWorkshop`), a slice of a board (`getBoardPage`), a
player's record (`getPlayer`) and the Players counts (`getStandings`), the Workshop standings
at a baseline (`getWorkshopStandings`, keyed by the baseline, which `GET /api/standings` keeps
to the hour and the last week), and one Daily by its date (`getDaily`, checked against
`getDailyDates` first), whose board is read like any other. Searches
(`searchBoard`, `searchPlayers`) are read fresh. The queries are in `web/db/site.ts`, built on
the ranked boards in `web/db/boards.ts`, and tested against `tiny` (`web/test/site.test.ts`).
Cached values are JSON, so times come back as ISO strings.

Rank is computed, never stored: fastest first on a time board, most points first on one that
`scores_points`, and equal scores by Steam ID in the board's own direction, the lower first
on a time board and the higher first on a points board. That is Steam's order: every tie on
the committed boards (7,288 of them, 2026-10-04) reads that way. Season 1 Current and All
Seasons are computed the same way, from the Track and Overall ranks, as `build_current` and
`build_composite` did, and so are the podiums, the standings and each Map's Workshop figures.
A Map is in the Workshop while its latest `map_history` row was seen by the latest catalogue;
a Map gone from it keeps its Entries but leaves the Workshop pages and the counts. A board's
Score history (`scoreHistory` in `web/db/reads.ts`) is there for the history features.

`POST /api/revalidate` with `Authorization: Bearer $REVALIDATE_SECRET` expires the `data`
tag, or with `?daily=<board>` for each Daily a Daily read wrote only `dailies` and those
boards' tags (`tagsToExpire`); anything else, including a deploy with no secret set, gets a 401. The collector calls it once a Refresh or a Daily read has committed.

### Seeding a branch

`pnpm db:seed <dataset>` in `web/` empties every table of the database at `DATABASE_URL`
and writes a named dataset, in one transaction. The database must already be migrated,
locally by `pnpm db:migrate`. Run it with no
name, or a wrong one, to list the datasets. `empty` has no rows; `tiny` has two Tracks, an
Overall board, three Maps, four Dailies (three final, one live with a failed read), ten
players, three Refreshes of Score history and one Map's file, and is also the fixture the read layer's
tests run against. `stress` is tiny plus what strains a layout: 12,000 more players on the
Overall board, so the last one, who has a long name, ranks in five digits, and a Map with a
long title; `pnpm qa` and CI's layout check run on it (`docs/site.md`).

It refuses production three ways: when `VERCEL_ENV` is `production`; when the URL's Neon
endpoint ID (the host's first label, without `-pooler`) is `PRODUCTION_DB_ENDPOINT`, which
Vercel sets to production's endpoint for every environment; and, when that variable is
unset, for any host but localhost unless `--i-know-this-is-not-production` is passed.

- **Locally**, use a local Postgres: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/<db>`.
  Never `vercel env pull`: Vercel's Development variables point at production.
- **A preview branch**: not yet. Previews read production (found on PR #152, 2026-10-08):
  the Neon integration gives them no branch of their own, and the seed refuses production.
  Once branching per preview is turned on in the integration, a git branch's preview deploys
  get `preview/<git-branch>`, copied from production on the first deploy and reused by later
  ones, so a seed stays until that branch is deleted. Copy its connection string from the
  Neon console, then from `web/`:
  `PRODUCTION_DB_ENDPOINT=<production endpoint ID> DATABASE_URL='<preview branch URL>' pnpm db:seed tiny`.
  The preview shows the seeded rows once its cached reads are revalidated, by a
  `POST /api/revalidate` to it with the secret. A new deploy may not be: the Data Cache
  can outlive a build.

**Adding a dataset** is a module in `web/db/seed/datasets/` exporting a `Dataset` (a
one-line `description` and a `seed(tx)` that inserts through the schema in `db/schema.ts`)
and one line in that folder's `index.ts` registry. The harness has already emptied every
table and restarted their IDs, so a dataset writes from nothing, and Refresh IDs come back
from the insert rather than being assumed.

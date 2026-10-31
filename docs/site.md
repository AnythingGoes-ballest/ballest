# The site

How the app in `web/` is put together, for anyone editing it. It is a Next.js App Router
app reading the database (ADR 0004, ADR 0005); what the database holds is in
`docs/data.md`.

## Where things live

- `web/app/` — the routes. Each page renders `<Shell view>` (the header and the
  footer) around a `<Suspense>` whose fallback is that view's skeleton, and reads its
  params inside the boundary, so a page whose params weren't prerendered is served from
  its static shell at once. `app/api/` holds the few reads a page makes after it has
  loaded (a board's next rows, a search), the revalidate hook, and Sign in with Steam
  (`auth/`, `me`; ADR 0008).
- `web/components/` — the views, one folder each (`board/`, `workshop/`, `player/`,
  `players/`), and the pieces every view shares at the top level. A file is a client
  component only where it has to be: state, a browser API, or an event handler.
- `web/lib/` — pure TypeScript, no React and no database, with tests in `web/test/`:
  - `rules.ts`, the page's invariants and formatting: score units (`SCORE_TICKS_PER_SECOND`),
    `isPoints`, `isSteamId`, Medal tiers, times and ages.
  - `routes.ts`, every URL the site links to, what each path segment may be (the proxy and
    the pages check a path with the same predicates) and how an
    old `#/` link maps onto one.
  - `nav.ts`, the navigation model (`navOf`): from a path and a few facts from the database,
    the Section it is in, that Section's sub-tabs with the lit one, the kind of page and its
    breadcrumb trail ("The header"), and `crumbsOf`, the breadcrumb a page draws with the
    page the reader came from as its parent ("How a page opens").
  - `search.ts`, the site search: what a query finds, how each hit scores, and how the
    results are grouped under the filter chips ("Search").
  - `circuit.ts`, the Circuit's fixed facts: the board order (the in-game numbering), the
    Season 2 tiers, each Track's screenshot and Medal times.
  - `campaigns.ts`, the curated Campaigns and their lookups (below, "Campaigns").
  - `rows.ts`, the row types the read layer returns.
  - `player.ts`, `podiums.ts`, `players.ts`, `workshop.ts`: what each view works out from
    the rows it is given; `standing.ts` (You's place, Medal and next Medal on a board) and
    `spread.ts` (the spread chart's columns and where a time falls on it) for You.
  - `workshop-standings.ts`, the Workshop standings (`GLOSSARY.md`) counted now and at a
    baseline with shared places, `youBaseline`, the baseline /you compares against, and
    `baselineOf`, which baselines the route takes (ADR 0011). `GET /api/standings?since=` serves them, for /you and for Multiballs;
    `ladder.ts` is what /you shows of them (a card's rows around You, the line under it,
    "Show all"'s slices, and a shared place's "=1,840th").
  - `auth.ts`, Sign in with Steam end to end, one call per route (ADR 0008), over
    `steam-openid.ts` (Steam's login and its check) and `cookies.ts` (the cookie names the
    browser also reads). Not pure like the rest: it signs with `node:crypto` and asks Steam.
- `web/hooks/` — the client-only hooks: the clock and debounced searches (`client.ts`), a
  read made once per page and shared (`read.ts`), who is signed in (`me.ts`, reading
  `/api/me`), and You on one board (`you.ts`).
- `web/db/` — the read layer. `site.ts` is the SQL, `data.ts` the cached reads pages call
  (below), `schema.ts` the Drizzle schema the collector writes to.
- `web/proxy.ts` — the checks that must answer before a page starts streaming: a real 404
  for a path that can't be a page, and the redirects (`/leth`, a scope-only Players path,
  a player against themselves).
- `web/app/styles/` — the stylesheet, split by view and imported in order by
  `app/layout.tsx`. Every color is a custom property on `:root`; the theme is dark-only.
  Font sizes are in rem, written `calc(Nrem / 16)` with N the design's px, so text follows
  the reader's text-size setting; `node web/scripts/check-styles.mjs` rejects a px one.
  A size that grows from phone to desktop is fluid rather than a desktop override:
  `calc((Nrem + D * var(--ramp)) / 16)`, where `--ramp` (base.css) runs from 0 on a 390px
  phone to 1rem at the desktop breakpoint, `min-width: 51.25em` (820px at default text).
  The `good-css` skill covers how to write new styles; skip its light/dark token entry.

## Caching

Every read a page makes unasked goes through `db/data.ts`, where each is a
`"use cache: remote"` function tagged `data` with `cacheLife("max")`. Remote, because a
page rendered at request time runs on whichever serverless instance takes it, and plain
`"use cache"` lives in that instance's memory only. Pages are static between Refreshes: the
collector POSTs `/api/revalidate` (Bearer `REVALIDATE_SECRET`) once a Refresh has committed,
which expires the tag, and the next request reads fresh. Searches are read fresh every
time, since their keys would never repeat.

A tab left open keeps the page it loaded. When the reader comes back to it (the tab in
view again, the window focused, or the page restored from the back/forward cache) and it
was read over ten minutes ago, `useLatestRefresh` (`hooks/client.ts`, run by the header's
`Freshness`) asks `/api/refreshed` for the latest Refresh, from the same cached read, and
calls `router.refresh()` only when that is newer than the one on the page. A board's list
then starts over from its new first rows. Nothing polls while a tab is open.

Sign in with Steam (ADR 0008) never touches a page's cache: the session cookie is signed
with `SESSION_SECRET` and only `/api/me` reads it, from the browser, which asks only when
the readable `ballest-in` cookie says a session exists. Without `SESSION_SECRET` nobody can
sign in and every page works as before. The one page that reads it while it draws is the
link page (`/discord/link`, ADR 0014), which is never cached.

Every Circuit board and every Players view is prerendered at build. A player, a Map or a
head to head is prerendered for a handful of the busiest, and anyone else is served from
the route's static shell, then cached whole. A page served that way streams its title, so
each such view also sets it itself (`DocTitle`): Next 16.3 otherwise keeps the first
title on every later visit to the same route.

A `notFound()` inside a streamed page can only answer 200, so anything that can be told
from the path alone (a board name, a tab, a Players scope, a Steam ID's shape) is checked
in `proxy.ts` instead. A Steam ID nobody raced under is still a soft 404, and so is a
curated Campaign none of whose Maps the Workshop lists, or a Map of it that it no longer
lists: only the database knows, and the proxy can't read the cache, so asking would cost
a function call on every Campaign page view for a case that comes up only when a maker
pulls their Maps.

## Track screenshots

`circuit/<board name>.webp` is each Circuit track's own screenshot, ~640px wide (Track22's
texture is 527, and stays that size), for the rail and the board's header card.
`TRACKS` in `lib/circuit.ts` pairs each with that track's Medal times, read off the
in-game HUD. Neither is Steam data, so the collector never touches them.

They come from the game files, by hand, after a game update: the private
`ballest-map-making` repo's `python extract/circuit_screenshots.py <this repo>/circuit`.
Each level's data asset names its screenshot texture; the Season 2 names do not follow
track order, and two asset folders differ in case from the board names (`LongHaul`,
`Nightway`), so the script maps them through the data asset rather than by name.

## Ball skins

A board's rows and plates draw each run's ball skin in place of the made-up marble, once
the collector has read the run's Ghost (`docs/data.md`, "Ghosts"): the board query carries
the skin the Ghost names, and `skinPicture` in `lib/skins.ts` maps it to
`skins/<asset>.webp`, the game's menu ball wearing that skin, shot in a sandboxed test copy
and cut round, 192px for a 2x screen. A run with no Ghost read and a skin the list doesn't
know (one a game update added) keep the marble, and so does every derived or Overall board,
whose Entries the Ghost step never reads, and the
marble still turns over to the Steam avatar either way.

Where no run's Skin is known, a player's Chosen Skin (GLOSSARY.md) stands in for the marble.
The root layout reads every pick once (`getChosenSkins`, cached under its own tag, which a
save expires), each as its object path with any Skin the site doesn't list left out, and hands
it down through `components/ChosenSkins.tsx`. `Marble` stays a server component: it draws the
run's Skin, and where there is none, `ChosenBall`, the one client piece, draws the Chosen
Skin's picture (`skinPicture`, at draw time) or else the hue. So every surface that draws a
marble shows it, even one that knows a player only by Steam ID, and no query carries it.

A signed-in player picks theirs on their own player page (`components/player/SkinPicker.tsx`,
grill-design rounds 1 A and 2 A5 in spec #276): drawn only when You is the player on screen,
a pencil badge on their marble's corner (its own small button, with the 44px hit area of
`base.css`) and "Change your ball" beside Sign out open a `useDialog` dialog; the marble itself
still turns over to the avatar, as everywhere else. Its heading
scrolls away with the grid, and a mock board row (rank, the ball, your name with the Skin's
name under it, a time) stays pinned at the top with room above it; Cancel and Save sit under
the scroller. The grid is `SKIN_GROUPS` from `lib/skins.ts` (Colours with No skin first,
drawn as your hue marble, then Metals and Specials, each ball named there). A tap only
previews; Save, disabled until the preview differs from the saved pick, sends `PUT
/api/me/skin` with `{ skin }` (an object path) or `DELETE` for No skin
(`db/chosen-skin-api.ts`), and a failed save says so in the dialog's foot and changes
nothing. The API refuses no session (401), a cross-site request (403), a Skin `lib/skins.ts`
has no picture for (400) and an 11th save, pick or clear, in a rolling hour (429, counted in
`chosen_skin_saves`); a save expires only the Chosen Skin tag. The saved pick's object path is laid
over the layout's map in `ChosenSkins` (`useSaveChosenSkin`), so your marble on the page and in the
header draw it at once, before any page is read again. `qa`'s `player-own+skin-pick` state
opens it, signed in as tiny's p1.

A new skin takes a picture and a line in `lib/skins.ts`, with its name and picker group, and
its path and asset in Multiballs' copy, `discord-bot/src/render/skinList.ts`, with its PNG made by
`discord-bot/scripts/skin_pngs.py` (the bot's `test/skins.test.ts` fails until they match).
The list and pictures were made
on 2026-10-08 (`prototype/skins/` on branch `claude/prototype-skins`, with the game's own
tile icons and notes on which skins animate): the plain colours are shot with the texture
slider at 0, which most players use, and an animated skin (Spirit, Disco, Magma) is one
frame of it.

To reshoot one, as #275 did for Leth (these steps replace the ones in
`prototype/skins/notes.md`): in a sandbox slot (`docs/agents/plugins.md`), open Customize
(`call WBP_MainMenu_UIManager_C DoCustomize Transient`, then `cosmode public`), press the
skin with `cosmetictile -<n>` and take a `shot`. `-<n>` counts the collection, special,
medal and basic grids in that order, not the order the page shows them (Leth is -9). A
special skin (Leth, Snow Globe) is its own actor over the menu ball, turned with
`callx <class> K2_SetActorRotation <id> | v:<pitch>,<yaw>,<roll> | b:0`, where `<id>` is
the number ending the actor's object name (`BP_LBall05_C_2147479702`, a child of
`BP_MenuBall_C_3`). Leth at 59.638, 90.957, 96.401 puts its logo to the camera. Crop the
209px box at (581, 269) of the 1280×720 shot, scale it to 192px, and take the round cut
from another skin's alpha so every edge matches.

## Share images

A player, a Workshop Map, a Circuit Track, a Daily, a Campaign and a Prefab each unfurl
with their own 1200×630 card (spec #179; the Campaign's, spec #206). `lib/share.ts` decides what a
card says, `components/share/` draws it through `next/og`, `pageMetadata`
(`components/metadata.ts`) names it in the page's metadata, and `/og/<kind>/<id>`
(`app/og/[kind]/[id]/route.tsx`, `kind` one of `player`, `map`, `track`, `daily`,
`campaign`, `prefab`) serves the PNG, or a 404 when there is no such page. Any other page, an
Overall board included, keeps the site-wide `og.png`.

Every card carries the brand: the lime marble and the site's name, BALLESTRECORDS, in the
header's two tones (`SITE_WORDMARK`, `lib/rules.ts`; lime restated in sRGB). `og.png` bakes the
same name in with "Leaderboards for Ballest of Them All" under it, so renaming the site means
rendering it again (it was last drawn from a small page in Chromium at 1200×630, spec #339).

- A player gets their marble turned over to their Steam avatar, the Season 2 Overall rank
  if they have one, and up to four tiles: World records, Author medals, Maps finished,
  Maps made. Each counts the Circuit and the Workshop together, and a count of zero is
  left out.
- A Map, Track or Daily gets its picture across the top (the Workshop preview, or the
  Track's screenshot), its world record (a Daily's "Fastest", live or final alike), then
  Players, Author time, Beat the author and either Published (a Map) or Gold time.
- A Campaign (`/og/campaign/<slug>`) gets the same Banner with its first five Maps'
  previews side by side as the band (`CAMPAIGN_MAX_PICTURES`), a missing one a blank slice;
  "Campaign · by <maker>", its leader and their points, then Maps, Players and Finished
  every map: the players with a time on every one of its Maps the Workshop lists
  (`finishedEveryMap`). Its Overall, podiums and a focused row name it; a Map inside its
  frame (`/campaign/<slug>/<pfid>`) names that Map's own card, as a Track names its own
  inside its season. A slug that isn't curated, or none of whose Maps is listed, is a 404.
- A Prefab (`/og/prefab/<slug>`) is the Showcase (picked by Will from three layouts,
  2026-10-23): the Prefab itself across the whole card, drawn from its angle with the
  viewer's stand-in shapes, "Prefab · by <uploader>" over its name at the bottom left,
  Pieces and Favorites (none left out) as pills at the bottom right, and the brand pill at
  the top right. A function has no GPU, so
  `components/share/raster.ts` draws the viewer's scene (`buildScene`) itself: a depth
  buffer, the viewer's lights in three's units, three times supersampled, and a PNG clear
  where no piece is (about 0.3 s for a typical Prefab, under 2 s for 4,096 pieces). A file
  it can't draw leaves the card without its picture. A Prefab not live is a 404, as its
  page is gone.

The page names its card with the latest Refresh in the URL (`?v=`, `shareHref`), so each
Refresh is a new address for crawlers that keep a picture by URL, and the route answers
with `s-maxage` for a year: Vercel's CDN renders each card once per Refresh at most. A
Prefab's card is named by its last edit when that is later, so a new name or angle shows at
once, and is kept an hour only: a Prefab taken down or deleted leaves no picture on the CDN
for longer. On a
preview the card's URL is the branch's own address, since `metadataBase` is production.

Satori reads no WebP, no variable font and no `oklch`, so `assets/share/` holds what it
needs: TTF copies of Bungee and Chakra Petch (OFL, licences beside them) and a JPEG copy
of each `circuit/*.webp`. Regenerate those copies whenever a Track screenshot changes
(quality 82; PIL's `Image.open(webp).convert("RGB").save(jpg, quality=82)`).
`next.config.ts` traces the folder into the route's function. Steam pictures are fetched
with a 3-second timeout, only as PNG, JPEG or GIF and up to 4 MB; a card whose picture
fails to load, or that Satori can't read, draws without it.

## Stat Card

A player's Stat Card (GLOSSARY.md) is the 720×1060 portrait card Multiballs's See my stats
answers with in Discord (spec #323; grill-design K5 with its date as T1, prototype branch
`claude/prototype-statcard`). No page names it: `/og/stats/<steam id>?v=<Refresh time>`
(`app/og/stats/[id]/route.tsx`) serves it, through the player page's cached reads plus
`getChosenSkins`, `v` being the cache key. Unlike a share image it is kept by the CDN for five
minutes only (`s-maxage=300`), since the Chosen Skin and the Steam avatar on it change between
Refreshes, and not at all (`no-store`) when its avatar failed to load only for now (timed out,
a 5xx or the network failing), so the next press draws it again. A picture that will never
load (no PNG for the Skin, an avatar address `safeImg` refuses, a 404) leaves the card drawn
without it and kept as usual. A Steam ID that
names nobody is a 404. `lib/stat-card.ts` decides what it says, and
`components/share/StatCard.tsx` loads its pictures and draws it with `Card.tsx`'s colours,
marble and fonts.

- A frame and glow in the player's hue, and their ball at 400px: their Chosen Skin's
  picture, else their hue marble, with their Steam avatar as a 130px badge on its lower
  right (none without an avatar). Then their name, on one line: it steps down from 56px so
  that 32 characters (Steam's longest persona, counted as graphemes) fit, each at Bungee's
  widest letter or, for an emoji, CJK or any other script Bungee lacks, at 1.25em, and
  anything longer is cut with an ellipsis.
- The rows, in order: Season 1 Circuit and Season 2 Circuit (each season's Overall rank),
  World records, Author, Gold, Silver and Bronze medals, Maps finished. The counts add the
  Circuit and the Workshop as the player's share card does (an Author count includes world
  records at the author time), and the Medals count what each finish's time earned. A
  missing rank or a zero leaves its row out.
- The Refresh's date in UTC (`22 OCT 2026`) bottom left, the brand bottom right.

The Skin pictures are 192px WebP, which Satori can't read, so `assets/share/skins/` holds a
PNG copy of each at the same size, drawn scaled up to the ball until larger shots are taken
in the game. Run `python web/scripts/skin_pngs.py` (Pillow) after adding or changing a
picture under `skins/`; `test/skins.test.ts` fails until each listed Skin has its copy.
`qa`'s `stat-card` page draws it at the widths it fits (`minWidth` in the catalogue).

## Routes

- `/` — the Workshop homepage: Trending this week, the Campaigns' carousel, the shelves and
  the search.
- `/maps`, or `/maps/<view>` — All maps, opened on one of `VIEWS` or `PRESETS`
  (`lib/workshop.ts`). `?q=` narrows it to the Maps whose title or maker contains the query
  (the site search's "All N Maps matching", `mapsSearchHref`); the page is prerendered
  without it and narrows once the browser reads the address.
- `/map/<pfid>`, with an optional `/<steam_id>` that marks that player's row, and
  `/map/<pfid>/file`, the Map's file for its 3D view ("Maps in 3D"). A Map nobody has a
  time on yet, such as one added from #new-tracks since the last Refresh (`docs/data.md`,
  "New Maps"), has its page with an empty board and no record; the lists and shelves still
  show only Maps with times. A Map the Workshop doesn't list sends the link home.
- `/board/<board name>`, with the same optional `/<steam_id>`, or on an Overall board
  `/podiums`, which lists it in its podium order. A Steam ID is all digits, so the two
  cannot collide. Every Circuit board lights the Circuit Section, which opens the newest
  season's Overall board, and its own season among the sub-tabs. The seasons, newest first then All Seasons (`seasonsOf` in
  `lib/player.ts`), are also a row of sub-tabs above the board on a desktop and a chip beside
  the board button on a phone, whose menu gives each season's Tracks and field. Each
  season opens its Overall board.
- `/campaign/<slug>`: a Campaign's Overall board, with the same optional `/<steam_id>` or
  `/podiums`, or `/campaign/<slug>/<pfid>` for one of its Maps inside the Campaign's frame,
  as a Track opens inside its season, or `/campaign/<slug>/<event>[/<steam_id>]` for one of
  its Event boards, the only Map slot that takes a row (a Workshop Map's row is on its own
  page). Lights the Campaigns Section. The proxy 404s a slug that
  isn't curated, or anything after it but those; how the page is built is under
  "Campaigns".
- `/campaigns`: every Campaign as a banner, most players first, two across on a desktop
  and one on a phone. Prerendered; lights the Campaigns Section.
- `/player/<steam_id>`, with an optional tab from `PLAYER_TABS` (`/circuit`, `/workshop`,
  `/made`). Without one the page opens on Workshop for anyone with a Workshop time, else
  Circuit.
- `/vs/<steam_id>/<steam_id>`, a head to head of two players.
- `/players`, or `/players/<scope>/<sort>`: the Players table, counted over `all`,
  `circuit` or `workshop` and sorted on `wr`, `pod`, `t5` or `maps`.
- `/daily`, or `/daily/<YYYY-MM-DD>`: the Daily page, on the newest Daily or on that day.
  The proxy 404s any other `/daily/...` path but `/daily/standings`, and a real day with no Daily goes to
  `/daily`. A Daily is live or final by the reader's clock against its close (`isLive` in
  `lib/daily.ts`), so a page cached before the close flips to Final without a fresh read;
  a timer at the close (`useNowPast`) flips it on time rather than at the next minute.
  Every day links to its own page: on a desktop the calendar of months (`calendarOf`)
  sits beside the day's panel and stays put while the board scrolls; on a phone a strip
  of days under the page head, newest at the right and opened on the picked day, stands over
  the panel, and its Calendar button opens the same months over the page. The Daily
  Section is lit on every `/daily` path.
- `/daily/standings`: the all-time Daily standings, the Daily Section's Standings sub-tab,
  over final Dailies only (`standingsOf` in `lib/daily.ts`), so
  the live Daily joins once it closes. A card per record (most wins, podiums and Dailies
  played, the longest runs of days played and of wins), each the record's top three as
  small plates with equal values sharing a place, then "Every player": a medal table sorted
  by any column's header button (`aria-sort`), medal order breaking ties, 25 rows before
  "Show all". A phone drops its Podiums and Top 10 columns. Names link to the player's
  Daily tab.
- `/you`: Where you stand, You on the four Workshop standings (spec #221), linked from the
  Players table and the Daily Report's button, and lighting the Players Section. A ladder card
  per list, stacked on a phone, two by two and then four across on the desktop layout: the
  top 3, a gap, two above You, You, one below (unbroken in or near the top 5), each row
  with +N since the baseline and its places moved, then "N more to pass X" (the nearest player with a strictly higher count) or "You
  lead by N". The page is static: the server draws each list's top 3 (`laddersOf` with nobody),
  and the browser reads You's cards from `GET /api/standings?ladders&player=`. Gains and
  moves count from the /you baseline by the reader's clock (`youBaseline`), so the
  server's are shown only when its baseline, from the latest Refresh, is that one, and
  otherwise the browser reads them again. "Show all" opens the list in the card, read from
  `GET /api/standings?list=` in slices: the one around You first, scrolled to You, then
  more above and below as it scrolls, the rows in view kept still when rows go in above.
  Signed out, the top 3s stay open to anyone, a strip on top asks "Where do you stand?"
  and signs in, and each card's row where You would be reads "Sign in with Steam to see
  your row" and is the sign-in; all of them come back to /you. Until the browser can tell
  whether anyone is signed in, the strip, those rows and the gains line are drawn unseen,
  out of reach, holding their place, so a signed-out page doesn't jump when they show and
  a signed-in visitor never sees Sign in.
- `/discord/link?t=<token>`: the Stats Link's page (ADR 0014), where Multiballs sends a member
  who pressed See my stats to pair their Discord account with their Steam sign-in
  (`components/discord/LinkView.tsx` over `linkPageOf` in `db/stats-link.ts`). In the shell,
  lighting no tab, with /you's heading and sign-in strip. A token nobody wrote, one over 15
  minutes old and one already used each say so and send the reader back to See my stats.
  Signed out, Sign in with Steam comes back to it; signed in, it asks "Pair Discord account
  <name> with <persona>?", the persona from the boards, else the Steam profile, with Pair (a
  POST to `/api/discord/link?t=`, so a link preview can't use the token) and "Not you? Sign in
  as someone else", which signs out and comes back. Pair answers back to the page, which then
  says it is done. The one page that reads the session while it draws, so it is never cached
  and robots.txt keeps crawlers off it. `qa`'s `link` and `link-confirm` draw tiny's request.
- `/prefabs`: the Prefabs gallery; `/prefab/<slug>`: a Prefab's page; `/prefabs/new`: the
  upload form; `/prefabs/make` and `/prefabs/make/<generator>`: the Generators;
  `/prefabs/guide`: How to. The Prefabs
  Section comes last and is lit on all of them. See "Prefabs" and "Generators".

`/robots.txt` (`app/robots.ts`) keeps crawlers to the pages above that stand on their own:
it disallows a player's tabs, the `/<steam_id>` and `/podiums` views of a board, Map or
Campaign, a Campaign's Maps (each has its own page), head to heads, `/api/` and the upload
form. Every one of those multiplies by the number of players, and AI
crawlers walking them all once outran the site's Hobby limits. A new route that adds a
view of a page belongs on that list.

Search engines get the rest from `/sitemap.xml` (`app/sitemap.ts`, `lib/sitemap.ts`),
which robots.txt names. It lists the pages worth a search result, not every page allowed:
the Workshop, All maps, Players, Daily, Daily standings and Campaigns pages, every Circuit
board, every Map with a time, every Daily, every Campaign with a listed Map, and only the players with a world record or podium,
some two thousand pages where all of them would be fifteen thousand more. Each is a server
render per Refresh for whichever crawler reads it, so keep it to pages people search for.
Only a final Daily carries a `lastmod` (its close), since a page that changes every
Refresh would only ask crawlers back sooner. A test checks robots.txt allows every listed
page. The sitemap reads the cached data, so a Refresh's revalidate renews it too.

Every page of the app names its canonical address (`alternates.canonical`; a page with a
`generateMetadata` goes through `pageMetadata` in `components/metadata.ts`), on
`ballestrecords.com` through `metadataBase`: a view names the page it is a view of (a
player's tab names the player's page, a board or Map focused on a row or in podium order
names the board), All maps' views name All maps and the Players table's rankings name
Players, and each Daily is a page of its own. A Map or player the page can only send away
(a soft 404) is `noindex`, and so is a Map nobody has a time on yet, as the sitemap leaves
it out. The homepage's title says what the site is, and it carries the
site's name for search results as schema.org `WebSite` JSON-LD.

The single-page site's `#/` links live on in Discord and bookmarks: `LegacyHash` replaces
one with its path on load (`legacyPath` in `lib/routes.ts`). Every player name links to a
player page (`PlayerLink`), and the link out to Steam lives on that page. A Map's creator
links to their player page's Made tab, except inside a card or row that is itself a link.
A player or Map page's breadcrumb leads back to the board, list or player you came from,
remembered for the tab in `sessionStorage` ("How a page opens").

## Campaigns

A Campaign (GLOSSARY.md) is a player-made run of Workshop Maps that the site ranks the way
the game ranks a Circuit season. The game knows nothing of them, so the list in
`web/lib/campaigns.ts` (`CAMPAIGNS`) is the only place one exists.

**Adding one** is one entry in `CAMPAIGNS` (the run, request to live page: the `add-campaign` skill): its `slug` (the path, lowercase words joined by
`-`), `title`, `creator` (the maker's Workshop name), `creatorId` (the maker's Steam ID) and
`maps`, the Maps' Workshop IDs in the maker's order, and `collection`, the Workshop ID of a
public Steam collection holding them, when there is one. That order numbers the Maps 01, 02 and
so on, so append a Map rather than insert one. `campaignProblems` fails the tests on a
repeated slug, a Map in two Campaigns (or twice in one), an empty Campaign or an ID that
isn't one. Nothing else changes: the pages are prerendered from the list.

`pnpm --silent campaign draft <query ...>` (from `web/`) drafts a new Campaign in one call: it runs
the finder below, labels each Map as the rail will, lists what is wrong, and `--write` appends the
entry; `campaign check <slug>` counts the Maps a Campaign's page shows.

`python tools/workshop_maps.py <query ...>` finds the IDs: give it Workshop links or IDs, or
a whole pasted post holding them (a Map stands for itself, a Steam collection for its Maps in
order, in the order given), or one maker: a profile URL, a SteamID64, or part of their in-game or Steam name
(oldest first). It prints each Map with its maker's name and ID, marks
any already in a Campaign and any the site doesn't list yet, and ends with the `maps:` line to
paste. A Map the collector hasn't listed yet (one published since the last Refresh) is left
off its Campaign's page until a Refresh lists it, so a preview can show fewer Maps; after merging a Campaign with new Maps run a Refresh
(`fly ssh console -a ballest-collector -C "python /app/runner.py ask refresh"`, from Will's PC) and check the page on production. `qa check` draws
one fixed Campaign, so look at the new one's page with
`pnpm --silent qa shot /campaign/<slug>@1280` (and `@390`).

**Event boards and pinning.** A Campaign's `maps` may also name an Event board (GLOSSARY.md)
by its id in `EVENTS`, beside `CAMPAIGNS`: its Steam board, title, picture (the level's own
screenshot from the game files, committed as `leth/screenshot.jpg` and served from the site,
since it has no Workshop preview; a JPEG, as the share card can't read WebP; `safeImg` takes a path
from the site's root, and the share card fetches it from production) and the folder of the
static page its card links in place of a Map page (`viewerHref`). A test holds `EVENTS` to the
collector's `EVENT_BOARDS`. The collector reads an Event board once (`docs/data.md`), so it
counts toward its Campaign once it holds open Entries, and until then it is left out like a
Map the Workshop doesn't list. Inside the frame it is drawn as a Map with no Medals, its card
links the ghost viewer, it has no `/map/` page (`boardHref` sends its board, and a row on it,
to the slot), and its slot canonicals to the Campaign, with its share card: robots.txt keeps
crawlers off a Campaign's slots, so the Campaign's page is the one indexed. Its runs are
its open Entries: the collector reads a board whole, so that is Steam's count give or take a
run Steam dropped. The board API serves it by name; a player's own finishes leave it out, since their
place there shows on their Campaigns shelf. A Campaign with `pinned` is listed first wherever
Campaigns are (`getCampaigns`), whatever its player count: the Leth Trials, Leth Trial #1's
Campaign, is. `stress` reads its Event board, so its builds list it first.

**The board.** A Campaign's standings are a derived board named `OverallCampaign_<slug>`
(`campaignBoard`). The `Overall` prefix makes it a points board to `isPoints` and
`board_kind` with no special case, so every board piece (paging, search, You, plates, the
Podiums sort, a row's focus) takes it through `/api/board/<name>` unchanged. Like Season 1
Current it is never stored: `boardSql` (`db/boards.ts`) adds it up on every read from the
open Entries of its Maps the Workshop lists (and its Event boards read), each place paying the Circuit's track points,
equal totals ordered by the first Map (in the Campaign's order) a player is on, then their
place there. A player is ranked once they have a time on one Map.

**The page** (`components/campaign/CampaignView.tsx`) is a Circuit season's twin, built
from the same pieces: the Campaign switch (`CampaignSwitch.tsx`, the season switch's chip,
never a row of tabs, since the list keeps growing; on a desktop it heads the rail, under a
"Campaign" label and over the maker's name) lists the Campaigns most players first
(`getCampaigns`); the rail lists Overall, then each Map as a strip of its preview picture with its number, record and the part of
its title after the Campaign's name (`mapName`), left out when that is only its number
("Miniblack 01", "AJC1", or "Limbo campaign 1 of 8" and its "A08 of 8", which count the Maps), and the whole title when what is left starts with a number that
isn't the Map's place ("Ninja0", "AJ26") or the Campaign's name runs on into a longer word ("Embers Edge", "Ember's Fury"). Everywhere the frame names a Map (the rail's sheet, the podium
tally, the page's title) it is `mapLabel`: the number, then that name. On a phone the
switch's chip and the board button share a row while they fit, and the button takes a line
of its own when they don't (`.boardrow.named`), since a Campaign's title and Map names run
longer than a season's. The switch's menu scrolls inside itself when the list outgrows the
screen. The Overall card, the points dialog and the podium count say maps
where a season says tracks, and count the Maps the Workshop lists, which are the ones that
pay points. A Map inside the frame gets the Track card's layout with its preview picture
and a link to its own page. A Campaign none of whose Maps the Workshop lists is shown
nowhere and its page is a soft 404 (see "Caching"), as is a Map of it the Workshop no
longer lists. `stress` lists Solar Trials' first Map alone, so its builds have one listed
Campaign of one listed Map and four unlisted ones; `tiny`'s Maps are in no Campaign.

**Where they are listed.** `getCampaigns` is the one read every list takes: each Campaign
`getCampaign` finds (one with a listed Map), with the players its board ranks, its listed
Maps' preview pictures in its order and its board's leader, most players first. A
Campaign's page, its share card and every list read it through `getCampaign`, so it is
counted and led the same way everywhere. A Campaign's picture is
`CampaignPics`: its first five Maps' previews side by side with a hairline between, a Map
with no preview a blank panel; the banners and a player's Campaign cards all draw it. A
banner (`CampaignBanner`) sets the picture at full strength with a full-height fade behind
its text only: "Campaign · N maps · N players", the name, the maker and "<leader> leads
with <points> pts". The homepage's Campaigns carousel (`CampaignCarousel`, under Trending
this week and hidden with it while there is a search) is a scroll-snap track of banners:
a phone shows one with the next peeking in and swipes, a desktop shows two. Its arrows
step one banner and wrap round; the counter names the banners
in view ("1 / 5" on a phone, "1–2 / 5" on a desktop), and both hide when every banner
fits. Its heading's See all opens `/campaigns`. With no Campaign listed (a `tiny` build)
the homepage leaves the carousel out and `/campaigns` says there are none. Every count of a
Campaign's Maps that is shown (a banner's, the switch's, a player's card's "n/N maps", the
share card's) is its curated total, as its Maps are numbered out of it.

**Getting its Maps into the game** (spec #359; three grill-design rounds on the never-merged
`claude/prototype-ws-links`). Steam has no link that subscribes for a player, and only a
collection's Subscribe to all subscribes to several Maps at once. So every page of a
Campaign's frame floats a "Get the N Maps" button at the bottom left (`GetMaps.tsx`), which
opens a checklist dialog of its Workshop Maps; it carries `data-float`, so qa's overlap probe
leaves it out of the text it checks, since the page scrolls under it by design. The dialog lists them (`getMapRows`: the page's Maps less its Event
boards, numbered and named as the rail does): each row links its Map's Workshop page in a
new tab and ticks "Opened" once clicked, with a count, a bar and Start over, kept per Campaign
in this browser's `localStorage`. A Campaign with a `collection` gets its Subscribe to all at
the top; one with no Workshop Map gets no button. Under the list, the two steps in the game:
go to the Hub, press Downloads. A Map's own page says the same in one line under its "Get it
in Ballest" link, which sits under the picture beside "See it in 3D" (alone in the row
without a 3D view). On a desktop the Map page's panel scrolls with the page: a scroll of its
own hid its foot on a short screen.

**A Campaign Map elsewhere** says so (`components/workshop/Campaign.tsx`, both reading
`campaignOfMap`). Its card, wherever `MapCardLink` draws it (the homepage shelves, All maps,
the search), carries a strip along the bottom of its picture: the Campaign's name on the
left and "n / N" on the right, n its place in `maps` and N the Campaign's Map count. With a
pointer, the strip fades while the card's top three cover the picture. The Map page's panel
has a Part of box under the title ("Campaign", its name, "Map n of N →") that links to the
Map inside the Campaign's frame, `/campaign/<slug>/<pfid>`.

**On a player's page** the Workshop tab opens with a Campaigns shelf
(`components/player/CampaignCards.tsx`), a card for each Campaign the player holds a place
in, in `getCampaigns`' order (most players first). `getPlayerCampaigns` reads it:
`playerCampaigns` in `db/site.ts` gives their place and points on each Campaign's board
and how many of its listed Maps they have a time on, and the pictures and the players it
ranks come from `getCampaigns`. A card is `CampaignPics` (four
Maps) with the name over a fade, their place "of N" (gold, silver or bronze for 1st to
3rd), points, "n/N maps" and a bar of them, and it opens the Campaign's board focused on
their row (`/campaign/<slug>/<steam_id>`). A player in no Campaign has no shelf. The shelf
is `Shelf` (`components/player/Shelf.tsx`), the same as World records and Closest to a
record: ← → buttons, swipe, no scrollbar. Its buttons re-measure with a `ResizeObserver` on
the strip rather than on window resize only, so a strip whose size changes after it mounts
still shows them.

## The header

The site is BALLESTRECORDS (spec #339), the name its address carries; "Ballest of Them All"
is the game's name and stays wherever it means the game (descriptions, the footer). The
wordmark beside the marble rack is that name as one word in Bungee, BALLEST in the text colour
and RECORDS in lime (`SITE_WORDMARK`), and never wraps. It links home. Every tab title ends
"· BALLESTRECORDS" (`pageTitle`), and the homepage's title and its `WebSite` JSON-LD say the
site's name first, then the game it mirrors.

The header (`components/Shell.tsx`) is a two-tier hub (spec #339, round 1's variant D), one grid:

- **The bar**: the wordmark and You's card, with the site search between them ("Search").
- **The Sections** (`GLOSSARY.md`), as tabs with icons, the current one underlined in lime:
  Maps (the homepage), Campaigns, Daily, Circuit (its newest season's Overall board),
  Players and Prefabs. One with nothing in it yet (no Workshop, no Daily, no seasons) is left
  out.
- **The Section's sub-tabs**, as pills, the current one lit: Featured / All Maps; All
  Campaigns and the pinned Campaigns (`navCampaigns`); Today / Standings; each
  season; Rankings / Where you stand; Shared / Make your own / Upload. Every page of a
  Section lights one: a Map lights All Maps, a Campaign's Map its Campaign (or All Campaigns
  when the sub-tabs don't name it), a Circuit board its own season, a player's page and a
  head to head the Rankings.

What each row holds and which link is lit come from one pure model, `navOf` in `lib/nav.ts`,
read from the path and `NavFacts` (the four the database knows, read with the refresh time and
the search's jump-to links by `frameOf` in `components/frame.ts`, once per request under
React's `cache()`, so the page head reuses the header's read); it also gives the kind of
page and its breadcrumb trail (the Section, the lit sub-tab, then a Campaign Map's Campaign,
without the page itself), which the page head draws (below). Both rows are links marked
`aria-current="page"` inside labelled `nav` landmarks, drawn by `components/SectionNav.tsx`
from `usePathname`; until the path is known the Sections show unlit and the sub-tabs' row
keeps its height. On a phone each row scrolls sideways rather than wrap, fading out on the
side with more links and keeping the lit one in view; on a desktop every link fits.

The refresh time sits under the bar on a phone and at the sub-tabs' end on a desktop. It is a
button that opens a dialog on how the boards refresh: a static table of how long a change
takes to show on Circuit and Workshop boards, and when every Map was last read in full. The
table restates `collect_workshop`'s rules, so a change to when the collector reads a board
changes that copy too (`components/Freshness.tsx`). Ages are worked out in the browser, so a
page cached hours ago still says how old the boards are now.

You's card sits at the bar's end (`components/YouCard.tsx`): your marble and name, with your
All Seasons place and Maps finished on a desktop, linking to your page. On a phone it folds to
your marble, the name kept for a screen reader (a blank card holds that place while your
record is read). Signed out, it is Sign in with Steam, coming back to the page you were on
(Steam's mark alone on a phone); signed in as a Steam ID on no board yet, it is Sign out, since
that player has no page to sign out from (everyone else signs out on their own page). It
reads You from `useYou` (`hooks/me.ts`), which asks `/api/me` and reads your record once
per page load and shares them with every view of You, and it draws nothing until the
browser can tell, so a signed-in visitor never sees Sign in first.

## Search

One field in the bar finds players and Map makers, Maps, Campaigns, Circuit Tracks, Dailies
and Prefabs (spec #339, round 2's filter chips; ticket #342).

- **The read**: `GET /api/search?q=` (`app/api/search/route.ts`). The query is trimmed,
  lowercased and cut to 64 characters (`searchTerm`), and an empty one answers `null`. Players
  come from the fresh player search (`searchPlayers`, the Compare dialog's, an exact name
  first), and everything else from the cached lists the pages already read: makers and Maps
  from the Map cards (Maps through `searchMaps`, title or maker), Campaigns from `getCampaigns`
  (as `campaignSummary` lines), Tracks from the Circuit boards, Dailies and Prefabs from their
  lists. Whether a maker the player search's ten names left out plays is asked fresh too
  (`withTimes` over `searchedMakers`, beside the player search), never guessed from the cut. So
  a search costs two small queries plus cached reads, and the answer carries `s-maxage=60` and
  `stale-while-revalidate=300`: the CDN answers a query many type, or one typed again, and a
  Map, player or Prefab new since shows in the search within about six minutes.
- **What it finds, and in what order** is pure, `searchAll` in `lib/search.ts`: within each
  kind an exact name first, then a name that starts with the query, a word that does, then a
  contains, with popularity (runs, players, Maps made, favorites) breaking a tie. A Map found
  by its maker's name, a Prefab by a tag or a Track by its season's name rank lower than one
  found by its own. A maker every Map card names gets a hit with how many Maps they made, and
  one on no board links to their Made tab. The answer carries ten of each kind (`PER_KIND`)
  and `mapTotal`, every Map that matched.
- **The results** drop down under the field (`components/search/SearchBar.tsx`, a client
  island the header gives the jump-to links). `resultsOf` lays an answer out: chips for
  All and each kind found, the kind whose best hit matches best first, each with its count (the
  Maps chip counts `mapTotal`); All shows three of each kind under a heading, a chip every hit
  of its kind; "All N Maps matching …" links to All maps narrowed by the query whenever more
  Maps matched than are shown. Each hit shows its picture (a Map's preview, a player's marble,
  or its Section's mark), its name with the part typed in lime (`marked`), a line about it and
  its kind. With nothing typed it offers jump-to links (`jumpsOf`): the newest Daily ("Today's"
  while it is open), the newest Circuit season, and the two most played Campaigns. No hits
  says "Nothing called …".
- **Keys**: "/" (outside a text field) or Ctrl/Cmd K puts the keyboard in the field, or opens
  the sheet where the field is hidden; a page Next keeps hidden after leaving it shows neither,
  so its header ignores the keys. ↑/↓ move through the hits (round the ends), Enter opens the
  selected one or the first (with none selected while a newer term's answer is on its way, the
  first of that answer once it comes), Esc closes, and so does a press outside the field and its
  results, or leaving the page. The field is a labelled combobox whose results are a listbox of
  options, the selected one its active descendant, and a status line says how many hits there
  are.
- **A phone** gets a search button beside You's card instead of the field (the two wrap as
  one when the bar is too narrow for the brand beside them), which opens the same search as a
  full-screen sheet: a native `<dialog>` through `useDialog`, the field focused at its top.
- `qa`'s `search-empty`, `search` (typing "sol") and `search-sheet` states draw it; the two
  on the desktop's field are `wide`, as the field shows only there. The dropdown carries
  `data-layer`, so qa's overlap probe reads only the text inside it while it is open.

## How a page opens

Every page opens the same way under the header (spec #339, round 3's variant 1):
`PageHead` (`components/PageHead.tsx`) draws the breadcrumb, the kind of page in small
capitals, then the page's title in the Bungee marquee, its one `h1`. Each page renders it
first, from its own server data, just under the header (inside the page's `Suspense`
where the title waits on params, whose skeleton holds its place). The kind comes from
`navOf`; the breadcrumb is `crumbsOf` (`lib/nav.ts`): navOf's trail, less a crumb naming the
title, then the title itself, in a labelled `nav` with the title marked `aria-current`, and
not drawn at all when the title would stand alone (a Section's own first page).

A Map's page and a player's page name a trail (`components/Trail.tsx`, the memory the old
back links kept): the board, list or player this tab last looked at, which becomes the
breadcrumb's parent, under its own Section and by its sub-tab's name where one names it.
A Map remembers the homepage, All maps, a Campaign, the Daily and a player's page
(`<Remember trail="maps">`); a player remembers a Circuit board, a Campaign, a Map, the
Daily, its standings, /you and the Players table (`<Remember trail="board">`). A page that
leads to only some Maps says so, and is the parent of those alone, so a Map reached some
other way never sits under an unrelated Daily: a Campaign or a Daily names its Maps (`leads`),
and a player's page names the player (`player`), whom a Map's page leads back to when they
made it or its board has their row (`/api/board/<name>?player=`, the read You's banner makes).
A plain click on a Section's link (either row) or a search hit that leaves the page forgets
both trails (`forgetTrails`): the reader has set off somewhere new. A click that opens a new
tab, or a link to the page already open, keeps them. With nothing
kept, a remembered page that doesn't lead here, only the page itself, or storage blocked, the
breadcrumb is the Section's own (Maps › All Maps, Players › Rankings). The server draws that one, so the remembered parent swaps in
once the browser reads it. A head to head leads back to its first player.

No page draws its own title or a back link any more, and the page-level tabs the header's
sub-tabs carry are gone (the Daily's Days / Standings, the Prefabs' Shared / Make your own).
The Campaign switch, the Circuit rail, the season sheet and the seasons above a board stay:
they pick an item, not a page. A card that names its board, player, Daily or Prefab inside
the page (a Track's big number, the player card, the day's panel, a Prefab's name beside its
viewer) keeps that name, as an `h2`.

## The control kit

Every control inside a page is drawn from one kit (spec #339, round 4's variant 1, pills):
`components/Controls.tsx` for the markup and `app/styles/controls.css` for the look, with no
other stylesheet restyling them; a page's own stylesheet only places them (a margin, a flex
basis, which end of a row).

- **A choice** is a pill (`PillLink` for a link to another view, marked
  `aria-current="page"` when lit; `PillButton` for a button, `aria-pressed`) in a row of them,
  `Pills`, a labelled `nav` for links or a labelled group for buttons. A pill is a rounded
  outline, lime outline and tint when lit, and a row wraps rather than scrolls, so a long one
  (the Prefab tags) stays tappable at 320px with 20px text. A count rides in a `<small>`
  (a player's tabs). The board's Points / Podiums, the history card's Everything / Records only,
  All maps' views and the Refine drawer's choices, the Players and head to head's Where to
  count, a player's tabs, the head to head's filter, the Prefabs sort and tags, the upload
  form's tags and a Generator's choices are all pills. The header's sub-tabs (`.subs`,
  `SectionNav`) match them but keep the header's own rules.
- **A search box** is `SearchBox`: a rounded `field` with a magnifier, the one look for Find a
  player on a board and the Players table, Search maps, a player's map search and the Compare
  dialog. The header's site search is the header's own, as its sub-tabs are: a squarer box
  that carries the "/" hint and stays lit while its results are open. A select (a player's and a head to head's sort) is a `select.field`.
- **An action** is a lime pill, the `btn` class on a link or button: All maps, Where you stand,
  Refine, Upload, Download, Publish, Save and Sign in with Steam on the Prefab pages. `big` is a
  page's one main action (a Prefab's Download, Publish), `more` the Show more under a list.

A new control takes one of these rather than a style of its own.

## A board

A board's first rows are rendered on the server, with the plates and the card
across the top. The list starts at 1st, so the plates' three are rows too: players skim the
list for a name and kept missing the plates (a player's note, 2026-10-28). A Daily's panel
does the same under its podium steps. The rest of the list is read from `/api/board/<name>`
as you scroll, a few chunks ahead of what is shown, and a search reads its matches the same way. A link to a
player's row reads down to that row first. Each row carries the score of the row above it
(`ahead`, from the query), which is what the interval column is worked out from, so rows
are never re-sorted on the client.

A Track's or a Map's page carries its record history above the board's bar and search
(`components/board/HistoryCard.tsx`). `lib/history.ts` works it out from the board's Score
history (`historyInput` in `db/site.ts`): its Reigns and what each day
brought, all dated by the Refresh that first saw a time, in UTC days. The card arrives closed,
as a summary of the last three Reigns, and opening it replaces the summary with the Records
and What changed tabs. An Overall board has none, since it keeps current points only.

Once you are signed in, a banner above the plates gives You's standing on the board (a
Map, a Track, or an Overall board on its points sort): place, score, the Medal it holds
and a bar toward the next one (`standingOn` in `lib/standing.ts`), and a link to the board
at your row. It reads your row from `/api/board/<name>?player=<steam id>` through
`useYouOnBoard` (`hooks/you.ts`), which every view of You on a board shares, and draws
nothing until it has, so the server's page is the same for everyone; once the browser
knows there is a session it holds the banner's height while the row is read, so the plates
don't jump. The same read draws your time on the spread chart (a Map's panel, a Track's
card) as a line in your marble's hue, held at the right edge with an arrow when it is past
it: the server works the chart out (`spreadOf` in `lib/spread.ts`) and `YouSpread` draws
it again with the line, so only the chart's columns reach the browser, not every run.
`YouMarks` picks out your row and plate with a style rule on their `data-id`, so rows
added later by scrolling or search are marked too; the rule reaches only into its own
page's content, so a page Next keeps hidden leaves the others alone.

A run whose Ghost has a profile (`race` on the row, `docs/data.md`, "Ghosts") has a
dotted underline on its time, and a tap there opens the race drawer
(`components/board/RaceDrawer.tsx`) under the row, or under the podium for a plate or a
Daily's podium step. The drawer reads `/api/board/<name>?run=<steam id>` when it opens: the
date the run was set, its top speed, and a race against the leader (the leader races 2nd),
which shows only when both Ghosts have a profile. The gap arithmetic is in `lib/race.ts`.
`useRaceOpen` keeps one drawer open on a page, so a tap on another run moves it and a
second tap closes it.

Ranks follow Steam's tie rule: equal scores are ordered by Steam ID, ascending on a time
board and descending on a points board (`docs/data.md`).

## The player page

`playerRecord` (`lib/player.ts`) turns a player's rows into everything the page shows:
Circuit tiles, Workshop finishes with their Medal (`medalOf`, and `timeMedal` for the tile counts), and the Maps the player made.
The rendering is markup over that record. A tab is one entry in `PLAYER_TABS`, which the
tab bar, each tab's body and the route are all built from.

## Trending this week

The Workshop homepage opens on Trending this week (spec #348): the ten Maps with the most
heat, their Workshop plays over the last 7 days times (0.5 + the Workshop's vote score), ties
to more plays and then the newer Map (`trending` in `lib/workshop.ts`). Steam's vote score is
already discounted for few votes (0 with none), so the plays decide most of the order and the
votes lift a liked Map over an equally busy disliked one. A Map with no plays this week is
left out, so before a Refresh recorded them (`map_activity`, `docs/data.md`) the chart is not
drawn. Each row is one link to the Map: rank, picture, title and maker over the record
holder's podium line, then its plays this week over its 👍/👎. One column on a phone, two of
five on a desktop, ranks running down each. It replaced a carousel of five picks whose Most
played (lifetime sessions) showed the same Map every visit; the design rounds are on
`claude/prototype-trending`, never merged.

## Maps kept off the homepage

`HIDDEN` (`lib/workshop.ts`) lists, by pfid, the Maps the Workshop homepage's chart and
shelves leave out: ones the game can no longer finish, which otherwise top Barely played
and look like an easy place. Players report one through the link on a Map's page, which
opens a pre-filled GitHub issue; a Map goes in the list by hand. A listed Map stays in All
maps, search and player pages, and its page shows the reason.

## Head to head

`matchup` pairs two player records up: the rows both have a time on, each with its winner
and margin, the tally for All, Circuit and Workshop, and the comparison band. The head to
head page and a player page's score card both read it. The score card appears once you are
signed in (`hooks/me.ts`). The Compare dialog searches
players through `/api/players`.

## Players

`/players` ranks everyone by one column: world records, podiums, top 5s, or Maps finished,
counted on the Circuit, the Workshop or both. The standings read holds only counts;
`lib/players.ts` does the ranking. Only players with at least one of the sorted count are
listed. Equal counts share a rank (1, 2, 2, 4), and inside a tie the other columns in
their header order, then the name, set the order. A search filters that list and keeps
each player's real rank.

The table scrolls inside its own box on a phone, so the rank and name columns stay put
going sideways; on the desktop layout it fits, and the page scrolls. The pinned card is
your own row, once you are signed in, shown at the foot while the row is out of view: how
far the next rank up and the top 10 are, and a click scrolls to the row. "Where you stand"
beside the search goes to `/you`, which counts differently (the Workshop standings).

The Players Section is lit from the path (`navOf` in `lib/nav.ts`) on the table, /you, a
player's page and a head to head.

## Prefabs

Players' Prefabs (GLOSSARY.md), stored in the database by the site itself (ADR 0009; the
tables are in `docs/data.md`). Settled in three grill-design rounds on the never-merged
branch `claude/prototype-prefabs` (spec #213).

- **A Prefab's page** (`components/prefabs/PrefabPage.tsx`): the viewer on the left, and
  beside it the name, uploader, description, size, piece chips, tags and Download. The
  viewer (`PrefabModel`, `PrefabViewer`, `scene.ts`) fetches the file from
  `/api/prefabs/<slug>/file`, the same URL Download saves, and loads three.js from npm only
  there. It starts from the Prefab's angle and turns slowly until it is grabbed, and not at
  all under reduced motion; Reset view goes back to the angle. The ?
  opens the how-to (`HowTo.tsx`), with the Prefabs folder, the exact spawn command and a link to
  How to; it opens on its
  own once per browser (`localStorage`). A slug nobody uploaded, or a Prefab deleted, taken
  down or hidden, reads as gone.
- **Stand-in shapes**: the file names meshes but carries no geometry, and the game's
  meshes stay off the repo (ADR 0001), so `lib/prefab.ts` draws each known mesh as a box,
  cylinder, cone, pyramid, sphere, torus or half or quarter ring (the hole bowls) sized from its
  bounds, an unknown one as a grey box. A box whose mesh is curved is drawn instead as its
  outline in one view pushed through the bounds, squeezed by a second view's outline where that
  helps (`lib/prefab-profiles.ts`): coarse outlines, a few dozen points traced from mesh renders
  in the private ballest-map-making (`extract/piece_profiles.py`), never the mesh itself.
  `pnpm --silent qa piece` scores each against those renders. Each piece is coloured by its material's name (or, for a piece whose file names none, like a vent, the catalogue's, `PIECE_MATERIALS`); an Emissive
  material glows, as the game's lamps do. A fill light opposite
  the key keeps every side's colours true, so a sign seen from the front isn't greyed. Rotations are Unreal's [pitch, yaw, roll] in
  degrees; swapping y and z turns Unreal's left-handed z-up into three's right-handed y-up.
- **How to** (`PrefabGuide.tsx`, `/prefabs/guide`): the Prefabs Section's last sub-tab, written
  from what players asked in the game's Discord: selecting and saving (`saveprefab`), spawning,
  why a Prefab comes back as one flat group (the editor has no nested groups), uploading here,
  and the decal. Every game fact on it was checked against the game's own command help on
  2026-10-23, except the decal's Style tab, taken from players. The folder and commands come
  from `lib/prefab-console.ts`, as the how-to's do.
- **The gallery** (`PrefabGallery.tsx`): a card per live Prefab, Popular (favorites, newest
  breaking a tie) or Newest, filtered by one Tag (`galleryOf` in `lib/prefabs.ts`). Each
  card's picture is drawn in the browser from the file by one shared renderer once the card
  scrolls near, so no image is stored.
- **The angle** (`PrefabAngle` in `lib/prefabs.ts`, the `angle` column): the view its uploader
  picked, which the card, the share image, the upload ping's still and the page's viewer start from; none is
  three-quarters from above with the whole Prefab in view. It is stored relative to the
  Prefab's bounds (the camera's direction, its distance over the fitting one, and where it
  looks in radii), so it frames the same at any picture size. The uploader picks it in
  `AnglePicker.tsx`, on the upload form and in the Edit dialog: a line saying what to do, the
  preview held still, and Use this view (or Default view), which reads "✓ Card uses this
  view" until they turn the model again. Edit saves it with the name, description and tags;
  `PATCH /api/prefabs/<slug>` also takes `{ angle }` alone.
- **Uploading** (`UploadForm.tsx`, `POST /api/prefabs` in `db/prefab-api.ts`): signed in with
  Steam, 5 in any rolling hour per player (or the limit the admin gave them) counted from the rows. The file is checked in the browser the
  moment it's chosen and again on the server (`checkPrefab`, the game's own rules), named,
  described and tagged, previewed in 3D beside the card it will make, and live at once. Each
  upload pings #prefabs on the dev Discord server through Vercel's `OPS_WEBHOOK_URL` (skipped
  with a log line when it is unset; the GitHub and Fly secrets of that name are a different
  webhook, #ops's): the admin bot made that webhook, so it may carry link buttons
  (Open, Take down, Ban uploader; `db/prefab-ping.ts`). The two admin ones open the Prefab's page with
  `?admin=take-down` or `?admin=ban`, which opens that confirm for the admin. The ping's
  picture is a still of the preview the uploader's browser sends with the file (any PNG up to
  1 MB; shown only in #prefabs). An uploader the boards haven't seen is credited by the persona on their public
  Steam profile, read once at upload (`steamPersona`). The download name is the Prefab's name
  as the spawn command takes it (`fileNameOf`).
- **Favorites, editing and the admin** (`Favorite.tsx`, `PrefabTools.tsx`): a signed-in
  reader hearts a Prefab once (`/api/prefabs/<slug>/favorite`). Its uploader can edit its
  name, description and tags (and its angle, above) or delete it (`PATCH`/`DELETE /api/prefabs/<slug>`). The admin,
  one Steam ID (`ADMIN_STEAM_ID` in `lib/prefabs.ts`), can take any Prefab down
  (`/api/prefabs/<slug>/takedown`) and ban its uploader (`/api/prefab-bans/<steam_id>`),
  which hides all their Prefabs; a hidden one's gone page offers Unban. Every write expires
  the cached Prefab reads (`PREFAB_TAG`), so it shows at once. From the same page the admin
  can give the uploader their own hourly upload limit, or put them back on the 5
  (`/api/prefab-limits/<steam_id>`, the `prefab_limits` table); nothing cached reads it, as
  the upload form asks for its quota uncached.
- **From the game** (ADR 0016): the Prefabs plugin browses signed out with
  `GET /api/prefab-list?sort=popular|newest&tag=&q=&cursor=&limit=` (`listQueryOf` and
  `listPageOf` in `lib/prefabs.ts`: the gallery's order and tag, every word of `q` found in the
  name, description, a tag or the uploader; 50 a page, up to 100), answered as
  `{ total, next, prefabs }` with `next` the cursor of the page after or null. Each entry is what
  a Prefab's page shows beside its viewer (the size from `getPrefabSize`, read once per file)
  plus its `thumb` (`/api/prefabs/<slug>/thumb?v=<last edit>`, 320 × 200, clear around the
  Prefab, drawn like the share image, kept for days per edit, and drawn only at that address:
  any other query is sent there) and its `file`. The CDN keeps each query a minute. To write,
  it posts a Steam Web API ticket of its player, made out to `ballest-plugin:prefabs`, to
  `POST /api/auth/steam/ticket` (`signInFromGame` in `lib/auth.ts`, checked by
  `lib/steam-ticket.ts` with `STEAM_API_KEY`; 30 an hour per address, an IPv6 one by its /64,
  and 2,000 in all, `db/game-sign-in.ts`), and
  sends the game token it gets back (good for a day) as `Authorization: Bearer` on the same
  Prefab routes the site's pages use. They read it with `prefabSessionOf`, the bearer before the
  cookie, so every rule above holds for the game unchanged; every other route, the admin's
  included, reads the cookie alone (`sessionOf`). Every edit, and every heart added or taken
  back, counts against 60 an hour per player (`HOURLY_PREFAB_WRITES`, a bucket of
  `db/hourly-limit.ts`), since each expires the cached Prefab reads; deleting one's own is never held back.
  A write that changes nothing (the same heart sent twice) costs nothing. The thumbnail
  (`getPrefabThumb`) and each size (`getPrefabSize`) are cached in `db/data.ts` apart from those
  reads (`PREFAB_FILE_TAG`), each reading its file fresh, since a cached read inside another
  passes its tags out. Nothing revalidates `PREFAB_FILE_TAG`: a file never changes after upload
  and a thumbnail's link carries its edit time, so the tag is only a handle for a purge by hand.

## Generators

Make your own, the Prefabs Section's second sub-tab (spec #299; settled in four grill-design rounds
on the never-merged `claude/prototype-prefab-generators`; categories and buildings, spec #310,
on `claude/prototype-make-your-own`): a heading per category (Signs, Nature, Buildings,
`CATEGORIES`) over a card per Generator, each with a still of what its defaults make, and a
page per Generator at `/prefabs/make/<key>`
(`proxy.ts` answers 404 for any other key; the keys are `GENERATOR_KEYS` in `lib/routes.ts`,
kept apart from the Generators so a page that only links one never loads them).

- **The Generators** (`lib/generators/`: `index.ts` lists them and `generate()`s; `signs.ts`,
  `nature.ts` and `buildings.ts` hold each category's, `pieces.ts` what they share): each is its
  controls, its defaults and its
  builder, and `generate(key, values)` returns its Prefab file (or null with nothing to
  make, or values it refuses). The page draws whatever `controls(values)` returns, so a switch can hide another
  control (the sign's wall colour with the wall off), and a new Generator is one entry.
  Each kind of tree is a Generator of its own (Tree, Pine, Block tree). Pieces are the editor's
  cube, sphere, cylinder, cone and pyramid, placed by their bottom centre (a box can also be
  placed by its centre at any rotation);
  grids of cells (letters, voxels) are merged into as few boxes as they can be.
- **Parts** (`spawnsOf`): one spawn of 400 pieces crashed a sandbox game where 289 didn't
  (its cost grows with the square of the pieces), so a Prefab over `SPAWN_MOST` (240) downloads
  as Part 1..N, to spawn one after another without moving the camera. spawnprefab keeps a
  file's origin across and up but slides it along X to sit its nearest face a set way ahead, so
  a part that doesn't reach the whole's near, low corner gets a 20 cm white marker cube there,
  and the parts meet. Pixel art goes up to 128 blocks the longer way (`PICTURE_MOST`; a tall
  picture's Blocks across stops short of 128) on the strength of it.
- **Colours** (`COLOURS`): each names its material and the `paint` the editor saves beside
  it, a MaterialCategory and an `EBallestMaterialColors` value read from the game's assets
  (Smooth for the colours, Special for the metals). The editor paints nothing gold, so
  there is no Gold. A spawned file was checked in a sandbox game: every colour lands as named, and
  signs face the camera that spawned them. The swatches are `--gen-*` on `:root`.
- **The sign's lettering** (`lib/generator-letters.ts`): the Pixel font is a 5x7 table there;
  the others are drawn on a canvas by the browser (`components/prefabs/make/lettering.ts`)
  behind the same `Lettering`, so `lib/` stays pure. The text wraps at whatever line length
  makes the letters biggest inside the wall. Fonts the site doesn't load already come from
  Google Fonts on the sign's page only.
- **Text the sign won't letter** (`lib/rude-text.ts`, Will asked): the words on `obscenity`'s
  English list, which reads through l33t, repeated letters and look-alike characters and lets a
  clean word holding a rude one through (Scunthorpe, assassin, and our Cockpit); the same words
  spelled out a letter at a time; and swastikas, 1488 and KKK. No rude word is written in our
  code or tests (Will, 2026-10-24): a missing one goes upstream to `obscenity`, and the tests
  draw their words from its list. The sign `refuses` such text, so `generate` returns null and
  the page says "Keep it friendly" with Download off. Signs are download-only, so a list is the
  whole check: no moderation service. It adds about 16 KB gzipped to the Make your own pages.
- **Piece fonts** (`lib/generators/piece-fonts.ts`, R23 asked): Graduate (capitals) and Leker
  (lower case) are alphabets R23 built by hand from track pieces and uploaded as Prefabs. Each
  glyph is its own pieces, stood up and scaled to fit, not cells, so there is no Detail. Their
  glyphs live in `piece-fonts.json`, written from the four Prefabs by
  `scripts/piece-fonts.ts`, whose table says which pieces make each character; run it again if
  R23 changes them. A character they lack is a `?`; `.`, `:` and `'` reuse the `!`, `÷` and `”`
  pieces. The letters are as deep as built, about half a capital's height. The font picker
  credits R23 and links the Prefabs.
- **Buildings** (House, Tower, Castle) face -X, like signs. A wall is the boxes round its
  openings (`wall`: piers between windows, a piece under and over each). Roofs: gable as two
  pitched slabs (`slopes`) with stepped gable ends kept under the roof line; hip as a ridge with
  a pyramid at each end; flat as a slab inside a parapet. SM_Pyramid's corners sit at the middle
  of its bounds' edges, so a pyramid roof is turned 45° and grown by √2 (`pyramid`). Each was
  checked from four angles at six settings on the prototype's `/proto-collage` page.
- **The collage** (`/prefabs/collage?g=<key>[&only=<control,…>]`, `GeneratorCollage.tsx`): one
  Generator in every variation `variationsOf` lists, from three angles, for an agent to read in
  one screenshot (`pnpm --silent gen collage <key>`, which wraps
  `.claude/skills/prefab-generators/collage.mjs`). `pnpm --silent gen check` runs the same
  variations without a browser and prints only faults (`lib/generators/checks.ts`). `proxy.ts` answers 404 for it
  in production.
- **The page** (`GeneratorEditor.tsx`, grill-design rounds 1 and 4): the controls on the left,
  main ones first and the rest under More options, every number a slider showing its value;
  the model (`PrefabViewer`, held still), its size and piece count and Download on the right.
  Over 4096 pieces Download is off and says why. The ? beside it is the Prefab page's how-to.

## Maps in 3D

A Map whose file the collector has stored (`map_files`, `docs/data.md` "Map files") has a
**See it in 3D** button under its picture (spec #250; settled in four grill-design rounds on
the never-merged `claude/prototype-maps3d`, variant F). `getWorkshop`'s Map carries the
file's version (`fileVersion`), or null, and the button shows only with one: `map3dOf`
(`lib/workshop.ts`) builds the view's props from the Map, or null without a file.

- **The full screen** (`components/workshop/Map3D.tsx`) is a native `<dialog>` through
  `useDialog`, so Escape and Close (a `method="dialog"` form) close it and focus returns to
  the button. It opens with `useDialog`'s `back`, the one dialog on the site that does: opening
  adds a history entry at the same URL, Back (the browser's, or Android's) closes it and the
  page stays where it was, and closing it any other way goes back over that entry, so one
  Back afterwards leaves the page as it would have before. A bar across the top names the Map
  and its maker; on a desktop a corner card under it (`MedalList`, which the panel's Medals
  share) gives the record and the four Medal times, and a phone leaves it out so the Map
  isn't covered. The card follows the bar in one stack (`.m3d-top`), so it can't overlap it.
  While it is open the page gives up its scrollbar gutter, which nothing in the top layer
  can cover.
- **The Map** (`MapModel.tsx`, its own chunk, mounted only while the dialog is open, so
  neither three.js nor the file loads before the button is pressed) is the file read into a
  Prefab file by `lib/ballmap.ts` (each quaternion as an FRotator by `FQuat::Rotator`'s
  formula, each path out of its type and quote marks) and drawn by `PrefabViewer` with the
  Prefabs' stand-in shapes, from `MAP_ANGLE`: the prototype's "Angled" view that Will
  approved in round 4, closer than a Prefab's default; on a screen taller than wide it
  starts 1.3x further back. "Building the map…" (`MapWait`) shows until the viewer has
  drawn.
- **The water**: every Workshop Map is played in one level, whose water is a flat sheet at
  z 126.71 cm (`MAP_WATER` in `lib/ballmap.ts`, read from the game's files; a `.ballmap`
  doesn't hold it). The viewer draws it (`waterPlane` in `scene.ts`, in place of the ground
  grid) only when some piece reaches through that height (`waterLevelOf`), reaching half the
  framing's radius past the pieces, so a Map built high above the water isn't drawn over a
  sea. A Prefab has no water.
- **The file** comes from `/map/<pfid>/file?v=<version>` (`mapFileHref`,
  `app/map/[pfid]/file/route.ts`): the stored gzip bytes with `Content-Encoding: gzip`, read
  fresh (bytes don't belong in the JSON cache). Under the stored version the answer is cached
  a year, immutable, by the browser and the CDN; under any other, a minute. A Map with no
  stored file is a 404. `robots.txt` already keeps crawlers off it (`/map/*/`).
- `tiny` holds Marble Run's file, a four-piece `.ballmap`; `qa`'s `map3d` state opens it
  (`MAP3D` in the catalogue; Ice Boat Race on production).

## Checking a change

`pnpm dev` in `web/` against a local Postgres (never `vercel env pull`: its development
variables point at production), or `pnpm dev:up <port> [database]` in a cloud session, which
starts Postgres if a container restart stopped it and serves in the background until
`pnpm dev:down <port>` stops it by port (a `pkill -f` pattern also kills its own shell). After "An unexpected Turbopack error occurred" in its log, remove
`web/.next` and start it again. For a database with real boards, backfill one from
`data/`'s git history (`docs/data.md`); for a tiny one, `pnpm db:seed tiny`. Next keeps the page you
navigated away from in the DOM, hidden, so a scripted check counting elements should count
only visible ones.

- **A production build**: `pnpm serve <port> [database]` builds against that local
  database and serves it in the background; `pnpm dev:down <port>` stops it.
  `pnpm smoke <url>` then requests every route of a build seeded with `tiny` or `stress` and checks
  each answer, as `web.yml` does in CI. Under `next start`, some prefetches (header
  `next-router-prefetch: 3`) answer 404 in the console; Vercel answers them 200.
- **Revalidate**: serve with `REVALIDATE_SECRET` set, add a Refresh to the database (the
  collector's `--dev` run, or rows by hand), then `revalidate()` in `tools/db_writer.py`
  with `SITE_URL` pointing at the build. The changed boards should show at once.
- **The preview**: every pushed branch gets a public preview at
  `https://ballest-git-<branch>-n3sonlines-projects.vercel.app`, the branch name lowercased
  with each `/` as `-` (`claude/x-1` serves `ballest-git-claude-x-1-...`). Vercel shortens a
  hostname over 63 characters and adds a hash, so for a long branch name take the URL from
  the `environment_url` of the branch's deployment status
  (`gh api 'repos/will-ness-ai/ballest/deployments?ref=<branch>'`, then that deployment's
  `statuses`). It is up once that status is `success`. Previews count against the Hobby
  plan's 100 deploys a day, so push a branch in batches. A `failure` status names its
  deployment: `npx vercel inspect <deployment> --logs` reads the build log (the CLI finds
  `VERCEL_TOKEN` in a cloud session's environment). A prerender that fails on Neon's "could
  not resize shared memory segment" (code 53100) is Neon running short under the build's
  parallel queries, not the code: `npx vercel redeploy <deployment>` once.
- **Looking at it**: `pnpm --silent qa` from `web/`, run bare, lists the targets (production,
  this branch's preview with its deploy state, a local build) and what it checks. `qa check`
  draws the pages and dialogs in `scripts/qa/catalogue.mjs` that the branch's changes from
  `main` reach, at 320px with 20px text, 390, 820 and 1280, on the preview and on production, and prints only what is wrong: sideways
  scroll, an element past the edge (with the one holding it open), text cut off or drawn
  over other text, page errors, and changed pixels, with one picture per change to read
  (reference | target | changes in red) in `scratch/qa/`, then a last `summary:` line
  counting the new faults and changed views, and saying when there are gaps above. Read those pictures, not
  screenshots of your own. Which pages a change reaches is `scripts/qa/reach.mjs`: those whose
  page file or layouts import a changed file, through relative imports. A site file no page
  imports (the proxy, an API route, a migration, a picture) or one every page does (the root
  layout, the CSS, `lib/rules.ts`) draws every page; a code file whose change is only to its
  comments (or types) draws none, and neither do docs, tests, scripts or the other
  packages. It names any page a change reaches that the catalogue lacks. The
  whole catalogue is 176 views and takes 13 minutes from a cloud session, so pass `--all` only
  for a change that shows everywhere and wasn't caught as one. `--pages`, `--sizes` and `--at local:<port>` narrow or move it;
  `qa shot <view>` draws one view, and `--box <selector>` or `--eval <js>` measures it, in
  place of a throwaway Playwright script. `qa shot prefab@1280 --prefab <file.json>` has the
  Prefab page's viewer draw any file. `qa render <file.json | generator>` draws a Prefab file, or
  what a Generator makes (`--set font=Leker`), locally with the share images' rasterizer: no
  page, no deploy; `--items 0-5` and `--from top` show which pieces make what. To work on a stand-in shape, run `qa piece <mesh>`
  instead: it scores the stand-in's top, front and side outlines against the game mesh's
  renders in `ballest-map-making/references/pieces/` (1.00 is the same outline) and writes a
  game | viewer | outlines sheet; `qa piece --all` lists every mesh, worst first, and
  `--montage` adds their game and viewer rows 16 to a picture (`--match` narrows the list). A page
  that answers 200 with a "not found" title is a `gone` fault: its catalogue ID is stale. Both sides read the same database, so a change in
  numbers alone is data, and the two deployments' caches can differ by a Refresh: a changed view
  whose text is the same in the same places but for its numbers is marked `numbers` under `data`,
  listed after the others and left out of the summary's pictures to read
  (`scripts/qa/numbers.mjs`). A fault marked `also` is on the reference too: a live bug, not
  the branch's, so fix it if it's small or name it in the PR. `qa-prod.yml` draws every page of
  production every Monday, signed out, and posts its faults to the ops channel, so one only real data shows
  gets an owner. A view whose draw fails is drawn once more before it counts as `failed`.
  `--wait` waits up to 15 minutes for the preview to be built at HEAD, in place of a polling
  loop of your own.
  Production's domain may be outside a cloud session's network policy; `prod` is its Vercel
  address. A page or dialog with no row in the catalogue is not checked: add it. Locally,
  serve a build seeded with `stress` (tiny, plus a long name at a five-digit rank, a long
  Map title and one Campaign Map), whose IDs the catalogue knows; CI runs `qa check --all --against none --assert` on
  one, and its report is a notice on the build job (`gh api repos/will-ness-ai/ballest/check-runs/<id>/annotations`). A catalogue row with `as` is drawn signed in as that player (the Prefab upload form, an
  owner's Edit and Delete, the admin box): qa signs the cookie itself with the target's
  `SESSION_SECRET` (`scripts/qa/session.mjs`), which it knows only for a local build (from the
  environment or a `web/.env*` file, or else `qa-only`, the secret CI's run uses and
  `pnpm serve` and `pnpm dev:up` serve under when none is configured), so a local `check` is
  drawn signed in. It lists those views as `unsigned` elsewhere and on a server that refuses
  `qa-only` (a plain `pnpm dev` with no secret), and as `uncompared` when only the reference
  can't sign in. A `signed-out` fault means the site refused a secret qa read from the
  environment or a `.env` file: the server runs under a different one.

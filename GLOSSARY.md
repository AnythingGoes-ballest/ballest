# Ballest community tools

Tools built around **Ballest of Them All**: a read-only mirror of the game's Steam
leaderboards, and **Multiballs**, an unofficial community Discord bot that runs timed
head-to-head Matches on Workshop maps.

## Language

### Leaderboards

**Map**:
A player-made track published to the Steam Workshop, with its own Steam leaderboard.
_Avoid_: custom map, UGC map, level

**Track**:
One of the game's own courses in its Circuit mode (Season 1 or Season 2).
_Avoid_: campaign, campaign map

**Campaign**:
A set of Maps, in their creator's order, that we curate and rank together the way the game
ranks a Circuit season: each Map pays the same place points a Track pays toward Overall, and a
player's total is the sum over the Maps they hold a time on. The Workshop's counterpart to a
Circuit season, made by players; the game itself knows nothing of it, so the list is ours.
_Avoid_: playlist, series, collection (a Steam Workshop collection is a different thing)

**Event board**:
The Steam board of a one-off event the game ran, such as Leth Trial #1: neither a Track nor a
Map. The board stops moving once the event ends, so the collector reads it once, and a
Campaign can hold it as one of its Maps.
_Avoid_: event map, trial board

**Medal**:
One of a Map's four time targets, Bronze, Silver, Gold and Author (fastest), set by its
creator. A Track has the same four, set by the game. A time earns the best Medal whose target it meets. A player's page sorts their
finishes six ways, best first: World record (rank 1 on the Map's board), Author, Gold,
Silver, Bronze, and No medal. A world record is a rank and a Medal is a time, so they are
counted apart: a record at the author time counts under both, a slower one under its own
Medal.
_Avoid_: tier, grade

**Ghost**:
The replay the game uploads with a score, kept by Steam under the Entry's UGC ID: the
ball's path, and the Skin and hat it was rolled with. A new personal best gets a new
Ghost, so a Ghost never changes.
_Avoid_: replay file, UGC (for the Ghost itself)

**Skin**:
The ball a run was rolled with, one of the game's 36, named in the run's Ghost. A board
draws it in place of the player's marble.
_Avoid_: ball colour, cosmetic

**Chosen Skin**:
The Skin a signed-in player picked to stand for them wherever no run's Skin is known: a
run's own Skin first, then their Chosen Skin, then the marble in their hue. Multiballs draws
it too.
_Avoid_: avatar, icon, profile ball

**Stat Card**:
The image of one player's standing that Multiballs's See my stats answers with, drawn by the
site: their ball, their Season 1 and Season 2 Circuit ranks, World records, Medals and Maps
finished, dated with the Refresh it reads.
_Avoid_: profile card, share card (a share card is a page's link preview)

**Stats Link**:
The pairing of one Discord account with the Steam ID it signed in as on the site, made from
the link Multiballs gives a member who presses See my stats. Verified, unlike the Match bot's
Link (pasted, unchecked), and kept apart from it. Pairing again replaces it.
_Avoid_: link (alone, which is the Match bot's), verification, connection

**Race**:
Two runs' Ghosts played against each other on the site, a run against the leader (the
leader against 2nd), to show where along the course one gained on the other. A board's
race drawer shows it; a live contest between players is a Match.
_Avoid_: duel, comparison, replay

**Played**:
A player has Played a Map if they hold a time on that Map's leaderboard. Attempts that
never finished are invisible and do not count. A time can still beat the author time:
that is a Medal, not Played.
_Avoid_: attempted, beaten (for Played)

**You**:
The player signed in with Steam in this browser (ADR 0008). The header's card links to
your page, boards show where you stand, and another player's page scores you against
them. Signed in as a Steam ID on no board counts as no You: the header only offers Sign
out, since that player has no page to sign out from.
_Avoid_: me, current user, logged-in player

**Entry**:
A player's score on one board as Steam holds it: a time on a Map or Track, points on an
Overall board. A board holds at most one Entry per player; a better run replaces it.
_Avoid_: row, record (a record is rank 1), run (for the stored score)

**Plays**:
Steam's count of a Map's Workshop play sessions, lifetime or over a window ("plays this
week"). A play needs no finish, and Steam misses some, so plays are not runs and say nothing
about who has Played.
_Avoid_: sessions (in prose), runs (for plays)

**Votes**:
The thumbs up and down players give a Map on its Steam Workshop page, with Steam's score
over them. Not a Prefab's Favorite.
_Avoid_: likes, rating, favorites

**Trending this week**:
The Workshop homepage's top ten Maps by their plays over the last 7 days, lifted by their
Votes.
_Avoid_: popular, hot, most played (the lifetime shelf)

**Refresh**:
One pass of the collector over Steam, at a moment in time. It reads every Track and
Overall board, and only the Maps whose activity moved, so a Map not read in a Refresh
says nothing about that moment.
_Avoid_: run (a player's attempt), sync, scrape

**Score history**:
Every Entry a player has held on a board, each with the first and last Refresh that saw
it. A player's personal-best progression and a board's world-record history are both read
from it. Backfilled from the git history of the old JSON, so its earliest Entries were
first seen no later than their first Refresh, not exactly then.
_Avoid_: snapshots, audit log

**Reign**:
The span one world record stood on a Track or Map board: from the Refresh that first saw it
lead to the one that saw a faster time take it. An equal time does not start a new Reign,
and neither does an Entry Steam removed after one Refresh. A record already there when the
board was first read was set then or earlier. When a holder leaves the board, the record
passes back to the next fastest time, which starts a Reign with no cut.
_Avoid_: streak, hold, tenure

**Daily**:
The game's one-day challenge: one Map, played in a window (`starts_at` to `ends_at`, as
the developers' API gives them) on its own Steam board, apart from the Map's all-time
board. Named by its date. It is live while its window is open, and final once a Refresh
or a Daily read has read its board after the window closed; a Daily's standings count final
Dailies only.
_Avoid_: daily challenge board, Daily Report (that is Multiballs' post)

**Daily read**:
A pass of the collector's Daily watcher between Refreshes: it reads only the open Dailies,
every minute, and writes one only when its board moved or the read makes it final. Stored
beside the Refreshes (`source = 'daily'`) but counted as none, so "refreshed" and every count
of Refreshes leave it out.
_Avoid_: daily refresh, mini Refresh

**Daily Post**:
Multiballs' card for one Daily in the game Discord's daily challenge channel, with its thread:
posted when the Daily opens, kept current while it is live, and turned into the result once it
closes. A lead held by one player on it is a Reign, as on the site.
_Avoid_: daily challenge post, Daily Report (that is the stats post)

**Daily Report**:
Multiballs' once-a-day post of yesterday's Daily (the newest final Daily's top 10), four
standings (Maps played, Author Medals and world records from the Workshop standings, and Daily
wins) and the overall standing over them, what changed
since the day before, Maps nobody has finished, unclaimed Author Medals and the longest-standing
records. A creator counts on their own Map only by
beating its Author Medal, since the Author time is their publishing run.
_Avoid_: daily stats, stat report

**Workshop standings**:
The four lists /you shows, Maps played, Author Medals, world records and top 5s (the Daily
Report shows the first three, beside Daily wins), counted over the Maps the Workshop lists now, as they stand now and at a baseline.
Players level on a count share its place: 1 + the players with a strictly higher count. A
Map whose board was first read after the baseline counts as it stands on both sides.
_Avoid_: rankings, the report's boards (the Players table is not these lists: it counts the
Circuit too, and podiums)

**Daily wins**:
How many final Dailies a player came 1st on, as the Daily standings rank their boards: the
Daily Report's Most Daily wins, counted by the site beside the Workshop standings. A Daily
counts at a baseline once the read that made it final had finished by then. Players level on
wins share a place, as on the Workshop standings.
_Avoid_: Daily golds, Daily titles

**Overall standing**:
The Daily Report's list over its four standings (Maps played, Author Medals, world records and
Daily wins), drawn as "Overall" above them: a
player scores 10 points for 1st on a standing down to 1 for 10th, nothing outside a top 10,
added across the four (40 at most). Players level on points share a place, as on the four.
_Avoid_: Overall board (that is Steam's Circuit points board), overall score

### The site

**Section**:
One of the top-level areas the site's navigation names: Maps, Campaigns, Daily, Circuit,
Players and Prefabs. Each has its own sub-tabs (Featured / All Maps, each Circuit season, ...),
and every page belongs to one: a Campaign's Map to Campaigns, a player's page and a head to
head to Players. "Workshop" stays the game's word for player-made Maps; the Section is
labelled Maps.
_Avoid_: tab, group, category

### Prefabs

**Prefab**:
A group of level-editor pieces a player saved as one file and spawns into their own map as
one unit (a bench, a hill, a loop gate). Never a whole Map. The site hosts the ones players
upload, credited to the uploader.
_Avoid_: blueprint, asset, template, build

**Favorite**:
A signed-in player's heart on a Prefab, one each. The gallery's Popular order counts them.
_Avoid_: like, upvote, star

**Tag**:
One of a fixed list of kinds (Decoration, Obstacle, Ramp, Loop, Scenery, Structure) an
uploader gives a Prefab, up to three, which the gallery filters by.
_Avoid_: category, label

**Angle**:
The view of a Prefab its uploader picked: its gallery card is drawn from it, and its viewer
starts there. Without one, three-quarters from above with the whole Prefab in view.
_Avoid_: thumbnail angle, camera, pose

**Generator**:
A page that makes a Prefab file from a few settings: a Sign, a tree or bush,
or a building (House, Tower, Castle). What it makes is downloaded, never uploaded, so the
gallery stays Prefabs players built.
_Avoid_: maker, builder, template

### Matches

**Player**:
A Discord member who has linked their Steam account to the bot. Only Players can send
or accept Invites.
_Avoid_: user, member

**Link**:
The stored pairing of one Discord account with one Steam account, made by the Player
through the Link Steam button.
_Avoid_: registration, connection

**Invite**:
An open offer to play a Match, with a chosen duration (5–60 minutes) and a Match type.
It expires, and disappears, if not started within five minutes.
_Avoid_: challenge (that is a Match type), request

**Match**:
A timed contest on one Map, starting when its Invite is filled and ending when the
duration runs out, or once every Player has left it: a Player who leaves keeps their best
time so far, and nothing they set afterwards counts. If everyone leaves before anyone set
a time, the Match is cancelled.
_Avoid_: game, race, session

**Public 1v1**:
A Match type whose Invite any Player can accept; the first to accept is the opponent.

**Challenge**:
A Match type whose Invite names one Player, who alone can accept it.
_Avoid_: private 1v1, duel

**Lobby**:
A Match type whose Invite any number of Players can join; it starts when its creator
starts it, even if no one else has joined. Players can still join once it is live; a late
joiner's PB on the Map when they join is the PB they must beat. A Player who left can't rejoin.
_Avoid_: public lobby, room

**Eligible Map**:
A Map whose world record is between 5 seconds and 5 minutes and whose author time is at
most a tenth of the Match's duration. The Match's Map is drawn at random from the ones no
Player in the Match at the draw has Played. When every one tried has been Played, the one
the fewest Players have Played is drawn instead, and each of them counts only with a run
faster than the PB they already held on it; otherwise they finish DNF.
_Avoid_: map pool, candidate

**Match Thread**:
The Discord thread that holds one Match's Invite, joins, start ping and Result, and where
Players talk. The bot's channel itself is read-only for members.

**Match Card**:
The one message in the bot's channel that stands for a Match, edited in place as it moves
from Invite to live to finished; its Match Thread hangs off it.
_Avoid_: status message, embed

**Improvement**:
A Player's first time, or a faster time, on the Match's Map while the Match is live.
Each one is announced in the Match Thread as it happens.
_Avoid_: PB, split, update

**Footer**:
The bot's message at the bottom of its channel, offering New Match, Link Steam and Pings
(the @Multiplayer ping role). The next Match Card is made by editing it, and a fresh Footer
is posted below; a Lobby's Card is posted as a new message instead, so its mention of
@Multiplayer ping notifies, and the old Footer is deleted.
_Avoid_: sticky, pinned message

**Venue**:
A Discord server the bot plays Matches in: its Match channel (Footer, Match Cards, Match
Threads) and its @Multiplayer ping role. The game Discord is the home Venue. Every other
server the bot is invited to becomes a Venue by itself: the bot makes (or reuses) its
`multiballs` channel and `Multiplayer ping` role there. Each Venue has its own queue: an
Invite opened in one is seen and joined only there. Links, Chosen Skins and the
one-Match-at-a-time rule span every Venue.
_Avoid_: guild, instance (one bot serves every Venue)

**Result**:
Each Player's best time on the Match's Map, read the moment the Match ends, ranked. A
Player with no time did not finish. If Steam is down then, the Result waits for it (up to 30
minutes, the thread saying time's up), and failing that stands on the last times polled.

**Play again**:
The button on a Result. The first Player to press it opens a Lobby of the finished Match's
length, as its creator, and the finished Match's other Players who didn't leave it are pinged in
the finished Match's thread, once. Everyone who presses it after that joins the same Lobby until
its time is up. Any Player may press it. Once that Lobby is gone, the next press opens a fresh one.
_Avoid_: rematch, replay (a replay is a Ghost)

### The Weekly Cup

**Weekly Cup**:
A competition the bot runs by itself every week in a server where it is switched on (Ballest
Racing), in that server's `weekly-cup` channel, on US Central time: sign-up from Monday 00:00 to
Sunday 20:00, the Shortlist drawn Thursday 12:00 and voted on until Friday 09:00, then racing on
the Cup Maps until Sunday 20:00, scored with the Circuit's place points. A week with fewer than 2
Entrants at Thursday 12:00 is cancelled; a server admin can skip a week before then. Each Entrant
plays each Cup Map for 30 minutes at most and uses no Ghosts, on their honour.
_Avoid_: tournament, event

**Entrant**:
A Player signed up for a Weekly Cup. Signing up needs a Link; "sign up" is the verb, so it
doesn't collide with Link. An Entrant can withdraw until the Cup ends. Only times set while racing
count: an Entrant's PB on each Cup Map when racing opens (Friday 09:00), or when they sign up if
that is later, is their bar, and a time counts only once it beats it.
_Avoid_: registrant, participant

**Shortlist**:
The 10 Maps the bot draws for a Weekly Cup on Thursday 12:00, none Played by any Entrant: each an
Eligible Map with an author time of at most 3 minutes. Entrants vote on it for the Cup Maps.
_Avoid_: pool, ballot

**Cup Map**:
One of the 3 Shortlist Maps with the most votes, a tie settled at random: the Maps a Weekly Cup
is raced on.
_Avoid_: track (a Track is a Circuit board)

**Flag**:
A PB set more than 30 minutes after the Entrant's first counted time on that Cup Map. Both runs
are dated by their Ghosts, to the second; when either Ghost gives no date, by the reads that saw
them instead (5 minutes apart, so approximate, and the Flag says which). It still counts; the bot
tells the ops channel, once per Entrant per Map, to follow up by hand.

_Avoid_: strike, violation

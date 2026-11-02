// GET /api/standings?since=: the Workshop standings (WorkshopStandings in lib/rows.ts), now and
// at a baseline, with each player's count and shared place on both sides (docs/adr/0011), and
// beside their `lists` the Daily side, `daily` (StandingsPayload in lib/rows.ts): `wins`, Most
// Daily wins in the same row shape, over final Dailies, and `latest`, the newest final Daily
// (its date, Map title and preview, player count and top 10 as its board ranks it, scores in
// ticks), or null when none is final. Its players join `players`. `daily` is the Daily
// Report's, not a Workshop standing, so the /you modes below leave it out.
// Multiballs draws the Daily Report's image from all of it.
//
// GET /api/standings?ladders&player=<steam id>: /you's four cards for that player (YouLadders
// in lib/ladder.ts): each list's top 3 and the players around them, with the line under the
// card. Without a player, the top 3 alone. Something that isn't a Steam ID is a 400.
//
// GET /api/standings?list=<played|author|wr|top5>&from=&count=: a slice of one list in
// listing order, for "Show all" on /you, at most MAX_SLICE rows. A list that isn't one is a
// 400.
//
// `since` is an ISO time or Unix ms, read down to the hour; without it, the /you baseline (24
// hours before the most recent 16:00 UTC). One baselineOf refuses is a 400.
import { getDailyWins, getLatestDaily, getWorkshopStandings } from "../../../db/data";
import { isStandingsStat, laddersOf, sliceOf } from "../../../lib/ladder";
import { BOARD_CHUNK, isSteamId } from "../../../lib/rules";
import { baselineOf, withDaily } from "../../../lib/workshop-standings";

/* "Show all" reads a few chunks at a time, around You and then as it scrolls */
const MAX_SLICE = BOARD_CHUNK * 4;

const refuse = (error: string) => Response.json({ error }, { status: 400 });

export async function GET(request: Request) {
  const now = Date.now();
  const params = new URL(request.url).searchParams;
  const baseline = baselineOf(params.get("since"), now);
  if ("error" in baseline) return refuse(baseline.error);
  const { since } = baseline;

  if (params.has("ladders")) {
    const player = params.get("player");
    if (player != null && !isSteamId(player)) return refuse("not a Steam ID");
    return Response.json(laddersOf(await getWorkshopStandings(since), player));
  }
  const list = params.get("list");
  if (list != null) {
    if (!isStandingsStat(list)) return refuse("no such list");
    const from = Math.max(0, Math.floor(Number(params.get("from")) || 0));
    const count = Math.min(MAX_SLICE, Math.max(1, Math.floor(Number(params.get("count")) || 50)));
    return Response.json(sliceOf(await getWorkshopStandings(since), list, from, count));
  }
  const [standings, wins, latest] = await Promise.all([
    getWorkshopStandings(since),
    getDailyWins(),
    getLatestDaily(),
  ]);
  return Response.json(withDaily(standings, wins, latest, since));
}

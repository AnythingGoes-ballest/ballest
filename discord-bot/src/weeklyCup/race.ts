// The Weekly Cup's racing (spec #353, #358): from Friday 09:00 each Cup Map is read every 5
// minutes, one readPlayers call per Map for the current Entrants; a time counts once it beats the
// Entrant's bar (their PB as racing opened, or as they signed up if later) and their counted best,
// and a PB set more than 30 minutes after their first counted time on that Map is a Flag, told to
// ops once per Entrant per Map: timed by the two runs' Ghosts when both give a date, else by the
// reads that saw them. The standings are shown after each read; at Sunday 20:00 a final
// read of each Map (tried each minute for the ones Steam missed, up to 30 minutes) makes the
// results, posted once, and the live standings then say racing has closed.
import { Effect, Option } from "effect";
import { formatTime } from "../domain.js";
import { mapName } from "../links.js";
import { GhostUnavailable } from "../steam/ghosts.js";
import type { SteamUnavailable } from "../ports.js";
import type { CupKit } from "./kit.js";
import {
  type CupMap,
  FINAL_WAIT,
  FLAG_AFTER,
  GHOST_CLOCK_SLACK,
  GHOST_READ_TIMEOUT,
  LATE_READ_AFTER,
  READ_EVERY,
  RETRY_EVERY,
  type StandingsView,
} from "./model.js";
import { cupStandings } from "./points.js";
import type { Baseline, CupRecord, CupTime } from "./record.js";
import type { CupWeek } from "./week.js";

/** A week's race as the record has it: its Cup Maps in rank order, and every Entrant's bars. */
export interface Race {
  readonly maps: ReadonlyArray<CupMap>;
  readonly bars: ReadonlyArray<Baseline>;
}

interface Account {
  readonly discordId: string;
  readonly steamId: string;
}

/** How far apart an Entrant's first counted time on a Map and their new PB there were. */
interface FlagGap {
  readonly ms: number;
  /** Between the two runs' Ghost dates; otherwise between the reads that first saw each. */
  readonly byGhosts: boolean;
}

/**
 * The gap a Flag is judged on: between the runs themselves when both Ghosts gave a date, else
 * between the reads that saw them, which can each be up to a read gap (5 minutes, longer while
 * Steam is down) after the run; ops follows that kind up by hand.
 */
const flagGap = (
  first: Pick<CupTime, "firstAt" | "firstSetAt">,
  setAt: Option.Option<number>,
  now: number,
): FlagGap =>
  first.firstSetAt !== null && Option.isSome(setAt)
    ? { ms: setAt.value - first.firstSetAt, byGhosts: true }
    : { ms: now - first.firstAt, byGhosts: false };

/** "30 min 30 s" between Ghosts, to the second; "about 35 minutes" between reads. */
const describeGap = (gap: FlagGap) => {
  const seconds = Math.floor(gap.ms / 1000);
  return gap.byGhosts
    ? `${Math.floor(seconds / 60)} min ${seconds % 60} s`
    : `about ${Math.floor(seconds / 60)} minutes`;
};

export const makeRace = (kit: CupKit) => {
  const { guildId, log, steam, ghosts, links } = kit;

  /**
   * When each Cup Map's last read landed, so a new time's run is known to be set after it; lost on
   * a restart, when the time it beat bounds it instead.
   */
  const lastReads = new Map<string, number>();

  /**
   * When a run first seen `now` was set, by its Ghost: none when the entry has no Ghost, the read
   * fails or takes over GHOST_READ_TIMEOUT, or its date can't be this run's. A Ghost is attached
   * after its score lands, so a read can still see the old run's; this run was set after `after`
   * (the last read that didn't show it), and not after `now`, give or take a second for the
   * stamp's rounding and GHOST_CLOCK_SLACK on the late side for the player's PC clock.
   */
  const setAtOf = Effect.fn("WeeklyCup.setAtOf")(function* (
    ugcId: string | undefined,
    after: number,
    now: number,
  ) {
    if (ugcId === undefined) return Option.none<number>();
    const at = yield* ghosts.setAt(ugcId).pipe(
      Effect.timeoutFail({
        duration: GHOST_READ_TIMEOUT,
        onTimeout: () => new GhostUnavailable({ reason: "timed out" }),
      }),
      Effect.catchTag("GhostUnavailable", (e) =>
        Effect.logWarning(`weekly cup: no date for a Ghost (${e.reason})`).pipe(
          Effect.as(Option.none<number>()),
        ),
      ),
    );
    return Option.filter(at, (a) => a > after - 1000 && a <= now + GHOST_CLOCK_SLACK);
  });

  /**
   * An Entrant's new counted time on a Map, first seen `now` (set after `after`), over their
   * counted best before it, if any: with the gap that makes it a Flag, or null when it isn't one.
   * Its Ghost is read for a first time, to date it, and for a PB only when its date could make a
   * Flag.
   */
  const counted = Effect.fn("WeeklyCup.counted")(function* (
    entry: Baseline & { readonly ugcId?: string },
    before: CupTime | undefined,
    after: number,
    now: number,
  ) {
    const fresh = { pfid: entry.pfid, discordId: entry.discordId, ticks: entry.ticks, seenAt: now };
    if (before === undefined) {
      const firstSetAt = Option.getOrNull(yield* setAtOf(entry.ugcId, after, now));
      const time: CupTime = { ...fresh, firstAt: now, firstSetAt, flagged: false };
      return { time, flag: null };
    }
    const gap = before.flagged
      ? null
      : flagGap(
          before,
          before.firstSetAt === null || now + GHOST_CLOCK_SLACK - before.firstSetAt <= FLAG_AFTER
            ? Option.none()
            : yield* setAtOf(entry.ugcId, after, now),
          now,
        );
    const flag = gap !== null && gap.ms > FLAG_AFTER ? gap : null;
    const time: CupTime = {
      ...fresh,
      firstAt: before.firstAt,
      firstSetAt: before.firstSetAt,
      flagged: before.flagged || flag !== null,
    };
    return { time, flag };
  });

  /** The week's Cup Maps in rank order, each with its votes; none before the vote closes. */
  const cupMapsOf = Effect.fn("WeeklyCup.cupMapsOf")(function* (week: string) {
    return (yield* log.shortlist(guildId, week))
      .flatMap((s) => (s.cupRank === null ? [] : [{ ...s, cupRank: s.cupRank }]))
      .sort((a, b) => a.cupRank - b.cupRank)
      .map((s) => ({ map: s.map, votes: s.votes ?? 0 }));
  });

  const raceOf = Effect.fn("WeeklyCup.raceOf")(function* (week: string) {
    const maps = (yield* cupMapsOf(week)).map((m) => m.map);
    return { maps, bars: yield* log.baselines(guildId, week) } satisfies Race;
  });

  /** These members' linked Steam accounts; one without a Link is left out. */
  const accountsOf = Effect.fn("WeeklyCup.accountsOf")(function* (
    discordIds: ReadonlyArray<string>,
  ) {
    const found = yield* Effect.forEach(discordIds, (discordId) =>
      Effect.map(
        links.steamIdOf(discordId),
        Option.map((steamId): Account => ({ discordId, steamId })),
      ),
    );
    return found.flatMap(Option.toArray);
  });

  /** One Map's entries for these accounts, by whose they are: one readPlayers call. */
  const readMap = Effect.fn("WeeklyCup.readMap")(function* (
    map: CupMap,
    accounts: ReadonlyArray<Account>,
  ) {
    if (accounts.length === 0) return [];
    const byAccount = new Map(accounts.map((a) => [a.steamId, a.discordId]));
    const entries = yield* steam.readPlayers(
      map.boardId,
      accounts.map((a) => a.steamId),
    );
    return entries.flatMap((e): Array<Baseline & { readonly ugcId?: string }> => {
      const discordId = byAccount.get(e.steamId);
      if (discordId === undefined) return [];
      const entry = { pfid: map.pfid, discordId, ticks: e.ticks };
      return [e.ugcId === undefined ? entry : { ...entry, ugcId: e.ugcId }];
    });
  });

  /** These members' PBs on these Maps now, as their bars; fails as soon as one read does. */
  const barsOf = Effect.fn("WeeklyCup.barsOf")(function* (
    maps: ReadonlyArray<CupMap>,
    discordIds: ReadonlyArray<string>,
  ) {
    const accounts = yield* accountsOf(discordIds);
    return (yield* Effect.forEach(maps, (map) => readMap(map, accounts))).flat();
  });

  /**
   * Each of these Maps read once for the week's Entrants, each read on its own, so one Steam drops
   * keeps that Map's last times. A failed read reaches ops once until the reads land again. The
   * pfids of the Maps whose read landed.
   */
  const readTimes = Effect.fn("WeeklyCup.readTimes")(function* (
    now: number,
    week: CupWeek,
    race: Race,
    barsAt: number | null,
  ) {
    const entrants = yield* log.entrants(guildId, week.week);
    const signedUpAt = new Map(entrants.map((e) => [e.discordId, e.signedUpAt]));
    const accounts = yield* accountsOf(entrants.map((e) => e.discordId));
    const held = new Map(
      (yield* log.times(guildId, week.week)).map((t) => [`${t.pfid} ${t.discordId}`, t]),
    );
    let failed: SteamUnavailable | null = null;
    const landed: Array<string> = [];
    for (const map of race.maps) {
      const read = yield* Effect.either(readMap(map, accounts));
      if (read._tag === "Left") {
        failed = read.left;
        continue;
      }
      landed.push(map.pfid);
      for (const entry of read.right) {
        const key = `${map.pfid} ${entry.discordId}`;
        const bar = race.bars.find((b) => b.pfid === map.pfid && b.discordId === entry.discordId);
        const before = held.get(key);
        if (bar !== undefined && entry.ticks >= bar.ticks) continue;
        if (before !== undefined && entry.ticks >= before.ticks) continue;
        const lastRead = lastReads.get(map.pfid) ?? 0;
        // A first counted time beats the bar, taken as racing opened or as they signed up.
        const { time, flag } = yield* counted(
          entry,
          before,
          before === undefined
            ? Math.max(barsAt ?? week.voteClosesAt, signedUpAt.get(entry.discordId) ?? 0, lastRead)
            : Math.max(before.seenAt, lastRead),
          now,
        );
        yield* log.putTime(guildId, week.week, time);
        held.set(key, time);
        if (flag !== null)
          yield* kit.alerts.post(
            `Weekly Cup Flag for ${week.week} in ${guildId}: <@${entry.discordId}> set ${formatTime(entry.ticks)} on ${mapName(map)}, ${describeGap(flag)} after their first time on it, ${flag.byGhosts ? "by their Ghosts" : "by the bot's reads"}. It still counts.`,
          );
      }
      lastReads.set(map.pfid, now);
    }
    yield* kit.attempt(
      "read",
      "read a Weekly Cup Map",
      week.week,
      failed === null ? Effect.void : Effect.fail(failed),
    );
    return landed;
  });

  /** The standings from the counted times, for the week's Entrants now. */
  const standingsOf = Effect.fn("WeeklyCup.standingsOf")(function* (
    week: CupWeek,
    race: Race,
    final: boolean,
    finalReads: Readonly<Record<string, number>> = {},
  ) {
    const times: Record<string, Record<string, number>> = {};
    for (const t of yield* log.times(guildId, week.week))
      (times[t.pfid] ??= {})[t.discordId] = t.ticks;
    const standings = cupStandings(race.maps, yield* kit.entrantIds(week.week), times);
    const lateReads = final
      ? race.maps.flatMap((m): Array<StandingsView["lateReads"][number]> => {
          const at = finalReads[m.pfid];
          if (at === undefined) return [{ pfid: m.pfid, at: null }];
          return at - week.endsAt >= LATE_READ_AFTER ? [{ pfid: m.pfid, at }] : [];
        })
      : [];
    return {
      guildId,
      week,
      maps: race.maps,
      standings,
      final,
      lateReads,
    } satisfies StandingsView;
  });

  /** Racing: read the Cup Maps, show the standings, and read again in 5 minutes. */
  const live = Effect.fn("WeeklyCup.live")(function* (now: number, week: CupWeek, cup: CupRecord) {
    const race = yield* raceOf(week.week);
    yield* readTimes(now, week, race, cup.barsAt);
    const view = yield* standingsOf(week, race, false);
    yield* kit.show(week, cup, "standings", view, "update the Weekly Cup's standings");
    return Math.min(now + READ_EVERY, week.endsAt);
  });

  /**
   * Sunday 20:00: a final read of each Cup Map, recorded as it lands (`finalReads`), so a retry
   * each minute while Steam fails reads only the Maps still missing, until 30 minutes on, when
   * those stand on their last reads; then the results, saying which Maps were read late, posted
   * once (recorded as they go up, so a restart never posts them again), and the week is final.
   */
  const finish = Effect.fn("WeeklyCup.finish")(function* (
    now: number,
    week: CupWeek,
    cup: CupRecord,
  ) {
    let current = cup;
    if (current.shown.results.length === 0) {
      const race = yield* raceOf(week.week);
      const missing = race.maps.filter((m) => current.finalReads[m.pfid] === undefined);
      const landed =
        missing.length === 0
          ? []
          : yield* readTimes(now, week, { ...race, maps: missing }, current.barsAt);
      if (landed.length > 0) {
        const finalReads = { ...current.finalReads };
        for (const pfid of landed) finalReads[pfid] = now;
        current = { ...current, finalReads };
        yield* log.put(guildId, week.week, current);
      }
      if (landed.length < missing.length && now < week.endsAt + FINAL_WAIT)
        return now + RETRY_EVERY;
      const view = yield* standingsOf(week, race, true, current.finalReads);
      const posted = yield* kit.show(
        week,
        current,
        "results",
        view,
        "post the Weekly Cup's results",
      );
      if (Option.isNone(posted)) return now + RETRY_EVERY;
      current = posted.value;
    }
    // The live standings stop saying they are read every 5 minutes, and point to the results:
    // best effort (ops told if refused), and one someone deleted isn't posted again below them.
    if (current.shown.standings.length > 0) {
      const view = yield* standingsOf(week, yield* raceOf(week.week), true, current.finalReads);
      const closed = yield* kit.show(
        week,
        current,
        "standings",
        view,
        "close the Weekly Cup's live standings",
        "closeStandings",
      );
      if (Option.isSome(closed)) current = closed.value;
    }
    yield* kit.enter(week, current, "final");
    return week.nextOpensAt;
  });

  return { cupMapsOf, barsOf, live, finish };
};

export type CupRace = ReturnType<typeof makeRace>;

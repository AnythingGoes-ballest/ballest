// What every part of one server's Weekly Cup shares (spec #353): its ports, taken once as the Cup
// is built, its lock, and the few steps the schedule, the vote, the race and the presses all take:
// trying something that can fail (ops told once), showing a slot, and moving the week on.
import { Effect, Option } from "effect";
import { OpsAlerts } from "../ops.js";
import { Steam } from "../ports.js";
import { MapPreviews } from "../previews.js";
import { GhostDates } from "../steam/ghosts.js";
import {
  CupChannel,
  CupLinks,
  type CupNotice,
  type CupState,
  type Slot,
  type SlotViews,
} from "./model.js";
import { CupLog, type CupRecord } from "./record.js";
import type { CupWeek } from "./week.js";

export const makeKit = Effect.fn("WeeklyCup.makeKit")(function* (guildId: string) {
  const log = yield* CupLog;
  const channel = yield* CupChannel;
  const alerts = yield* OpsAlerts;
  const links = yield* CupLinks;
  const steam = yield* Steam;
  const ghosts = yield* GhostDates;
  const previews = yield* MapPreviews;
  const lock = yield* Effect.makeSemaphore(1);
  /** One press or step acts on the Cup at a time. */
  const locked = lock.withPermits(1);

  /**
   * Try something Steam or Discord can refuse. A refusal reaches ops as "Multiballs couldn't
   * <what> for <week> in <server>: <reason>", once per `kind` until one succeeds (across restarts
   * too, OpsAlerts keeping the key), and comes back as none, for the caller to try again (mostly
   * in a minute: RETRY_EVERY). A one-shot, never tried again, is told every time instead, under a
   * kind of its own, so it never silences a later failure of something that is retried.
   */
  const attempt = Effect.fn("WeeklyCup.attempt")(function* <
    A,
    E extends { readonly reason: string },
  >(
    kind: string,
    what: string,
    week: string,
    effect: Effect.Effect<A, E>,
    told: "once" | "always" = "once",
  ) {
    const key = `weekly-cup:${guildId}:${kind}`;
    const done = yield* Effect.either(effect);
    if (done._tag === "Left") {
      const alert = `Multiballs couldn't ${what} for ${week} in ${guildId}: ${done.left.reason}`;
      yield* told === "once" ? alerts.post(alert, { key, kind: "failing" }) : alerts.post(alert);
      return Option.none<A>();
    }
    if (told === "once") yield* alerts.forget(key);
    return Option.some(done.right);
  });

  const entrantIds = Effect.fn("WeeklyCup.entrantIds")(function* (week: string) {
    return (yield* log.entrants(guildId, week)).map((e) => e.discordId);
  });

  /**
   * Show a slot's view over what it showed, and record the messages that show it now, straight
   * after: the record as it then stands, or none when Discord refused (ops told by `attempt`).
   * A `oneShot` (its kind) is shown once, never tried again: ops is told every time it fails, and
   * a message of it someone deleted isn't posted afresh.
   */
  const show = Effect.fn("WeeklyCup.show")(function* <S extends Slot>(
    week: CupWeek,
    cup: CupRecord,
    slot: S,
    view: SlotViews[S],
    what: string,
    oneShot?: string,
  ) {
    const shown = yield* oneShot === undefined
      ? attempt(slot, what, week.week, channel.show(slot, cup.shown[slot], view))
      : attempt(
          oneShot,
          what,
          week.week,
          channel.show(slot, cup.shown[slot], view, { repost: false }),
          "always",
        );
    if (Option.isNone(shown)) return Option.none<CupRecord>();
    const before = cup.shown[slot];
    if (shown.value.length === before.length && shown.value.every((id, i) => id === before[i]))
      return Option.some(cup);
    const next = { ...cup, shown: { ...cup.shown, [slot]: shown.value } };
    yield* log.put(guildId, week.week, next);
    return Option.some(next);
  });

  /** Redraw the week's post as it stands; the record as it then stands. */
  const redraw = Effect.fn("WeeklyCup.redraw")(function* (week: CupWeek, cup: CupRecord) {
    const view = { guildId, week, state: cup.state, entrants: yield* entrantIds(week.week) };
    const shown = yield* show(week, cup, "post", view, "update the Weekly Cup's post");
    return Option.getOrElse(shown, () => cup);
  });

  /** Move the week to `state` and redraw its post; the record as it then stands. */
  const enter = Effect.fn("WeeklyCup.enter")(function* (
    week: CupWeek,
    cup: CupRecord,
    state: CupState,
  ) {
    const next = { ...cup, state };
    yield* log.put(guildId, week.week, next);
    yield* Effect.logInfo(`weekly cup: ${guildId} ${week.week} is ${state}`);
    return yield* redraw(week, next);
  });

  /** Call the week off, and tell its Entrants. */
  const callOff = Effect.fn("WeeklyCup.callOff")(function* (
    week: CupWeek,
    cup: CupRecord,
    notice:
      | { readonly _tag: "Skipped" }
      | { readonly _tag: "Cancelled"; readonly reason: "entrants" | "maps" },
  ) {
    const state = notice._tag === "Skipped" ? "skipped" : "cancelled";
    yield* enter(week, cup, state);
    const told: CupNotice = { ...notice, week: week.week, entrants: yield* entrantIds(week.week) };
    yield* attempt(
      "callOff",
      `tell the Weekly Cup's Entrants it was ${state}`,
      week.week,
      channel.say(told),
      "always",
    );
  });

  return {
    guildId,
    log,
    channel,
    alerts,
    links,
    steam,
    ghosts,
    previews,
    locked,
    attempt,
    entrantIds,
    show,
    redraw,
    enter,
    callOff,
  };
});

/** One server's Weekly Cup's shared parts. */
export type CupKit = Effect.Effect.Success<ReturnType<typeof makeKit>>;

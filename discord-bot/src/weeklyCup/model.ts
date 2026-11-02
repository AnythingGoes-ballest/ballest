// The Weekly Cup's words and ports (spec #353): its rules as numbers, what each of its messages
// shows, and the ports the schedule acts through (the Cup's channel and the Entrants' Links; the
// record is record.ts). Everything else in this folder builds on these.
import { Context, Data, type Effect, type Option, Schema } from "effect";
import type { DrawnMap } from "../domain.js";
import type { Preview } from "../previews.js";
import type { CupStandings } from "./points.js";
import type { CupWeek } from "./week.js";

/** A Cup with fewer Entrants than this at Thursday 12:00 is cancelled. */
export const MIN_ENTRANTS = 2;
/** How many Maps the Shortlist draws. */
export const SHORTLIST_SIZE = 10;
/** How many of them the vote makes Cup Maps, and how many each Entrant may pick. */
export const CUP_MAPS = 3;
/** The Cup's Eligible Map limit on author time, in seconds. */
export const CUP_AUTHOR_LIMIT = 3 * 60;
/** Most candidate Maps checked for the Shortlist: one Steam read each. */
export const SHORTLIST_CHECKS = 100;
/** A board check that Steam drops is retried this many times. */
export const READ_RETRIES = 2;
/** How soon a post, draw or read that failed is tried again. */
export const RETRY_EVERY = 60_000;
/** How often the Cup Maps are read while racing. */
export const READ_EVERY = 5 * 60_000;
/** How long the final read waits for Steam before the results stand on the last reads. */
export const FINAL_WAIT = 30 * 60_000;
/** A final read this long or more after Sunday 20:00 is late, and the results say so. */
export const LATE_READ_AFTER = 60_000;
/** A PB set longer than this after an Entrant's first time on a Map is a Flag. */
export const FLAG_AFTER = 30 * 60_000;
/** How far a Ghost's date, from the player's PC clock, may sit outside when its run could be. */
export const GHOST_CLOCK_SLACK = 60_000;
/** A Ghost read that takes longer gives no date, so a stalled download never holds the Cup. */
export const GHOST_READ_TIMEOUT = "30 seconds";

export const CUP_STATES = ["open", "voting", "racing", "final", "cancelled", "skipped"] as const;
export type CupState = (typeof CUP_STATES)[number];

/** Whether a member can still sign up for, or withdraw from, a Cup in this state. */
export const signUpOpen = (state: CupState) =>
  state === "open" || state === "voting" || state === "racing";

/** A Map drawn for a Shortlist, as the record keeps it. */
export const CupMap = Schema.Struct({
  pfid: Schema.String,
  title: Schema.String,
  creator: Schema.String,
  previewUrl: Schema.String,
  /** Its author Medal, in seconds. */
  authorSeconds: Schema.Number,
  boardId: Schema.Number,
  worldRecordTicks: Schema.Number,
});
export type CupMap = typeof CupMap.Type;

export const cupMapOf = (m: DrawnMap): CupMap => ({
  pfid: m.pfid,
  title: m.title,
  creator: m.creator,
  previewUrl: m.previewUrl,
  authorSeconds: m.medals.author,
  boardId: m.boardId,
  worldRecordTicks: m.worldRecordTicks,
});

// ---------------------------------------------------------------- what each message shows

/** What the Cup's post shows: its week, where it stands, and its Entrants in sign-up order. */
export interface CupPostView {
  readonly guildId: string;
  readonly week: CupWeek;
  readonly state: CupState;
  readonly entrants: ReadonlyArray<string>;
}

/** The Shortlist's post: each Map with its Workshop picture (none if Steam gave none). */
export interface ShortlistView {
  readonly guildId: string;
  readonly week: CupWeek;
  readonly maps: ReadonlyArray<{ readonly map: CupMap; readonly picture: Preview | null }>;
  /** How many the Shortlist draws when that many are eligible. */
  readonly wanted: number;
  /** Once the vote has closed: the post keeps its Maps but loses its vote. */
  readonly closed: boolean;
}

/** The standings as the last reads have them: live while racing, `final` for the results. */
export interface StandingsView {
  readonly guildId: string;
  readonly week: CupWeek;
  /** The Cup Maps, in rank order. */
  readonly maps: ReadonlyArray<CupMap>;
  readonly standings: CupStandings;
  readonly final: boolean;
  /**
   * In the results, the Cup Maps whose final read came LATE_READ_AFTER or more after Sunday 20:00
   * (when it landed) or never did (null: they stand on the last read before), in rank order.
   */
  readonly lateReads: ReadonlyArray<{ readonly pfid: string; readonly at: number | null }>;
}

/**
 * The Cup's messages that stay up, each shown by `CupChannel.show` over the messages it showed
 * before: the week's post, the Shortlist, the live standings and the results.
 */
export interface SlotViews {
  readonly post: CupPostView;
  readonly shortlist: ShortlistView;
  readonly standings: StandingsView;
  readonly results: StandingsView;
}
export type Slot = keyof SlotViews;
export const SLOTS = [
  "post",
  "shortlist",
  "standings",
  "results",
] as const satisfies ReadonlyArray<Slot>;

/** A message in the Cup's channel beside its post, pinging the week's Entrants. */
export type CupNotice =
  | {
      readonly _tag: "Cancelled";
      /** Fewer than 2 Entrants, or no Map none of them has Played. */
      readonly reason: "entrants" | "maps";
      readonly week: string;
      readonly entrants: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Skipped";
      readonly week: string;
      readonly entrants: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "CupMaps";
      readonly week: CupWeek;
      readonly entrants: ReadonlyArray<string>;
      /** In rank order, each with its votes. */
      readonly maps: ReadonlyArray<{ readonly map: CupMap; readonly votes: number }>;
    };

/** What Skip answers: a server admin is asked to confirm (it can't be undone), anyone else why not. */
export type SkipAsk =
  | { readonly _tag: "Confirm"; readonly week: string }
  | { readonly _tag: "Refused"; readonly text: string };

// ---------------------------------------------------------------- ports

/** Discord refused a post or an edit. */
export class CupPostFailed extends Data.TaggedError("CupPostFailed")<{
  readonly reason: string;
}> {}

/** How a slot is shown. */
export interface ShowOptions {
  /** Post a slot whose message someone deleted afresh (the default), or refuse. */
  readonly repost?: boolean;
}

/** One server's #weekly-cup. */
export class CupChannel extends Context.Tag("multiballs/CupChannel")<
  CupChannel,
  {
    /**
     * Show a slot's view over the messages it showed before (none: post it), and say which
     * messages show it now. The channel decides how: an edit only where the message would change,
     * a fresh post if someone deleted one, as many messages as the view takes, and a first post
     * Discord drops if it is sent twice (a restart between the send and its record). With
     * `repost: false`, a deleted message is refused instead of posted afresh.
     */
    readonly show: <S extends Slot>(
      slot: S,
      shown: ReadonlyArray<string>,
      view: SlotViews[S],
      options?: ShowOptions,
    ) => Effect.Effect<ReadonlyArray<string>, CupPostFailed>;
    readonly say: (notice: CupNotice) => Effect.Effect<void, CupPostFailed>;
  }
>() {}

/** Which Steam account each Entrant linked: whose Played Maps keep a Map off the Shortlist. */
export class CupLinks extends Context.Tag("multiballs/CupLinks")<
  CupLinks,
  { readonly steamIdOf: (discordId: string) => Effect.Effect<Option.Option<string>> }
>() {}

// The engine's edges. Real adapters (steam-user, discord.js, SQLite) and test fakes both
// implement these; the engine never sees Discord ids or Steam protobufs.
import { Context, Data, type Effect, type Option } from "effect";
import { expiresAt, standings } from "./domain.js";
import type {
  DrawnMap,
  Link,
  MapInfo,
  Match,
  MatchState,
  MatchType,
  MedalKind,
  Minutes,
  PbEvent,
  Player,
  Standing,
  VenueName,
} from "./domain.js";

// ---------------------------------------------------------------- Steam

export class SteamUnavailable extends Data.TaggedError("SteamUnavailable")<{
  readonly reason: string;
}> {}
export class ProfileNotFound extends Data.TaggedError("ProfileNotFound")<{
  readonly input: string;
  readonly reason: string;
}> {}

export interface Entry {
  readonly steamId: string;
  readonly ticks: number;
  /** The run's Ghost replay (a UGC id), when the read says which; see steam/ghosts.ts. */
  readonly ugcId?: string;
}

/** What a candidate Map's board says, for the Eligible Map check. */
export interface MapCheck {
  /** Null when no board exists yet: nobody has finished the Map. */
  readonly boardId: number | null;
  readonly worldRecordTicks: number | null;
  /** The asked-about Players who hold a time on it, with that time: their PB. */
  readonly played: ReadonlyArray<Entry>;
}

export interface ProfilePreview {
  readonly steamId: string;
  readonly personaName: string;
  readonly avatarUrl: string;
  /** How many of the Circuit Tracks this account holds a time on (the Link confirmation shows it). */
  readonly campaignTracks: number;
  /** How many Circuit Tracks there are. */
  readonly campaignTrackTotal: number;
}

export class Steam extends Context.Tag("multiballs/Steam")<
  Steam,
  {
    /** Every Workshop Map, from the Workshop list alone (no board reads). */
    readonly catalogue: Effect.Effect<ReadonlyArray<MapInfo>, SteamUnavailable>;
    /** One candidate Map's board: its id, world record, and which of these Players have Played it. */
    readonly check: (
      map: MapInfo,
      steamIds: ReadonlyArray<string>,
    ) => Effect.Effect<MapCheck, SteamUnavailable>;
    /** The given Players' entries on a board; Players without an entry are simply absent. */
    readonly readPlayers: (
      boardId: number,
      steamIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Entry>, SteamUnavailable>;
    /** A pasted profile link, custom URL name or SteamID64, resolved to an account. */
    readonly resolveProfile: (
      input: string,
    ) => Effect.Effect<ProfilePreview, ProfileNotFound | SteamUnavailable>;
  }
>() {}

// ---------------------------------------------------------------- Chosen Skins

/**
 * A Player's Chosen Skin (GLOSSARY.md, spec #276): the object path chosen_skins.skin holds, or
 * null for none, when they are drawn in their hue marble.
 */
export type ChosenSkin = string | null;

/** Every Player's Chosen Skin, by SteamID; a Player with none is absent. */
export type ChosenSkinPicks = ReadonlyMap<string, string>;

/** A Player's Chosen Skin out of every pick. */
export const chosenSkinOf = (chosen: ChosenSkinPicks, steamId: string): ChosenSkin =>
  chosen.get(steamId) ?? null;

/**
 * Each Player's Chosen Skin, read from the site's database: the object path it stores, by
 * SteamID. The engine reads it as it builds each Card view and thread post, so
 * the post carries the Skins its message shows (chosenSkins.ts has the adapters).
 */
export class ChosenSkins extends Context.Tag("multiballs/ChosenSkins")<
  ChosenSkins,
  {
    /** Every Chosen Skin, as the object path chosen_skins.skin holds, by SteamID. */
    readonly all: Effect.Effect<ChosenSkinPicks>;
  }
>() {}

/**
 * The Chosen Skins of the Players a view or post shows, as they stood when it was built: the
 * object path by SteamID, and a Player with none absent.
 */
export type ShownSkins = Readonly<Record<string, string>>;

// ---------------------------------------------------------------- Discord surface

/** Everything the Match Card image and its embed are drawn from. */
export interface CardView {
  readonly matchId: string;
  /** The Venue whose channel holds the Card. */
  readonly venue: VenueName;
  readonly state: MatchState;
  readonly type: MatchType;
  readonly minutes: Minutes;
  readonly creator: Player;
  readonly target: Player | null;
  readonly players: ReadonlyArray<Player>;
  readonly map: DrawnMap | null;
  readonly standings: ReadonlyArray<Standing>;
  /** Shown as a live Discord timestamp while the Invite is open. */
  readonly expiresAt: number | null;
  /** Shown as a live Discord timestamp while the Match is live. */
  readonly endsAt: number | null;
  /** Time is up and the Result is waiting for Steam: no buttons, and the Card says so. */
  readonly waitingForSteam: boolean;
  /** The Chosen Skins of its Players (and the Challenge's opponent), each drawn in theirs. */
  readonly skins: ShownSkins;
}

/** The Chosen Skins, out of `chosen`, of the given Players. */
export const shownSkins = (chosen: ChosenSkinPicks, players: ReadonlyArray<Player>): ShownSkins =>
  Object.fromEntries(
    players.flatMap((p) => {
      const skin = chosenSkinOf(chosen, p.steamId);
      return skin === null ? [] : [[p.steamId, skin] as const];
    }),
  );

/**
 * A Match as its Card shows it: the Map stays sealed while the Invite is open. `chosen` is every
 * Chosen Skin as it stands now; the view keeps its Players'.
 */
export const cardView = (m: Match, chosen: ChosenSkinPicks): CardView => ({
  matchId: m.id,
  venue: m.venue,
  state: m.state,
  type: m.type,
  minutes: m.minutes,
  creator: m.creator,
  target: m.target,
  players: m.players,
  map: m.state === "invite" ? null : m.map,
  standings: standings(m),
  expiresAt: m.state === "invite" ? expiresAt(m) : null,
  endsAt: m.state === "live" ? m.endsAt : null,
  waitingForSteam: m.state === "live" && m.waitingForSteam,
  skins: shownSkins(chosen, m.target === null ? m.players : [...m.players, m.target]),
});

export interface Improvement {
  readonly player: Player;
  readonly ticks: number;
  readonly medal: MedalKind | null;
  /** Rank within the Match after this time; 1 is drawn gold. */
  readonly rank: number;
  readonly previousTicks: number | null;
  readonly previousRank: number | null;
  /** The world record this run beat, as it stood at that moment; null if it didn't beat one. */
  readonly beatWorldRecord: number | null;
}

/**
 * What goes in a Match Thread. A post about one Player carries `skin`, that Player's Chosen Skin
 * (or null) when it was built, for its line's marble; one with a Card carries them in the Card.
 */
export type ThreadPost = Data.TaggedEnum<{
  Opened: {
    readonly by: Player;
    readonly skin: ChosenSkin;
    readonly type: MatchType;
    readonly minutes: Minutes;
  };
  /** `expiresAt` is when the challenged Player must answer by. */
  Challenged: {
    readonly by: Player;
    readonly skin: ChosenSkin;
    readonly target: Player;
    readonly minutes: Minutes;
    readonly expiresAt: number;
  };
  Accepted: { readonly player: Player; readonly skin: ChosenSkin };
  Joined: { readonly player: Player; readonly skin: ChosenSkin };
  Left: { readonly player: Player; readonly skin: ChosenSkin };
  /**
   * The start ping. `players` are the ones sent off, and pinged: everyone at the start, or
   * one Player joining a live Lobby. `card` is the live Card it shows.
   */
  Started: {
    readonly players: ReadonlyArray<Player>;
    readonly map: DrawnMap;
    readonly endsAt: number;
    readonly card: CardView;
  };
  Improved: { readonly improvement: Improvement; readonly skin: ChosenSkin };
  /** `card` is the finished Card the Result shows. */
  /** Players who had finished the drawn Map before: only a run faster than `ticks`, their PB, counts. */
  PlayedBefore: {
    readonly bars: ReadonlyArray<{ readonly player: Player; readonly ticks: number }>;
  };
  /** After the Result: every PB of the Match over time, for the progression graph. */
  Progression: { readonly card: CardView; readonly history: ReadonlyArray<PbEvent> };
  /** `steamDown`: the end read never came back, so the times are the last ones polled. */
  Result: {
    readonly standings: ReadonlyArray<Standing>;
    readonly card: CardView;
    readonly steamDown: boolean;
  };
  /** Time is up but Steam isn't answering the end read, so the Result waits for it. */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a variant with no fields, as Data.TaggedEnum spells it
  WaitingForSteam: {};
  /** No Map is eligible, so the Invite is cancelled; everyone in it is told. */
  NoMap: { readonly players: ReadonlyArray<Player> };
  /**
   * In a finished Match's thread: `by` pressed Play again and opened a Lobby. Its `others`, the
   * finished Match's other Players, are pinged to join it.
   */
  PlayingAgain: {
    readonly by: Player;
    readonly skin: ChosenSkin;
    readonly others: ReadonlyArray<Player>;
    readonly minutes: Minutes;
  };
  /** Every Player left the live Match before anyone set a time, so it is cancelled. */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a variant with no fields, as Data.TaggedEnum spells it
  Abandoned: {};
}>;
export const ThreadPost = Data.taggedEnum<ThreadPost>();

/** Why a cancelled Match keeps its Card and thread: no Map was eligible, or everyone left before setting a time. */
export type KeptReason = "noEligibleMap" | "abandoned";
export type RemovalReason = "expired" | "cancelled" | "declined" | KeptReason;
export const isKept = (reason: RemovalReason): reason is KeptReason =>
  reason === "noEligibleMap" || reason === "abandoned";

export class Surface extends Context.Tag("multiballs/Surface")<
  Surface,
  {
    /**
     * Whether this Venue's channel runs: false for one left out (it failed its setup or checks)
     * or whose server removed the bot, whose Matches no Player can see or leave.
     */
    readonly runs: (venue: VenueName) => boolean;
    /**
     * Create or redraw a Match's Card in its Venue's channel (the adapter handles the Footer and
     * the Match Thread). Posts and removals go wherever the Card is.
     */
    readonly showCard: (view: CardView) => Effect.Effect<void>;
    readonly post: (matchId: string, post: ThreadPost) => Effect.Effect<void>;
    /**
     * A Match that ends without a Result: an Invite that never started, or a live Match
     * everyone left before setting a time. Its Card and Match Thread go, unless the reason
     * is a KeptReason: then they stay, saying why, so the Players can read it.
     */
    readonly remove: (matchId: string, reason: RemovalReason) => Effect.Effect<void>;
  }
>() {}

/** Where a Match sits in its Venue's channel: its Card's message, and its Match Thread once started. */
export interface MatchPlace {
  readonly messageId: string;
  readonly threadId: string | null;
}

/** Where each Match's Card and Match Thread are, so the Activity can link to them. */
export class MatchLinks extends Context.Tag("multiballs/MatchLinks")<
  MatchLinks,
  {
    /**
     * Where `venue`'s channel holds a Match's Card; none when it holds none (yet, or any more), or
     * the Venue isn't running.
     */
    readonly of: (venue: VenueName, matchId: string) => Effect.Effect<Option.Option<MatchPlace>>;
  }
>() {}

// ---------------------------------------------------------------- the ping role

/** Discord wouldn't read or change a member's @Multiplayer ping role just now. */
export class PingRoleUnavailable extends Data.TaggedError("PingRoleUnavailable")<{
  readonly reason: string;
}> {}

/**
 * Each Venue's @Multiplayer ping role on its server: the one role the bot ever adds or removes
 * there. Every read asks Discord, so a moderator's change shows at once.
 */
export class PingRole extends Context.Tag("multiballs/PingRole")<
  PingRole,
  {
    readonly has: (
      venue: VenueName,
      discordId: string,
    ) => Effect.Effect<boolean, PingRoleUnavailable>;
    readonly add: (venue: VenueName, discordId: string) => Effect.Effect<void, PingRoleUnavailable>;
    readonly remove: (
      venue: VenueName,
      discordId: string,
    ) => Effect.Effect<void, PingRoleUnavailable>;
  }
>() {}

// ---------------------------------------------------------------- Store

export class Store extends Context.Tag("multiballs/Store")<
  Store,
  {
    readonly getLink: (discordId: string) => Effect.Effect<Option.Option<Link>>;
    readonly putLink: (link: Link) => Effect.Effect<void>;
    /** Every Link, for picking who to challenge. */
    readonly links: Effect.Effect<ReadonlyArray<Link>>;
    readonly nextMatchId: Effect.Effect<string>;
    readonly getMatch: (id: string) => Effect.Effect<Option.Option<Match>>;
    readonly putMatch: (match: Match) => Effect.Effect<void>;
    readonly deleteMatch: (id: string) => Effect.Effect<void>;
    /** Matches still open as an Invite or live. */
    readonly activeMatches: Effect.Effect<ReadonlyArray<Match>>;
    /** Whether this member has answered this Venue's @Multiplayer ping offer, either way. */
    readonly hasAnsweredPingOffer: (venue: VenueName, discordId: string) => Effect.Effect<boolean>;
    /** Remember that this member has answered the Venue's offer; answering again changes nothing. */
    readonly answerPingOffer: (venue: VenueName, discordId: string) => Effect.Effect<void>;
  }
>() {}

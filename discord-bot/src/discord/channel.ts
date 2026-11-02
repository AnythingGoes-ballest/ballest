// A Venue's Match channel, as the Surface sees it: messages and Match Threads to draw things in.
// It speaks in what to draw, not how, so the Surface's rules run against an in-memory channel
// in tests; this adapter draws each one with the renderer and runs it on discord.js.
import { Context, Data, Effect, ExecutionStrategy, Layer, Option, Scope } from "effect";
import type { MapInfo, VenueName } from "../domain.js";
import type { CardView, KeptReason, ThreadPost } from "../ports.js";
import { MapPreviews, previewUri } from "../previews.js";
import { Renderer, RenderError } from "../render/renderer.js";
import {
  Discord,
  type DiscordError,
  type DiscordVenue,
  hasCode,
  tryDiscord,
  UNKNOWN_CHANNEL,
  UNKNOWN_MESSAGE,
} from "./client.js";
import { Marbles } from "./marbles.js";
import { makeThreadNotices } from "./threadNotices.js";
import {
  cardMessage,
  clockMessage,
  closedCardMessage,
  fingerprint,
  footerMessage,
  threadMessage,
  type ThreadArt,
  threadName,
} from "./messages.js";

/** What a channel message shows. */
export type Drawing = Data.TaggedEnum<{
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a variant with no fields, as Data.TaggedEnum spells it
  Footer: {};
  Card: { readonly view: CardView };
  /** A Match cancelled but kept in view: no Map was eligible, or everyone left before setting a time. */
  Closed: { readonly reason: KeptReason };
}>;
export const Drawing = Data.taggedEnum<Drawing>();

/** The message or thread was deleted (by hand, or before a restart). */
export class Gone extends Data.TaggedError("Gone")<{ readonly id: string }> {}

/** Anything a channel operation can fail with. */
export type ChannelError = Gone | DiscordError | RenderError;

/** One Venue's channel. */
export interface Channel {
  /**
   * Post a message; its id. A posted Lobby Card is the one draw that pings @Multiplayer ping,
   * since Discord only notifies a mention on the post that creates a message.
   */
  readonly post: (drawing: Drawing) => Effect.Effect<string, DiscordError | RenderError>;
  /**
   * What a drawing looks like as a hash of the message it becomes, so a message already showing
   * it is left alone: equal fingerprints draw the same message.
   */
  readonly fingerprint: (drawing: Drawing) => Effect.Effect<string, DiscordError | RenderError>;
  /** Draw over a message. Never pings: a redrawn Lobby Card keeps its line but mentions nobody. */
  readonly redraw: (messageId: string, drawing: Drawing) => Effect.Effect<void, ChannelError>;
  readonly deleteMessage: (messageId: string) => Effect.Effect<void, Gone | DiscordError>;
  /** Start a Card's Match Thread on its message; the thread's id. */
  readonly startThread: (
    messageId: string,
    view: CardView,
  ) => Effect.Effect<string, Gone | DiscordError>;
  readonly deleteThread: (threadId: string) => Effect.Effect<void, Gone | DiscordError>;
  /** Open a Match Thread with its clock; the clock message's id. */
  readonly postClock: (
    threadId: string,
    view: CardView,
  ) => Effect.Effect<string, Gone | DiscordError>;
  /** Redraw a thread's clock for the Match as it stands, or as "cancelled" once it's closed. */
  readonly redrawClock: (
    threadId: string,
    messageId: string,
    view: CardView | "cancelled",
  ) => Effect.Effect<void, Gone | DiscordError>;
  readonly postInThread: (
    threadId: string,
    matchId: string,
    post: ThreadPost,
  ) => Effect.Effect<void, ChannelError>;
  /** The id of the channel's newest message, whoever posted it. */
  readonly lastMessageId: Effect.Effect<string | null, DiscordError>;
}

/** Every running Venue's channel by its Venue's name, home first; fixed until the bot restarts. */
export class VenueChannels extends Context.Tag("multiballs/VenueChannels")<
  VenueChannels,
  {
    readonly all: ReadonlyMap<VenueName, Channel>;
  }
>() {}

const goneIfUnknown = Effect.fn("Channel.goneIfUnknown")(function* (id: string, e: DiscordError) {
  return yield* hasCode(e, UNKNOWN_MESSAGE, UNKNOWN_CHANNEL)
    ? Effect.fail(new Gone({ id }))
    : Effect.fail(e);
});

/** A Venue's channel on discord.js: its Players named as in its server, its ping role in Lobby Cards. */
const discordChannel = Effect.fn("Channel.make")(function* (venue: DiscordVenue) {
  const renderer = yield* Renderer;
  const previews = yield* MapPreviews;
  const marbles = yield* Marbles;
  const { channel } = venue;
  const notices = makeThreadNotices(channel);
  // In the background: startup doesn't wait on a few hundred message reads.
  yield* Effect.forkScoped(notices.sweep());

  // Only Unknown Message: Unknown Channel means the channel itself is gone, which the Surface tells ops.
  const fetchMessage = Effect.fn("Channel.fetchMessage")(function* (id: string) {
    return yield* tryDiscord("fetch message", () => channel.messages.fetch(id)).pipe(
      Effect.catchTag("DiscordError", (e): Effect.Effect<never, Gone | DiscordError> =>
        hasCode(e, UNKNOWN_MESSAGE) ? Effect.fail(new Gone({ id })) : Effect.fail(e),
      ),
    );
  });
  const fetchThread = Effect.fn("Channel.fetchThread")(function* (id: string) {
    return yield* tryDiscord("fetch thread", () => channel.threads.fetch(id)).pipe(
      Effect.catchTag("DiscordError", (e) => goneIfUnknown(id, e)),
      Effect.flatMap((thread) =>
        thread === null ? Effect.fail(new Gone({ id })) : Effect.succeed(thread),
      ),
    );
  });

  /** Every Player's name in this server, for the images. */
  const namesOf = Effect.fn("Channel.namesOf")(function* (view: CardView) {
    const players = view.target === null ? view.players : [...view.players, view.target];
    const names = new Map<string, string>();
    for (const p of players) names.set(p.discordId, yield* venue.displayName(p.discordId));
    return names;
  });

  /** The Map's preview as the renderer takes it, or null to draw the stand-in. */
  const previewOf = Effect.fn("Channel.previewOf")(function* (map: MapInfo | null) {
    if (map === null) return null;
    const preview = yield* previews.of(map.previewUrl);
    return Option.getOrNull(Option.map(preview, previewUri));
  });

  const drawCard = Effect.fn("Channel.drawCard")(function* (view: CardView) {
    return yield* renderer.card({
      view,
      names: yield* namesOf(view),
      preview: yield* previewOf(view.map),
    });
  });

  /** `announce`: this is the post that creates the message, so a Lobby's Card may ping the role. */
  const render = Effect.fn("Channel.render")(function* (drawing: Drawing, announce: boolean) {
    return yield* Drawing.$match(drawing, {
      Footer: () => renderer.footer.pipe(Effect.map((png) => footerMessage(png))),
      Card: ({ view }) =>
        drawCard(view).pipe(
          Effect.map((png) => cardMessage(view, png, { roleId: venue.pingRoleId, announce })),
        ),
      Closed: ({ reason }) => Effect.succeed(closedCardMessage(reason)),
    });
  });

  /** The image a thread post carries, if any. */
  const threadPng = Effect.fn("Channel.threadPng")(function* (post: ThreadPost) {
    if (post._tag === "Improved")
      return yield* renderer.improvement(
        post.improvement,
        yield* venue.displayName(post.improvement.player.discordId),
        post.skin,
      );
    if (post._tag === "Started" || post._tag === "Result") return yield* drawCard(post.card);
    if (post._tag === "Progression")
      return yield* renderer.progression({
        view: post.card,
        history: post.history,
        names: yield* namesOf(post.card),
      });
    return null;
  });

  return {
    post: Effect.fn("Channel.post")(function* (drawing: Drawing) {
      return yield* render(drawing, true).pipe(
        Effect.flatMap((message) => tryDiscord("post", () => channel.send(message))),
        Effect.map((m) => m.id),
      );
    }),
    fingerprint: Effect.fn("Channel.fingerprint")(function* (drawing: Drawing) {
      return yield* render(drawing, false).pipe(
        Effect.flatMap((payload) =>
          Effect.try({
            try: () => fingerprint(payload),
            catch: (cause) => new RenderError({ cause }),
          }),
        ),
      );
    }),
    redraw: Effect.fn("Channel.redraw")(function* (messageId: string, drawing: Drawing) {
      return yield* fetchMessage(messageId).pipe(
        Effect.flatMap((m) =>
          render(drawing, false).pipe(
            Effect.flatMap((message) => tryDiscord("redraw", () => m.edit(message))),
          ),
        ),
        Effect.asVoid,
      );
    }),
    deleteMessage: Effect.fn("Channel.deleteMessage")(function* (messageId: string) {
      return yield* fetchMessage(messageId).pipe(
        Effect.flatMap((m) => tryDiscord("delete message", () => m.delete())),
        Effect.asVoid,
      );
    }),
    startThread: Effect.fn("Channel.startThread")(function* (messageId: string, view: CardView) {
      const message = yield* fetchMessage(messageId);
      const name = threadName(view, yield* venue.displayName(view.creator.discordId));
      const thread = yield* tryDiscord("start thread", () => message.startThread({ name }));
      yield* notices.deleteNoticeOf(thread.id);
      return thread.id;
    }),
    deleteThread: Effect.fn("Channel.deleteThread")(function* (threadId: string) {
      return yield* fetchThread(threadId).pipe(
        Effect.flatMap((t) =>
          tryDiscord("delete thread", async () => {
            await t.delete();
          }),
        ),
      );
    }),
    postClock: Effect.fn("Channel.postClock")(function* (threadId: string, view: CardView) {
      return yield* fetchThread(threadId).pipe(
        Effect.flatMap((thread) => tryDiscord("post clock", () => thread.send(clockMessage(view)))),
        Effect.map((m) => m.id),
      );
    }),
    redrawClock: Effect.fn("Channel.redrawClock")(function* (
      threadId: string,
      messageId: string,
      view: CardView | "cancelled",
    ) {
      return yield* fetchThread(threadId).pipe(
        Effect.flatMap((thread) =>
          tryDiscord("fetch clock", () => thread.messages.fetch(messageId)),
        ),
        Effect.catchTag("DiscordError", (e) => goneIfUnknown(messageId, e)),
        Effect.flatMap((m) => tryDiscord("redraw clock", () => m.edit(clockMessage(view)))),
        Effect.asVoid,
      );
    }),
    postInThread: Effect.fn("Channel.postInThread")(function* (
      threadId: string,
      matchId: string,
      post: ThreadPost,
    ) {
      const thread = yield* fetchThread(threadId);
      const png = yield* threadPng(post);
      const art: ThreadArt = { marbles, png };
      yield* tryDiscord(`post ${post._tag}`, () => thread.send(threadMessage(matchId, post, art)));
    }),
    lastMessageId: tryDiscord("fetch last message", () =>
      channel.messages.fetch({ limit: 1 }),
    ).pipe(Effect.map((ms) => ms.first()?.id ?? null)),
  } satisfies Channel;
});

/** Every running Venue's channel, each made once in a scope of its own (its notices sweep's). */
export const VenueChannelsLive = Layer.scoped(
  VenueChannels,
  Effect.gen(function* () {
    const discord = yield* Discord;
    const needs = yield* Effect.context<Renderer | MapPreviews | Marbles>();
    const layerScope = yield* Effect.scope;
    const all = new Map<VenueName, Channel>();
    for (const venue of discord.running) {
      const scope = yield* Scope.fork(layerScope, ExecutionStrategy.sequential);
      all.set(
        venue.name,
        yield* discordChannel(venue).pipe(Scope.extend(scope), Effect.provide(needs)),
      );
    }
    return VenueChannels.of({ all });
  }),
);

// The Weekly Cup on discord.js (spec #353): switched on per server by WEEKLY_CUP_GUILD_IDS
// (fly.toml: Ballest Racing), a comma-separated list of server ids. For each, at startup and in
// the background, the bot keeps #weekly-cup (channel.ts), stored by id in SQLite, takes the
// presses there as the home Venue's (as #my-stats's, `Discord.answerIn`), and runs that server's
// schedule (schedule.ts) over the channel's messages (slots.ts), the standings drawn by the Renderer
// with each Entrant's name in that server. A server it can't set up is told
// to ops, and the bot runs on without its Cup until the next start. Off in the sandbox, whose
// fresh database each start would run a second Cup beside `pnpm dev`'s, unless it was started
// with `--cup` (SANDBOX_WEEKLY_CUP), which runs it in the sandbox's server.
import { ChannelType, type Client, type TextChannel } from "discord.js";
import { Cause, Config, Effect, Layer, Option, Ref } from "effect";
import { MigratorLive } from "../db.js";
import {
  DiscordError,
  describeDiscordError,
  Discord,
  plainName,
  tryDiscord,
} from "../discord/client.js";
import type { Payload } from "../discord/messages.js";
import { setupGuildOn } from "../discord/setupGuild.js";
import { OpsAlerts } from "../ops.js";
import { Steam, Store } from "../ports.js";
import { MapPreviews } from "../previews.js";
import { Renderer } from "../render/renderer.js";
import { GhostDates, GhostDatesLive } from "../steam/ghosts.js";
import { keepCupChannel } from "./channel.js";
import { CupChannel, CupLinks } from "./model.js";
import type { CupPresses } from "./presses.js";
import { CupLog, CupLogLive } from "./record.js";
import { makeWeeklyCup, WeeklyCups } from "./schedule.js";
import { type CupPictures, cupChannelOver, type MessageSink, type SentPayload } from "./slots.js";

/** One text channel's messages, for the Cup's slots. */
const sinkOn = (client: Client<true>, channelId: string): MessageSink => {
  const channel = tryDiscord("fetch #weekly-cup", () => client.channels.fetch(channelId)).pipe(
    Effect.flatMap((c) =>
      c?.type === ChannelType.GuildText
        ? Effect.succeed<TextChannel>(c)
        : Effect.fail(
            new DiscordError({
              op: "fetch #weekly-cup",
              cause: new Error(`${channelId} is not a text channel`),
            }),
          ),
    ),
  );
  return {
    send: Effect.fn("CupSink.send")(function* (payload: SentPayload) {
      const c = yield* channel;
      return (yield* tryDiscord("post in #weekly-cup", () => c.send(payload))).id;
    }),
    edit: Effect.fn("CupSink.edit")(function* (messageId: string, payload: Payload) {
      const c = yield* channel;
      yield* tryDiscord("update a message in #weekly-cup", async () => {
        const m = await c.messages.fetch(messageId);
        await m.edit(payload);
      });
    }),
    drop: Effect.fn("CupSink.drop")(function* (messageId: string) {
      const c = yield* channel;
      yield* tryDiscord("drop a message in #weekly-cup", async () => {
        const m = await c.messages.fetch(messageId);
        await m.delete();
      });
    }),
  };
};

const make = Effect.gen(function* () {
  const running = yield* Ref.make(new Map<string, CupPresses>());
  const registry = WeeklyCups.of({
    in: Effect.fn("WeeklyCups.in")(function* (guildId) {
      return Option.fromNullable((yield* Ref.get(running)).get(guildId));
    }),
  });
  const sandbox =
    (yield* Config.boolean("MULTIBALLS_SANDBOX").pipe(Config.withDefault(false))) &&
    !(yield* Config.boolean("SANDBOX_WEEKLY_CUP").pipe(Config.withDefault(false)));
  const ids = (yield* Config.array(Config.string(), "WEEKLY_CUP_GUILD_IDS").pipe(
    Config.withDefault([]),
  ))
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (sandbox || ids.length === 0) {
    yield* Effect.logInfo(
      sandbox ? "weekly cup: off in the sandbox" : "weekly cup: off (WEEKLY_CUP_GUILD_IDS not set)",
    );
    return registry;
  }

  const discord = yield* Discord;
  const client = discord.home.channel.client;
  const log = yield* CupLog;
  const alerts = yield* OpsAlerts;
  const steam = yield* Steam;
  const ghosts = yield* GhostDates;
  const previews = yield* MapPreviews;
  const store = yield* Store;
  const renderer = yield* Renderer;
  const links = CupLinks.of({
    steamIdOf: Effect.fn("CupLinks.steamIdOf")(function* (discordId) {
      return Option.map(yield* store.getLink(discordId), (link) => link.steamId);
    }),
  });

  const start = Effect.fn("WeeklyCups.start")(function* (guildId: string) {
    const guild = yield* tryDiscord("fetch the server", () => client.guilds.fetch(guildId));
    const stored = yield* log.channelOf(guildId);
    const channelId = yield* keepCupChannel(setupGuildOn(client, guild), stored);
    if (!Option.contains(stored, channelId)) {
      yield* log.keepChannel(guildId, channelId);
      yield* Effect.logInfo(`weekly cup: #weekly-cup in ${guild.name} is ${channelId}`);
    }
    yield* discord.answerIn(channelId);
    const pictures: CupPictures = {
      // A member who left, or a Discord that doesn't answer, is drawn as "Someone".
      nameOf: Effect.fn("CupPictures.nameOf")(function* (discordId) {
        return yield* tryDiscord("fetch member", () => guild.members.fetch(discordId)).pipe(
          Effect.map((member) => plainName(member.displayName)),
          Effect.orElseSucceed(() => "Someone"),
        );
      }),
      standings: renderer.cupStandings,
    };
    const cup = yield* makeWeeklyCup(guildId).pipe(
      Effect.provideService(
        CupChannel,
        cupChannelOver(sinkOn(client, channelId), guildId, pictures),
      ),
      Effect.provideService(CupLog, log),
      Effect.provideService(OpsAlerts, alerts),
      Effect.provideService(CupLinks, links),
      Effect.provideService(Steam, steam),
      Effect.provideService(GhostDates, ghosts),
      Effect.provideService(MapPreviews, previews),
    );
    yield* Ref.update(running, (m) => new Map(m).set(guildId, cup));
    yield* Effect.logInfo(`weekly cup: running in ${guild.name}`);
    return yield* cup.run;
  });

  for (const guildId of ids)
    yield* start(guildId).pipe(
      Effect.catchTag("DiscordError", "VenueSetupFailed", (e) =>
        alerts.post(
          `Multiballs couldn't set up the Weekly Cup in ${guildId}: ${e._tag === "DiscordError" ? describeDiscordError(e) : e.reason}`,
        ),
      ),
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.void
          : Effect.logError("weekly cup: failed", cause).pipe(
              Effect.zipRight(
                alerts.post(
                  `Multiballs couldn't set up the Weekly Cup in ${guildId}: a bug, see the log`,
                ),
              ),
            ),
      ),
      Effect.forkScoped,
    );
  return registry;
});

/** Every switched-on server's Weekly Cup, set up and run in the background. */
export const WeeklyCupsLive = Layer.scoped(WeeklyCups, make).pipe(
  Layer.provide(CupLogLive),
  Layer.provide(MigratorLive),
  Layer.provide(OpsAlerts.Default),
  Layer.provide(GhostDatesLive),
);

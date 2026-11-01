// The game's sign-in limit (db/game-sign-in.ts, ADR 0016) on a throwaway database: so many an
// hour per address, apart for each address, free again an hour on, and never two at once
// past it.
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  HOURLY_GAME_SIGN_INS,
  HOURLY_GAME_SIGN_INS_ALL,
  addressOf,
  spendGameSignIn,
} from "../db/game-sign-in";
import { hourlySpends } from "../db/schema";
import { freshDb } from "./pg";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const HOUR = 3_600_000;
let t: Awaited<ReturnType<typeof freshDb>>;

beforeAll(async () => {
  t = await freshDb();
});
afterAll(() => t.drop());

test("an address signs in so many times an hour, then not until the oldest is an hour old", async () => {
  for (let i = 0; i < HOURLY_GAME_SIGN_INS; i++)
    expect(await spendGameSignIn(t.db, "203.0.113.1", NOW + i * 1000)).toBe(true);
  expect(await spendGameSignIn(t.db, "203.0.113.1", NOW + HOUR - 1)).toBe(false);
  // another address has its own
  expect(await spendGameSignIn(t.db, "203.0.113.2", NOW)).toBe(true);
  // an hour after the first, one is free again
  expect(await spendGameSignIn(t.db, "203.0.113.1", NOW + HOUR)).toBe(true);
  expect(await spendGameSignIn(t.db, "203.0.113.1", NOW + HOUR)).toBe(false);
});

test("many at once can't take more than the limit", async () => {
  const tries = await Promise.all(
    Array.from({ length: HOURLY_GAME_SIGN_INS + 10 }, () =>
      spendGameSignIn(t.db, "198.51.100.7", NOW),
    ),
  );
  expect(tries.filter(Boolean).length).toBe(HOURLY_GAME_SIGN_INS);
});

test("past the cap on everyone, no address signs in", async () => {
  const later = NOW + 5 * HOUR;
  await t.db.insert(hourlySpends).values(
    Array.from({ length: HOURLY_GAME_SIGN_INS_ALL }, (_, i) => ({
      bucket: "game-sign-in",
      key: `10.0.${String(i)}`,
      spentAt: new Date(later),
    })),
  );
  expect(await spendGameSignIn(t.db, "192.0.2.50", later)).toBe(false);
  expect(await spendGameSignIn(t.db, "192.0.2.50", later + HOUR)).toBe(true);
});

test("an IPv6 address counts by its /64, written out the same however it is written", () => {
  const from = (ip: string) =>
    addressOf(new Request("https://ballestrecords.com/x", { headers: { "x-real-ip": ip } }));
  const block = "2001:db8:0:0::/64";
  for (const ip of [
    "2001:db8::1",
    "2001:db8:0:0:ffff:ffff:ffff:ffff",
    "2001:0db8:0000:0000:1234::",
    "[2001:db8::9]",
    "2001:DB8::abcd%eth0",
  ])
    expect(from(ip), ip).toBe(block);
  expect(from("2001:db8:0:1::1")).toBe("2001:db8:0:1::/64");
  expect(from("::1")).toBe("0:0:0:0::/64");
  expect(from("::ffff:203.0.113.4")).toBe("203.0.113.4");
});

test("the address is Vercel's x-real-ip, else the first x-forwarded-for", () => {
  const from = (headers: Record<string, string>) =>
    addressOf(new Request("https://ballestrecords.com/api/auth/steam/ticket", { headers }));
  expect(from({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "10.0.0.1" })).toBe("203.0.113.9");
  expect(from({ "x-forwarded-for": "203.0.113.8, 10.0.0.1" })).toBe("203.0.113.8");
  expect(from({})).toBe("unknown");
  expect(HOURLY_GAME_SIGN_INS).toBe(30);
});

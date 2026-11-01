// The game's list rules (lib/prefabs.ts listQueryOf, listPageOf; ADR 0016): what a query may
// ask, and which Prefabs a page holds.
import { describe, expect, test } from "vitest";

import { LIST_MOST, LIST_PAGE, listPageOf, listQueryOf, type ListQuery } from "../lib/prefabs";

const ask = (q: string) => listQueryOf(new URLSearchParams(q));

describe("the query", () => {
  test("with nothing asked, it is the first 50 Popular", () => {
    expect(ask("")).toEqual({ sort: "popular", tag: null, q: "", offset: 0, limit: LIST_PAGE });
    expect(LIST_PAGE).toBe(50);
  });

  test("takes a sort, a tag, words, a cursor and a limit", () => {
    expect(ask("sort=newest&tag=Ramp&q=+wrong+way+&cursor=50&limit=20")).toEqual({
      sort: "newest",
      tag: "Ramp",
      q: "wrong way",
      offset: 50,
      limit: 20,
    });
  });

  test("refuses what can't be one", () => {
    for (const bad of [
      "sort=hearts",
      "tag=Spaceship",
      "tag=ramp",
      "cursor=-1",
      "cursor=1.5",
      "cursor=ten",
      "limit=0",
      `limit=${String(LIST_MOST + 1)}`,
      "q=" + "x".repeat(101),
    ])
      expect(ask(bad), bad).toBeNull();
    expect(ask(`limit=${String(LIST_MOST)}`)?.limit).toBe(100);
  });
});

describe("a page", () => {
  /* card n, uploaded on day n, hearted `favorites` times */
  const card = (n: number, over: Partial<Card> = {}): Card => ({
    slug: `p${String(n)}`,
    name: `Prefab ${String(n)}`,
    description: "",
    tags: [],
    favorites: 0,
    createdAt: `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`,
    uploader: { name: "Builder" },
    ...over,
  });
  interface Card {
    slug: string;
    name: string;
    description: string;
    tags: Array<string>;
    favorites: number;
    createdAt: string;
    uploader: { name: string };
  }
  const query = (over: Partial<ListQuery> = {}): ListQuery => ({
    sort: "popular",
    tag: null,
    q: "",
    offset: 0,
    limit: 2,
    ...over,
  });
  const slugs = (r: { page: Array<Card> }) => r.page.map((c) => c.slug);

  const cards = [
    card(1, { favorites: 5, tags: ["Ramp"] }),
    card(2, { name: "Wrongwaysign", description: "wrong way rode sign.", tags: ["Decoration"] }),
    card(3, { favorites: 5, uploader: { name: "habibal" } }),
    card(4, { tags: ["Ramp", "Loop"] }),
    card(5),
  ];

  test("walks the gallery's order a page at a time, with a cursor to the next until the end", () => {
    const first = listPageOf(cards, query());
    expect([first.total, first.next, slugs(first)]).toEqual([5, 2, ["p3", "p1"]]);
    const second = listPageOf(cards, query({ offset: 2 }));
    expect([second.next, slugs(second)]).toEqual([4, ["p5", "p4"]]);
    const last = listPageOf(cards, query({ offset: 4 }));
    expect([last.next, slugs(last)]).toEqual([null, ["p2"]]);
    expect(slugs(listPageOf(cards, query({ offset: 9 })))).toEqual([]);
    expect(slugs(listPageOf(cards, query({ sort: "newest", limit: 3 })))).toEqual([
      "p5",
      "p4",
      "p3",
    ]);
  });

  test("a tag keeps only the Prefabs carrying it", () => {
    const r = listPageOf(cards, query({ tag: "Ramp", limit: 50 }));
    expect([r.total, slugs(r)]).toEqual([2, ["p1", "p4"]]);
  });

  test("words are found in the name, description, a tag or the uploader, any case, all of them", () => {
    const find = (q: string) => slugs(listPageOf(cards, query({ q, limit: 50 })));
    expect(find("WRONGWAY")).toEqual(["p2"]);
    expect(find("rode sign")).toEqual(["p2"]);
    expect(find("loop")).toEqual(["p4"]);
    expect(find("habibal")).toEqual(["p3"]);
    expect(find("ramp prefab 4")).toEqual(["p4"]);
    expect(find("wrong loop")).toEqual([]);
    // the total counts every match, not just the page (the sign isn't named "Prefab")
    expect(listPageOf(cards, query({ q: "prefab", limit: 2 })).total).toBe(4);
  });
});

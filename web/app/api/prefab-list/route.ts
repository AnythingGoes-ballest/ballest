// GET /api/prefab-list?sort=&tag=&q=&cursor=&limit=: the game's Prefabs plugin browsing the
// gallery (ADR 0016), a page at a time. Each entry is what a Prefab's page shows beside its
// viewer (name, uploader, when, pieces, size, file size, hearts), its thumbnail and its file;
// `next` is the cursor of the page after, or null at the end. Anyone may read it, as anyone
// may read the gallery. The cards come from the gallery's cached read and each size from one
// that no write expires (a file never changes), so a page reads a file only for a Prefab
// never listed before. The CDN keeps each query's answer a minute, so a Prefab deleted or
// taken down leaves the list within the minute.
import { getPrefabCards, getPrefabSize } from "../../../db/data";
import { listPageOf, listQueryOf } from "../../../lib/prefabs";
import { prefabFileHref, prefabThumbHref } from "../../../lib/routes";

const LIST_CACHE = "public, max-age=60, s-maxage=60";

export async function GET(request: Request) {
  const query = listQueryOf(new URL(request.url).searchParams);
  if (!query)
    return Response.json(
      { error: "sort is popular or newest, tag one of the tags, cursor and limit whole numbers" },
      { status: 400 },
    );
  const { total, next, page } = listPageOf(await getPrefabCards(), query);
  const prefabs = await Promise.all(
    page.map(async (c) => ({
      slug: c.slug,
      name: c.name,
      description: c.description,
      tags: c.tags,
      uploader: { steamId: c.uploader.steamId, name: c.uploader.name },
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      pieces: c.pieces,
      bytes: c.bytes,
      favorites: c.favorites,
      /* metres across, deep and high, as the Prefab's page shows; null if it can't be read */
      size: await getPrefabSize(c.slug),
      thumb: prefabThumbHref(c.slug, c.updatedAt),
      file: prefabFileHref(c.slug),
    })),
  );
  return Response.json({ total, next, prefabs }, { headers: { "cache-control": LIST_CACHE } });
}

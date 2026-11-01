// GET /api/prefabs/<slug>/thumb?v=<last edit>: a live Prefab drawn small for the game's list
// (ADR 0016), from the angle its uploader picked, clear around it, by the same GPU-free drawing
// as its share image (components/share/prefab.ts). The Prefab is found in the gallery's cached
// cards, so a slug that isn't live costs no read and leaves nothing cached. Only the address
// the list gives is drawn: any other query (an old edit's, or a made-up one) is sent there, so
// a new query string can't make the server draw it again. The picture is cached by slug and
// edit for days, apart from the Prefab reads a write expires, so the CDN keeping it only a
// minute (a Prefab taken down stops showing within the minute) costs no drawing. 404 for a
// Prefab that isn't live or can't be drawn, which the CDN also keeps a minute.
import { getPrefabCards, getPrefabThumb } from "../../../../../db/data";
import { prefabThumbHref } from "../../../../../lib/routes";

const MINUTE = "public, max-age=60, s-maxage=60";

const gone = (error = "no such prefab") =>
  Response.json({ error }, { status: 404, headers: { "cache-control": MINUTE } });

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug;
  const p = (await getPrefabCards()).find((c) => c.slug === slug);
  if (!p) return gone();
  const url = new URL(request.url);
  const here = prefabThumbHref(slug, p.updatedAt);
  if (url.pathname + url.search !== here)
    return new Response(null, {
      status: 307,
      headers: { location: here, "cache-control": "private, no-store" },
    });
  const png = await getPrefabThumb(slug, p.updatedAt, p.angle).catch((e: unknown) => {
    console.warn(`prefab thumbnail: ${slug} not drawn`, e);
    return null;
  });
  if (!png) return gone("this prefab can't be drawn");
  return new Response(new Uint8Array(Buffer.from(png, "base64")), {
    headers: { "content-type": "image/png", "cache-control": MINUTE },
  });
}

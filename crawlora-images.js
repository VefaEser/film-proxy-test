// Crawlora IMDb still-frame adapter. Görseller indirilmez; yalnızca URL ve metadata alınır.
const API_URL = "https://api.crawlora.net/api/v1/imdb/title/images";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const responseCache = new Map();

function normalizeRows(payload) {
  const root = payload?.data ?? payload;
  if (Array.isArray(root)) return root;
  const arrays = [root?.images, root?.items, root?.results, root?.title?.images, payload?.images, payload?.items];
  return arrays.find(Array.isArray) || [];
}

function dimensions(value) {
  if (typeof value === "string") { const m = value.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/i); if (m) return { width:Number(m[1]), height:Number(m[2]) }; }
  return { width:Number(value?.width)||0, height:Number(value?.height)||0 };
}

export async function crawloraStillFrames(env, imdbId, signal, limit = 1000) {
  const key = env.CRAWLORA_API_KEY;
  const id = String(imdbId || "").trim();
  if (!key || !/^tt\d{5,12}$/.test(id)) return [];
  const cached = responseCache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;
  if (cached) responseCache.delete(id);
  const url = new URL(API_URL);
  url.searchParams.set("id", id);
  url.searchParams.set("limit", String(Math.max(1, Math.min(1000, Number(limit)||1000))));
  url.searchParams.set("type", "still_frame");
  const signals = [signal, AbortSignal.timeout(20000)].filter(Boolean);
  const requestSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const res = await fetch(url, { headers: { "x-api-key": key, "Accept":"application/json" }, signal:requestSignal });
  const body = await res.text();
  if (!res.ok) { const e = new Error(`Crawlora HTTP ${res.status}: ${body.slice(0,240)}`); e.status = res.status; throw e; }
  let payload; try { payload = JSON.parse(body); } catch { throw new Error("Crawlora geçerli JSON döndürmedi."); }
  const rows = normalizeRows(payload);
  const seen = new Set();
  const normalized = rows.map((item, index) => {
    const url = String(item.url || item.image_url || item.imageUrl || item.src || "");
    if (!/^https:\/\//i.test(url)) return null;
    const id = String(item.id || item.image_id || item.imageId || url);
    if (seen.has(id)) return null; seen.add(id);
    const size = dimensions(item.size || item.dimensions || item);
    return { source:"crawlora", source_id:id, image_type:"still_frame", title:item.caption || item.alt || "", description:item.caption || item.alt || "", url, pageUrl:item.source_url || `https://www.imdb.com/title/${encodeURIComponent(imdbId)}/mediaindex/`, license:item.copyright || "", width:size.width, height:size.height, position:Number(item.position)||index+1, vote_average:0 };
  }).filter(Boolean);
  responseCache.set(id, { at: Date.now(), rows: normalized });
  return normalized;
}

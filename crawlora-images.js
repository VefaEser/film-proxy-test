// Crawlora IMDb title still-frame adapter.
// Only accept images explicitly linked to the requested IMDb title.
const API_URL = "https://api.crawlora.net/api/v1/imdb/title/images";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const responseCache = new Map();
const diagnostics = new Map();

function normalizeRows(payload) {
  // Crawlora response envelope: { code, msg, data: { id, images: [...] } }.
  // Also tolerate a nested data envelope without treating it as an empty success.
  const root = payload?.data?.data ?? payload?.data ?? payload;
  return { root, rows: Array.isArray(root?.images) ? root.images : Array.isArray(root) ? root : [] };
}
function dimensions(item) {
  return { width: Number(item?.width) || 0, height: Number(item?.height) || 0 };
}
function belongsToTitle(item, imdbId) {
  // /imdb/title/images is already queried with this exact title ID. Crawlora's
  // documented title-image response may omit images[].titles entirely (unlike
  // the name-images endpoint), so absence is NOT a mismatch. If titles are
  // supplied, however, require at least one explicit match.
  if (!Array.isArray(item?.titles) || item.titles.length === 0) return true;
  const wanted = imdbId.toLowerCase();
  return item.titles.some(title => {
    const candidates = [title?.id, title?.imdb_id, title?.imdbId, title?.title_id, title?.url];
    return candidates.some(value => {
      const text = String(value || '').trim().toLowerCase();
      return text === wanted || text.includes(`/title/${wanted}/`) || text.endsWith(`/${wanted}`);
    });
  });
}
function setDiagnostic(id, value) {
  diagnostics.set(id, { ...value, checkedAt: Date.now() });
  if (diagnostics.size > 300) diagnostics.delete(diagnostics.keys().next().value);
}
export function getCrawloraDiagnostics(imdbId) {
  return diagnostics.get(String(imdbId || "").trim()) || null;
}

export async function crawloraStillFrames(env, imdbId, signal, limit = 1000) {
  const key = env.CRAWLORA_API_KEY;
  const id = String(imdbId || "").trim();
  if (!key || !/^tt\d{5,12}$/.test(id)) {
    setDiagnostic(id || "(missing)", { requested: 0, accepted: 0, rejected: 0, reason: !key ? "api_key_missing" : "invalid_imdb_id" });
    return [];
  }
  const cached = responseCache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    setDiagnostic(id, { ...cached.diagnostic, cached: true });
    return cached.rows;
  }
  if (cached) responseCache.delete(id);

  const url = new URL(API_URL);
  url.searchParams.set("id", id);
  url.searchParams.set("limit", String(Math.max(1, Math.min(1000, Number(limit) || 1000))));
  url.searchParams.set("type", "still_frame");
  const signals = [signal, AbortSignal.timeout(20000)].filter(Boolean);
  const requestSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  let res, body, payload;
  try {
    res = await fetch(url, { headers: { "x-api-key": key, "Accept": "application/json" }, signal: requestSignal });
    body = await res.text();
  } catch (error) {
    setDiagnostic(id, { requested: 0, accepted: 0, rejected: 0, reason: "network_error", error: String(error?.message || error).slice(0, 240) });
    throw error;
  }
  if (!res.ok) {
    const message = `Crawlora HTTP ${res.status}: ${body.slice(0, 240)}`;
    setDiagnostic(id, { requested: 0, accepted: 0, rejected: 0, reason: "http_error", status: res.status, error: message });
    const e = new Error(message); e.status = res.status; throw e;
  }
  try { payload = JSON.parse(body); }
  catch {
    setDiagnostic(id, { requested: 0, accepted: 0, rejected: 0, reason: "invalid_json", error: body.slice(0, 240) });
    throw new Error("Crawlora geçerli JSON döndürmedi.");
  }
  if (payload?.code && Number(payload.code) !== 200) {
    const message = String(payload.msg || `Crawlora API code ${payload.code}`);
    setDiagnostic(id, { requested: 0, accepted: 0, rejected: 0, reason: "api_error", status: Number(payload.code), error: message });
    throw new Error(message);
  }

  const { root, rows } = normalizeRows(payload);
  if (root?.id && String(root.id).trim().toLowerCase() !== id.toLowerCase()) {
    setDiagnostic(id, { requested: rows.length, accepted: 0, rejected: rows.length, reason: "response_title_id_mismatch" });
    throw new Error(`Crawlora yanıtındaki IMDb ID eşleşmiyor: ${root.id} (beklenen ${id})`);
  }

  const seen = new Set();
  const normalized = [];
  const rejected = { wrong_type: 0, title_mismatch: 0, bad_url: 0, low_resolution: 0, duplicate: 0 };
  for (const item of rows) {
    // The request already includes type=still_frame. Keep a defensive check
    // when type is returned, but do not reject a row solely because the API
    // omitted this redundant field in its normalized response.
    const imageType = String(item?.type || "").toLowerCase();
    if (imageType && imageType !== "still_frame") { rejected.wrong_type++; continue; }
    if (!belongsToTitle(item, id)) { rejected.title_mismatch++; continue; }
    const imageUrl = String(item.url || "").trim();
    let parsed;
    try { parsed = new URL(imageUrl); } catch { rejected.bad_url++; continue; }
    if (parsed.protocol !== "https:" || !(parsed.hostname === "m.media-amazon.com" || parsed.hostname.endsWith(".media-amazon.com"))) {
      rejected.bad_url++; continue;
    }
    const { width, height } = dimensions(item);
    if (width < 640 || height < 360) { rejected.low_resolution++; continue; }
    const imageId = String(item.id || imageUrl);
    if (seen.has(imageId)) { rejected.duplicate++; continue; }
    seen.add(imageId);
    normalized.push({
      source: "crawlora", source_id: imageId, image_type: "still_frame",
      title: String(item.caption || ""), description: String(item.caption || ""),
      url: imageUrl, pageUrl: `https://www.imdb.com/title/${id}/mediaindex/`,
      license: String(item.copyright || ""), attribution: "IMDb / Crawlora metadata",
      width, height, position: Number(item.position) || normalized.length + 1,
      imdb_id: id, titles: item.titles, credited_names: item.names || []
    });
  }
  const diagnostic = { requested: rows.length, accepted: normalized.length,
    rejected: Object.values(rejected).reduce((a, b) => a + b, 0), rejectedByReason: rejected, cached: false };
  setDiagnostic(id, diagnostic);
  responseCache.set(id, { at: Date.now(), rows: normalized, diagnostic });
  return normalized;
}

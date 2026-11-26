// sources.js — omdbBest: prefixsiz ID'ye sadece "tt" ekle, sıfırları temizleme (Se7en tt0114369 kritik düzeltme)
// Faz 3: omdb() in-memory cache (5dk TTL, max 100 entry) — OMDb kotasını 2x korur
import { safeJSON, movieKey, yearOf, norm, getFilmmapCache, putFilmmapCache, getMetatakeExtendedCache, putMetatakeExtendedCache } from "./db.js";
import { crawloraStillFrames, getCrawloraDiagnostics } from "./crawlora-images.js";

const TMDB_BASE = "https://api.themoviedb.org/3";
const USER_AGENT = "FilmKesifMotoru/1.0 (https://github.com/VefaEser/film-proxy; contact:vefaeser@ornitonerenk.com)";

const keyRot = {
  omdb:   { keys: [], current: 0, deadUntil: {}, dead401: 0 },
  tmdb:   { keys: [], current: 0, deadUntil: {} },
  tavily: { keys: [], current: 0, deadUntil: {} }
};
let keyRotInited = false;
function initKeys(env) {
  if (keyRotInited) return;
  keyRot.omdb.keys = [env.OMDB_API_KEY, env.OMDB_API_KEY_2, env.OMDB_API_KEY_3].filter(Boolean);
  keyRot.tmdb.keys = [env.TMDB_API_KEY, env.TMDB_API_KEY_2, env.TMDB_API_KEY_3].filter(Boolean);
  keyRot.tavily.keys = [env.TAVILY_API_KEY, env.TAVILY_API_KEY_2, env.TAVILY_API_KEY_3].filter(Boolean);
  keyRotInited = true;
}
function pickKey(provider) {
  const rot = keyRot[provider];
  if (!rot.keys.length) return null;
  const now = Date.now();
  for (let i = 0; i < rot.keys.length; i++) {
    const idx = (rot.current + i) % rot.keys.length;
    if (now >= (rot.deadUntil[idx] || 0)) { rot.current = (idx + 1) % rot.keys.length; return { key: rot.keys[idx], index: idx }; }
  }
  return null;
}
function markKeyDead(provider, index, durationMs) { keyRot[provider].deadUntil[index] = Date.now() + durationMs; }
export function getKeyHealth() {
  return {
    omdb:   { total: keyRot.omdb.keys.length, dead: Object.keys(keyRot.omdb.deadUntil).filter(i => keyRot.omdb.deadUntil[i] > Date.now()).length, dead401: keyRot.omdb.dead401 },
    tmdb:   { total: keyRot.tmdb.keys.length, dead: Object.keys(keyRot.tmdb.deadUntil).filter(i => keyRot.tmdb.deadUntil[i] > Date.now()).length },
    tavily: { total: keyRot.tavily.keys.length, dead: Object.keys(keyRot.tavily.deadUntil).filter(i => keyRot.tavily.deadUntil[i] > Date.now()).length }
  };
}

async function fetchJSON(url, options = {}, label = "Uzak servis", timeoutMs = 18000, outerSignal) {
  const signals = [];
  if (outerSignal) signals.push(outerSignal);
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  let signal;
  if (signals.length === 0) signal = undefined;
  else if (signals.length === 1) signal = signals[0];
  else signal = AbortSignal.any ? AbortSignal.any(signals) : (() => { const ac = new AbortController(); for (const s of signals) { if (s.aborted) { ac.abort(); break; } s.addEventListener("abort", () => ac.abort(), { once: true }); } return ac.signal; })();
  const res = await fetch(url, { ...options, signal });
  const body = await res.text();
  const data = safeJSON(body, null);
  if (!res.ok) {
    const err = new Error(`${label}: HTTP ${res.status} ${body.slice(0, 300)}`);
    err.status = res.status;
    if (res.status === 429) { const retryAfter = Number(res.headers.get("retry-after") || 0); err.retryAfterMs = retryAfter > 0 ? retryAfter * 1000 : 60000; }
    throw err;
  }
  if (!data) throw new Error(`${label}: JSON yanıtı alınamadı`);
  return data;
}

export async function tmdb(env, path, params = {}, outerSignal) {
  initKeys(env);
  if (!keyRot.tmdb.keys.length) throw new Error("TMDB_API_KEY tanımlı değil.");
  const tried = new Set(); let lastErr = null;
  for (let attempt = 0; attempt < keyRot.tmdb.keys.length; attempt++) {
    const picked = pickKey("tmdb");
    if (!picked || tried.has(picked.index)) break;
    tried.add(picked.index);
    const url = new URL(TMDB_BASE + path);
    url.searchParams.set("api_key", picked.key);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    try {
      return await fetchJSON(url.toString(), {}, "TMDB", 18000, outerSignal);
    } catch (e) {
      lastErr = e;
      if (e.status === 401) { markKeyDead("tmdb", picked.index, 86400000); console.warn(`[tmdb] key#${picked.index} 401 → 24 saat devre dışı`); continue; }
      if (e.status === 429) { markKeyDead("tmdb", picked.index, e.retryAfterMs || 60000); console.warn(`[tmdb] key#${picked.index} 429 → bekletiliyor`); continue; }
      throw e;
    }
  }
  throw lastErr || new Error("TMDB: tüm anahtarlar tükendi");
}

// === YENİ: OMDb in-memory cache (5dk TTL, max 100 entry) ===
const OMDB_CACHE_TTL_MS = 5 * 60 * 1000;
const OMDB_CACHE_MAX = 100;
const omdbCache = new Map();
function omdbCacheKey(params) {
  // Deterministik key: parametreleri alfabetik sırala, sadece i/t/y/type kullan (apikey hariç)
  const relevant = {};
  for (const k of ["i", "t", "y", "type", "plot", "r"]) if (params[k]) relevant[k] = String(params[k]).trim();
  const sorted = Object.keys(relevant).sort().map(k => `${k}=${relevant[k]}`).join("&");
  return sorted;
}
function omdbCacheGet(key) {
  if (!key) return null;
  const entry = omdbCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > OMDB_CACHE_TTL_MS) { omdbCache.delete(key); return null; }
  return entry.data;
}
function omdbCacheSet(key, data) {
  if (!key || !data) return;
  // LRU benzeri temizlik: max aşılırsa en eski 20 entry'yi sil
  if (omdbCache.size >= OMDB_CACHE_MAX) {
    const toDelete = [];
    let count = 0;
    for (const k of omdbCache.keys()) { if (count >= 20) break; toDelete.push(k); count++; }
    for (const k of toDelete) omdbCache.delete(k);
  }
  omdbCache.set(key, { ts: Date.now(), data });
}

const OMDb_DEAD_MS = 3600 * 1000;
export async function omdb(env, params, outerSignal) {
  initKeys(env);
  if (!keyRot.omdb.keys.length) throw new Error("OMDB_API_KEY tanımlı değil.");
  if (Date.now() < keyRot.omdb.dead401) {
    const remainMin = Math.ceil((keyRot.omdb.dead401 - Date.now()) / 60000);
    throw new Error(`OMDb: tüm anahtarlar devre dışı (401). ${remainMin} dk sonra tekrar dene.`);
  }
  // === YENİ: cache kontrolü ===
  const cacheKey = omdbCacheKey(params);
  const cached = omdbCacheGet(cacheKey);
  if (cached) return cached;

  const tried = new Set(); let lastErr = null; let all401 = true;
  for (let attempt = 0; attempt < keyRot.omdb.keys.length; attempt++) {
    const picked = pickKey("omdb");
    if (!picked || tried.has(picked.index)) break;
    tried.add(picked.index);
    const url = new URL("https://www.omdbapi.com/");
    url.searchParams.set("apikey", picked.key);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    try {
      const data = await fetchJSON(url.toString(), {}, "OMDb", 18000, outerSignal);
      if (data.Response === "False") throw new Error(data.Error || "OMDb sonucu bulunamadı.");
      // === YENİ: başarılı yanıtı cache'e at ===
      omdbCacheSet(cacheKey, data);
      return data;
    } catch (e) {
      lastErr = e;
      if (e.status === 401) { markKeyDead("omdb", picked.index, OMDb_DEAD_MS); console.warn(`[omdb] key#${picked.index} 401 → 1 saat devre dışı`); continue; }
      if (e.status === 429) { markKeyDead("omdb", picked.index, e.retryAfterMs || 60000); console.warn(`[omdb] key#${picked.index} 429 → bekletiliyor`); all401 = false; continue; }
      all401 = false;
    }
  }
  if (all401 && tried.size > 0) { keyRot.omdb.dead401 = Date.now() + OMDb_DEAD_MS; console.error("[omdb] tüm anahtarlar 401 — 1 saat devre dışı"); }
  throw lastErr || new Error("OMDb: tüm anahtarlar tükendi");
}

// === KRİTİK DÜZELTME: prefixsiz ID'ye sıfır temizlemeden sadece "tt" ekle ===
export async function omdbBest(env, movie, outerSignal) {
  const title = movie.original_title || movie.title || "";
  const year = String(yearOf(movie) || "");
  let lastErr = null;
  if (movie.imdb_id) {
    const raw = String(movie.imdb_id).trim();
    const fullId = raw.startsWith("tt") ? raw : `tt${raw}`; // prefixsiz "0114369" → "tt0114369" (sıfırlar korunur)
    try { return await omdb(env, { i: fullId }, outerSignal); }
    catch (e) { lastErr = e; if (e.status === 401) throw e; }
  }
  if (title) {
    try { return await omdb(env, { t: title, y: year }, outerSignal); }
    catch (e) { lastErr = e; if (e.status === 401) throw e; }
  }
  if (title) {
    try { return await omdb(env, { t: title }, outerSignal); }
    catch (e) { lastErr = e; if (e.status === 401) throw e; }
  }
  throw lastErr || new Error("OMDb: arama yapılamadı");
}

export async function tavilySearch(env, query, outerSignal) {
  initKeys(env);
  if (!keyRot.tavily.keys.length) return { results: [] };
  const picked = pickKey("tavily");
  if (!picked) throw new Error("Tavily: tüm anahtarlar tükendi");
  try {
    const data = await fetchJSON("https://api.tavily.com/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: picked.key, query, search_depth: "basic", max_results: 5 })
    }, "Tavily", 20000, outerSignal);
    return data;
  } catch (e) {
    if (e.status === 401 || e.status === 429) markKeyDead("tavily", picked.index, e.status === 401 ? 3600000 : (e.retryAfterMs || 60000));
    throw e;
  }
}

export async function filmmapLocations(env, movie, outerSignal) {
  const movieId = movieKey(movie);
  const cached = await getFilmmapCache(env, movieId);
  if (cached) return { locations: cached, fromCache: true };
  const title = movie.original_title || movie.title || "";
  if (!title) return { locations: [], fromCache: false };
  try {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "where_was_it_filmed", arguments: { title, limit: 100 } } };
    const signal = AbortSignal.any ? AbortSignal.any([outerSignal, AbortSignal.timeout(10000)].filter(Boolean)) : undefined;
    const res = await fetch("https://moviescenemap.com/mcp", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" }, body: JSON.stringify(body), signal });
    if (!res.ok) return { locations: [], fromCache: false, error: `HTTP ${res.status}` };
    const raw = await res.text();
    let data = safeJSON(raw, null);
    if (!data) { for (const l of raw.split(/\r?\n/).filter(l => l.startsWith("data: "))) { const parsed = safeJSON(l.slice(6), null); if (parsed) { data = parsed; break; } } }
    if (!data) return { locations: [], fromCache: false, error: "parse fail" };
    if (data.error) return { locations: [], fromCache: false, error: data.error.message || "rpc error" };
    let payload = null;
    const content = data?.result?.content;
    if (Array.isArray(content)) for (const c of content) if (c?.type === "text" && typeof c.text === "string") { const arr = safeJSON(c.text, null); if (arr) { payload = arr; break; } }
    if (!payload && data?.result) payload = data.result;
    if (!payload) return { locations: [], fromCache: false, error: "no payload" };
    const rawPlaces = payload.places || payload.locations || payload.films || payload.results || payload.data || [];
    const places = Array.isArray(rawPlaces) ? rawPlaces : [];
    const locations = places.map(p => ({ name: String(p.place || p.name || p.location || p.title || "").trim(), country: String(p.country || "").trim(), city: String(p.city || "").trim(), relation: String(p.relation || p.layer || "filmed"), confidence: p.confidence != null ? Number(p.confidence) : null, lat: p.lat != null ? Number(p.lat) : (p.latitude != null ? Number(p.latitude) : null), lng: p.lng != null ? Number(p.lng) : (p.longitude != null ? Number(p.longitude) : null) })).filter(l => l.name);
    const seen = new Set(); const unique = [];
    for (const loc of locations) { const key = `${norm(loc.name)}|${norm(loc.country)}`; if (seen.has(key)) continue; seen.add(key); unique.push(loc); }
    await putFilmmapCache(env, movieId, unique);
    return { locations: unique, fromCache: false, countriesOnly: payload.countries_only || [] };
  } catch (e) { console.warn("filmmap:", e.message); return { locations: [], fromCache: false, error: e.message }; }
}
export async function metatakeExtended(env, movie, outerSignal) {
  const movieId = movieKey(movie);
  const cached = await getMetatakeExtendedCache(env, movieId);
  if (cached) return cached;
  const title = movie.original_title || movie.title || "";
  if (!title) return null;
  const headers = { "Accept": "application/json", "User-Agent": USER_AGENT };
  try {
    const searchData = await fetchJSON(`https://metatake.net/api/v1/films?q=${encodeURIComponent(title)}&limit=5`, { headers }, "Metatake search", 10000, outerSignal);
    const films = Array.isArray(searchData?.films) ? searchData.films : [];
    if (!films.length) return null;
    const year = yearOf(movie);
    const match = (year && films.find(f => Number(f.year) === Number(year))) || films[0];
    const slug = match.slug;
    if (!slug) return null;
    let film = null;
    try { film = await fetchJSON(`https://metatake.net/api/v1/films/${encodeURIComponent(slug)}`, { headers }, "Metatake film", 10000, outerSignal); } catch (e) { console.warn("metatake film:", e.message); }
    let locations = [];
    try {
      const locData = await fetchJSON(`https://metatake.net/api/v1/locations?film=${encodeURIComponent(slug)}&limit=100`, { headers }, "Metatake locations", 10000, outerSignal);
      const locList = Array.isArray(locData?.locations) ? locData.locations : [];
      locations = locList.map(loc => ({ name: String(loc.name || "").trim(), country: String(loc.country || "").trim(), city: "", layer: String(loc.layer || "filmed"), kind: String(loc.role || ""), lat: loc.lat != null ? Number(loc.lat) : null, lng: loc.lng != null ? Number(loc.lng) : null, precision: loc.precision || null })).filter(l => l.name);
    } catch (e) { console.warn("metatake locations:", e.message); }
    const settings = locations.filter(l => String(l.layer).toLowerCase() === "setting").map(l => l.name);
    const filmingPlaces = locations.filter(l => String(l.layer).toLowerCase() !== "setting").map(l => l.name);
    const kindred = Array.isArray(film?.kindred) ? film.kindred.map(k => ({ title: String(k.title || "").trim(), year: k.year != null ? Number(k.year) : null, slug: k.slug || null })).filter(k => k.title) : [];
    const takescore = film?.takescore || null;
    const lowConfidence = takescore?.low_confidence === true;
    const confidence = takescore ? (lowConfidence ? 0.4 : 0.85) : (match.analyzed ? 0.6 : null);
    const result = { narrative_setting: settings, filming_places: filmingPlaces, kindred_films: kindred.map(k => k.title), kindred_full: kindred, awards: [], confidence, low_confidence: lowConfidence, locations, takescore: takescore ? { score: takescore.score ?? null, value: takescore.value ?? null, cost: takescore.cost ?? null, risk: takescore.risk ?? null } : null, url: film?.url || match.url || null, cite_as: film?.cite_as || null };
    await putMetatakeExtendedCache(env, movieId, result);
    return result;
  } catch (e) { console.warn("metatake extended:", e.message); return null; }
}

async function opensubtitlesDensity(env, movie, outerSignal) { if (!env.OPENSUBTITLES_API_KEY) return null; const imdbId = String(movie.imdbID || movie.imdb_id || "").replace(/^tt/, ""); const runtime = Number(movie.runtime) || 0; if (!imdbId || !runtime) return null; try { const base = "https://api.opensubtitles.com/api/v1"; const headers = { "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": USER_AGENT, "Accept": "application/json" }; const search = await fetchJSON(`${base}/subtitles?imdb_id=${encodeURIComponent(imdbId)}&languages=en`, { headers }, "OpenSubtitles search", 15000, outerSignal); const items = Array.isArray(search?.data) ? search.data : []; if (!items.length) return null; items.sort((a, b) => Number((b.attributes?.download_count) || 0) - Number((a.attributes?.download_count) || 0)); const fileId = items[0]?.attributes?.files?.[0]?.file_id; if (!fileId) return null; if (!env.OPENSUBTITLES_USERNAME || !env.OPENSUBTITLES_PASSWORD) return null; const login = await fetchJSON(`${base}/login`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ username: env.OPENSUBTITLES_USERNAME, password: env.OPENSUBTITLES_PASSWORD }) }, "OpenSubtitles login", 10000, outerSignal); const token = login?.token; if (!token) return null; const dl = await fetchJSON(`${base}/download`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ file_id: fileId }) }, "OpenSubtitles download", 15000, outerSignal); const link = dl?.link; if (!link) return null; const subRes = await fetch(link, { signal: AbortSignal.any ? AbortSignal.any([outerSignal, AbortSignal.timeout(15000)].filter(Boolean)) : undefined }); if (!subRes.ok) return null; const text = await subRes.text(); const plain = text.replace(/<[^>]+>/g, "").replace(/\\N/g, " ").replace(/[{][^}]*[}]/g, "").trim(); const chars = plain.length; if (chars < 100) return null; const density = Math.max(0, Math.min(100, Math.round((chars / runtime) / 10))); return { density, chars, runtime, source: "opensubtitles" }; } catch (e) { console.warn("opensubtitles:", e.message); return null; } }
async function subsourceDensity(env, movie, outerSignal) { if (!env.SUBSOURCE_API_KEY) return null; const imdbId = String(movie.imdbID || movie.imdb_id || "").replace(/^tt/, ""); const runtime = Number(movie.runtime) || 0; if (!imdbId || !runtime) return null; try { const headers = { "X-API-Key": env.SUBSOURCE_API_KEY, "User-Agent": USER_AGENT, "Accept": "application/json" }; const search = await fetchJSON(`https://api.subsource.net/api/v1/search?imdb=${encodeURIComponent(imdbId)}&language=en`, { headers }, "SubSource search", 15000, outerSignal); const items = Array.isArray(search?.subtitles) ? search.subtitles : (Array.isArray(search?.data) ? search.data : []); if (!items.length) return null; const best = items[0]; const downloadUrl = best?.download_url || best?.url; if (!downloadUrl) return null; const subRes = await fetch(downloadUrl, { headers, signal: AbortSignal.any ? AbortSignal.any([outerSignal, AbortSignal.timeout(15000)].filter(Boolean)) : undefined }); if (!subRes.ok) return null; const text = await subRes.text(); const plain = text.replace(/<[^>]+>/g, "").replace(/\\N/g, " ").replace(/[{][^}]*[}]/g, "").trim(); const chars = plain.length; if (chars < 100) return null; const density = Math.max(0, Math.min(100, Math.round((chars / runtime) / 10))); return { density, chars, runtime, source: "subsource" }; } catch (e) { console.warn("subsource:", e.message); return null; } }
async function subdlDensity(env, movie, outerSignal) { if (!env.SUBDL_API_KEY) return null; const imdbId = String(movie.imdbID || movie.imdb_id || "").replace(/^tt/, ""); const runtime = Number(movie.runtime) || 0; if (!imdbId || !runtime) return null; try { const headers = { "api_key": env.SUBDL_API_KEY, "User-Agent": USER_AGENT, "Accept": "application/json" }; const search = await fetchJSON(`https://api.subdl.com/api/v1/subtitles?api_key=${encodeURIComponent(env.SUBDL_API_KEY)}&imdb_id=${encodeURIComponent(imdbId)}&languages=EN`, { headers }, "SubDL search", 15000, outerSignal); const items = Array.isArray(search?.subtitles) ? search.subtitles : (Array.isArray(search?.data) ? search.data : []); if (!items.length) return null; const best = items[0]; const link = best?.url || best?.download_url; if (!link) return null; const fullUrl = link.startsWith("http") ? link : `https://dl.subdl.com${link}`; const subRes = await fetch(fullUrl, { signal: AbortSignal.any ? AbortSignal.any([outerSignal, AbortSignal.timeout(15000)].filter(Boolean)) : undefined }); if (!subRes.ok) return null; const text = await subRes.text(); const plain = text.replace(/<[^>]+>/g, "").replace(/\\N/g, " ").replace(/[{][^}]*[}]/g, "").trim(); const chars = plain.length; if (chars < 100) return null; const density = Math.max(0, Math.min(100, Math.round((chars / runtime) / 10))); return { density, chars, runtime, source: "subdl" }; } catch (e) { console.warn("subdl:", e.message); return null; } }
export async function fetchSubtitleDensity(env, movie, outerSignal) { const chain = [subsourceDensity, subdlDensity, opensubtitlesDensity]; for (const fn of chain) { try { const r = await fn(env, movie, outerSignal); if (r && r.density != null) return r; } catch (e) { /* devam */ } } return null; }

async function commonsScenes(env, movie, outerSignal) {
  const title = movie.original_title || movie.title || "";
  if (!title) return [];
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query"); url.searchParams.set("format", "json");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `filetype:bitmap "${title}" (film still OR movie scene OR screenshot)`);
  url.searchParams.set("gsrnamespace", "6"); url.searchParams.set("gsrlimit", "50");
  url.searchParams.set("prop", "imageinfo"); url.searchParams.set("iiprop", "url|extmetadata|size");
  url.searchParams.set("iiurlwidth", "640");
  const data = await fetchJSON(url.toString(), { headers: { "User-Agent": USER_AGENT } }, "Wikimedia Commons", 18000, outerSignal);
  const pages = Object.values(data.query?.pages || {});
  return pages.map(p => {
    const i = p.imageinfo?.[0] || {}, meta = i.extmetadata || {};
    return { source: "commons", source_id: p.pageid ? `commons:${p.pageid}` : p.title, image_type: "still_frame", title: p.title || "", description: meta.ImageDescription?.value || "", categories: meta.Categories?.value || "", url: i.thumburl || i.url || "", pageUrl: i.descriptionurl || "", license: meta.LicenseShortName?.value || "", attribution: meta.Artist?.value || "", width: Number(i.thumbwidth || i.width) || 0, height: Number(i.thumbheight || i.height) || 0, vote_average: 0 };
  }).filter(x => x.url && isLikelySceneImage(x, title));
}
function isLikelySceneImage(img, movieTitle = "") {
  const text = `${img.title || ""} ${img.description || ""} ${img.categories || ""}`
    .toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  if (/(poster|portrait|headshot|actor|actress|cast|logo|cover|selfie|signature|autograph|award|festival|premiere)/.test(text)) return false;
  // Commons search is broad and frequently returns files that merely mention
  // cinema. Require both a scene/still indicator and a meaningful title match.
  if (!/(still|scene|screenshot|frame|film still|movie still)/.test(text)) return false;
  const title = String(movieTitle || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const tokens = title.split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3);
  if (!tokens.length) return false;
  const matched = tokens.filter(token => text.includes(token)).length;
  return text.includes(title) || matched / tokens.length >= 0.75;
}
async function tmdbBackdrops(env, movie, outerSignal) {
  if (!movie.id) return [];
  const data = await tmdb(env, `/movie/${movie.id}/images`, { include_image_language: "en,tr,null" }, outerSignal);
  return (Array.isArray(data.backdrops) ? data.backdrops : []).map((b, index) => ({
    source: "tmdb", source_id: `tmdb:${b.file_path}`, image_type: "still_frame", title: movie.original_title || movie.title || "",
    url: `https://image.tmdb.org/t/p/w780${b.file_path}`, pageUrl: `https://www.themoviedb.org/movie/${movie.id}`,
    license: "TMDB terms apply", attribution: "TMDB", width: Number(b.width)||0, height: Number(b.height)||0,
    vote_average: Number(b.vote_average)||0, position: index + 1
  })).filter(x => x.url);
}
async function wikidataImages(env, imdbId, outerSignal) {
  if (!/^tt\d{5,12}$/.test(String(imdbId || ""))) return [];
  const query = `SELECT ?item ?itemLabel ?image WHERE { ?item wdt:P345 "${imdbId}"; wdt:P18 ?image. SERVICE wikibase:label { bd:serviceParam wikibase:language "en,tr". } } LIMIT 12`;
  const url = "https://query.wikidata.org/sparql?query=" + encodeURIComponent(query);
  const data = await fetchJSON(url, { headers: { "Accept": "application/sparql-results+json", "User-Agent": USER_AGENT } }, "Wikidata images", 18000, outerSignal);
  return (data.results?.bindings || []).map((b, i) => {
    const rawImageUrl = b.image?.value || "";
    const imageUrl = rawImageUrl.replace(/^http:\/\//i, "https://");
    const fileName = decodeURIComponent(imageUrl.split("/").pop() || "").toLowerCase();
    return { source: "wikidata", source_id: `wikidata:${imageUrl || i}`, image_type: "still_frame",
      title: b.itemLabel?.value || fileName, description: "Wikidata P18; sahne karesi olduğu dosya adıyla doğrulanmalı",
      url: imageUrl, pageUrl: b.item?.value || "", license: "Commons dosya sayfasında doğrulanmalı",
      attribution: "Wikidata / bağlı medya", width: 0, height: 0, position: i + 1, vote_average: 0,
      sceneNameMatch: /(still|scene|frame|screenshot|film.?still)/i.test(fileName) };
  }).filter(x => /^https:\/\//i.test(x.url) && x.sceneNameMatch);
}
function imageDedupeKey(img) {
  try { const u = new URL(img.url); return `${u.hostname.toLowerCase()}${u.pathname.toLowerCase()}`; }
  catch { return String(img.source_id || img.url || "").toLowerCase(); }
}
// Aynı film karesinin açıklamaları çoğu zaman film/oyuncu adlarını tekrar eder.
// Açıklama benzerliği kare benzerliği değildir; bu nedenle yalnızca gerçek URL
// tekrarlarını ayıklıyoruz. Aksi halde TMDB ve Crawlora'daki farklı kareler
// aynı başlığı taşıdığı için yanlışlıkla eleniyordu.
function selectRepresentativeImages(groups, limit = 20) {
  // Kaynakların tamamı sorgulanır. Öncelik korunurken tek bir kaynağın
  // galeriyi tamamen doldurmasını önlemek için başlangıç dağılımı ağırlıklıdır.
  const sourceOrder = ["crawlora", "tmdb", "commons", "wikidata"];
  const sourceCaps = { crawlora: 10, tmdb: 6, commons: 3, wikidata: 1 };
  const seen = new Set();
  const uniqueBySource = Object.fromEntries(sourceOrder.map(source => [source, []]));

  for (const source of sourceOrder) {
    for (const image of groups[source] || []) {
      const key = imageDedupeKey(image);
      if (!key || seen.has(key)) continue;
      const w = Number(image.width) || 0, h = Number(image.height) || 0;
      if (w && h && (w < 640 || h < 360)) continue;
      seen.add(key);
      uniqueBySource[source].push(image);
    }
  }

  const pickSpaced = (items, count) => {
    if (items.length <= count) return items.slice();
    if (count <= 1) return [items[0]];
    return Array.from({ length: count }, (_, i) => items[Math.round(i * (items.length - 1) / (count - 1))]);
  };

  const ordered = [];
  const chosen = new Set();
  // Ensimmäinen vaihe: Crawlora öncelikli, ancak diğer kaynaklara da yer ayır.
  for (const source of sourceOrder) {
    const candidates = pickSpaced(uniqueBySource[source], Math.min(sourceCaps[source], limit));
    for (const image of candidates) {
      if (ordered.length >= limit) break;
      ordered.push(image);
      chosen.add(image);
    }
  }
  // İkinci aşama: kaynaklar kota dolduramadıysa kalan görselleri öncelik sırasıyla ekle.
  for (const source of sourceOrder) {
    for (const image of uniqueBySource[source]) {
      if (ordered.length >= limit) break;
      if (chosen.has(image)) continue;
      ordered.push(image);
      chosen.add(image);
    }
  }
  return ordered.slice(0, limit).map((x, i) => ({ ...x, sample_order: i + 1, source_type: "still_frame" }));
}
const VISUAL_SAMPLE_POLICY_VERSION = 5;
const VISUAL_SAMPLE_CACHE_TTL_SECONDS = 6 * 60 * 60;

async function loadVisualSampleSetMeta(env, movieId) {
  if (!env.DB || !movieId) return null;
  try {
    const row = await env.DB.prepare(`SELECT policy_version, checked_at, counts_json
      FROM visual_sample_sets WHERE movie_id = ?`).bind(String(movieId)).first();
    return row || null;
  } catch (e) {
    // Kod, migration tamamlanmadan dağıtılırsa galeri çalışmaya devam etsin.
    console.warn("visual sample policy metadata henüz hazır değil:", e.message);
    return null;
  }
}
async function saveVisualSampleSetMeta(env, movieId, counts) {
  if (!env.DB || !movieId) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`INSERT INTO visual_sample_sets (movie_id, policy_version, checked_at, counts_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(movie_id) DO UPDATE SET policy_version = excluded.policy_version,
        checked_at = excluded.checked_at, counts_json = excluded.counts_json`)
      .bind(String(movieId), VISUAL_SAMPLE_POLICY_VERSION, now, JSON.stringify(counts || {})).run();
  } catch (e) {
    console.warn("visual sample policy metadata kaydedilemedi:", e.message);
  }
}
async function loadStoredVisualSamples(env, movieId) {
  if (!env.DB || !movieId) return [];
  try {
    const { results } = await env.DB.prepare(`SELECT vs.id, vs.source_url AS url, vs.source_id, vs.source_name AS source, vs.license, vs.attribution, vs.sample_timestamp, vs.source_type, vp.analysis_status
      FROM visual_samples vs LEFT JOIN visual_profiles vp ON vp.movie_id = vs.movie_id WHERE vs.movie_id = ? AND vs.source_type = 'still_frame' ORDER BY vs.id ASC LIMIT 20`).bind(String(movieId)).all();
    const rows = results || [];
    if (!rows.length) return [];

    // source_id kimlik bilgisidir; thumbnail servisine yalnızca gerçek HTTPS URL'si gönderilir.
    const validRows = rows.filter((row) => {
      try { const parsed = new URL(String(row.url || "")); return parsed.protocol === "https:" && Boolean(parsed.hostname); }
      catch { return false; }
    });
    if (validRows.length !== rows.length) {
      console.warn(`[visual-samples] geçersiz source_url bulundu; yeniden toplanacak: ${movieId}`, { total: rows.length, valid: validRows.length });
      await env.DB.prepare("DELETE FROM visual_samples WHERE movie_id = ? AND source_type = 'still_frame'").bind(String(movieId)).run();
      return [];
    }
    return validRows.map((r, i) => ({ ...r, title: r.source_id || `Sahne ${i + 1}`,
      thumbnailPath: `/image/thumbnail?src=${encodeURIComponent(r.url)}`, sample_order: i + 1 }));
  } catch (e) {
    console.error("visual samples read failed:", e.message);
    throw new Error(`Seçilmiş görsel listesi Turso'dan okunamadı: ${e.message}`);
  }
}

async function saveVisualSamples(env, movieId, images) {
  if (!env.DB) throw new Error("Test Turso bağlantısı yok; görsel örnekleri kaydedilmedi.");
  if (!movieId || !images.length) return;
  const now = Math.floor(Date.now() / 1000);
  const statements = [env.DB.prepare("DELETE FROM visual_samples WHERE movie_id = ? AND source_type = 'still_frame'").bind(String(movieId))];
  for (const img of images) {
    statements.push(env.DB.prepare(`INSERT INTO visual_samples
      (movie_id, source_type, source_url, source_id, source_name, license, attribution, match_confidence, image_hash, sample_timestamp, created_at)
      VALUES (?, 'still_frame', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(String(movieId), img.url, String(img.source_id || ""), String(img.source || ""), String(img.license || ""), String(img.attribution || ""), img.source === "crawlora" ? 0.95 : 0.8, null, Number(img.position || img.sample_order || 0), now));
  }
  await env.DB.batch(statements);
}
async function wikidataBatchOnce(env, movies, timeoutMs, outerSignal) { const results = new Map(); if (!movies.length) return results; const rows = movies.map(m => { const title = (m.original_title || m.title || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"'); return `("${title}"@en ${m.id})`; }).join(" "); const query = `SELECT ?movieId ?item ?originalWorkLabel ?filmingLocationLabel ?filmingCountryLabel ?award ?awardLabel ?nominatedLabel WHERE { VALUES (?title ?movieId) { ${rows} } ?item rdfs:label ?title . ?item wdt:P31 wd:Q11424 . OPTIONAL { ?item wdt:P144 ?originalWork. } OPTIONAL { ?item wdt:P915 ?filmingLocation. } OPTIONAL { ?filmingLocation wdt:P17 ?filmingCountry. } OPTIONAL { ?item wdt:P166 ?award. } OPTIONAL { ?item wdt:P1411 ?nominated. } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,tr". } } LIMIT 300`; const url = "https://query.wikidata.org/sparql?query=" + encodeURIComponent(query); const data = await fetchJSON(url, { headers: { "Accept": "application/sparql-results+json", "User-Agent": USER_AGENT } }, "Wikidata", timeoutMs, outerSignal); const bindings = data.results?.bindings || []; const byId = new Map(); for (const b of bindings) { const id = b.movieId?.value || ""; if (!byId.has(id)) byId.set(id, { originalWork: null, locations: new Set(), countries: new Set(), awards: new Set(), nominations: new Set() }); const rec = byId.get(id); if (b.originalWorkLabel?.value) rec.originalWork = b.originalWorkLabel.value; if (b.filmingLocationLabel?.value) rec.locations.add(b.filmingLocationLabel.value); if (b.filmingCountryLabel?.value) rec.countries.add(b.filmingCountryLabel.value); const aq = b.award?.value || ""; if (aq) { const q = aq.split("/").pop(); if (/^Q\d+$/.test(q)) rec.awards.add(q); } const nq = b.nominated?.value || ""; if (nq) { const q = nq.split("/").pop(); if (/^Q\d+$/.test(q)) rec.nominations.add(q); } } for (const [id, rec] of byId) results.set(id, { originalWork: rec.originalWork, filmingLocations: [...rec.locations], filmingCountries: [...rec.countries], awards: [...rec.awards], nominations: [...rec.nominations] }); return results; }
export async function wikidataBatch(env, movies, outerSignal) { try { return await wikidataBatchOnce(env, movies, 25000, outerSignal); } catch (e) { console.warn("wikidata batch:", e.message); return new Map(); } }

export async function handleImages(env, url, signal) {
  const id = url.searchParams.get("id");
  const title = url.searchParams.get("title") || "";
  const originalTitle = url.searchParams.get("original_title") || title;
  const imdbId = url.searchParams.get("imdb_id") || url.searchParams.get("imdbId") || "";
  const movie = { id, title, original_title: originalTitle };

  // Aynı politika sürümüyle son 6 saatte toplanmış set varsa tekrar harici kaynak çağırma.
  const meta = await loadVisualSampleSetMeta(env, id);
  const now = Math.floor(Date.now() / 1000);
  const forceRefresh = ["1", "true", "yes"].includes(String(url.searchParams.get("refresh") || "").toLowerCase());
  const cacheIdentity = {
    imdbId: String(imdbId || "").trim().toLowerCase(),
    title: String(originalTitle || title || "").trim().toLowerCase(),
  };
  let cachedCounts = {};
  try { cachedCounts = JSON.parse(meta?.counts_json || "{}"); } catch {}
  const previousIdentity = cachedCounts.cacheIdentity || null;
  const identityMatches = previousIdentity
    && String(previousIdentity.imdbId || "") === cacheIdentity.imdbId
    && String(previousIdentity.title || "") === cacheIdentity.title;
  const previousHadErrors = Object.keys(cachedCounts.sourceErrors || {}).length > 0;
  const cacheValid = !forceRefresh && meta
    && Number(meta.policy_version) === VISUAL_SAMPLE_POLICY_VERSION
    && identityMatches && !previousHadErrors
    && now - Number(meta.checked_at || 0) < VISUAL_SAMPLE_CACHE_TTL_SECONDS;
  if (cacheValid) {
    const stored = await loadStoredVisualSamples(env, id);
    return { images: stored, counts: { ...cachedCounts, stored: stored.length }, imdbId: imdbId || null,
      analysisStatus: stored[0]?.analysis_status || "pending", sourcePolicyVersion: VISUAL_SAMPLE_POLICY_VERSION, cached: true };
  }

  // Dört kaynak da her yenilemede sorgulanır. Böylece bir kaynağın tek başına
  // 20 görsel sağlaması diğer kaynakların katkısını engellemez.
  const groups = { crawlora: [], tmdb: [], commons: [], wikidata: [] };
  const counts = { crawlora: 0, tmdb: 0, commons: 0, wikidata: 0, sourceErrors: {} };
  try { groups.crawlora = await crawloraStillFrames(env, imdbId, signal, 1000, { forceRefresh }); }
  catch (e) { console.warn("crawlora still frames:", e.message); counts.sourceErrors.crawlora = String(e?.message || e).slice(0, 240); }
  counts.crawlora = groups.crawlora.length;
  counts.crawloraDiagnostics = getCrawloraDiagnostics(imdbId) || {
    requested: 0, accepted: 0, rejected: 0,
    reason: !imdbId ? "movie_has_no_imdb_id" : (!env.CRAWLORA_API_KEY ? "api_key_missing" : "no_diagnostic"),
  };

  try { groups.tmdb = await tmdbBackdrops(env, movie, signal); }
  catch (e) { console.warn("tmdb backdrops:", e.message); counts.sourceErrors.tmdb = String(e?.message || e).slice(0, 240); }
  counts.tmdb = groups.tmdb.length;

  try { groups.commons = await commonsScenes(env, movie, signal); }
  catch (e) { console.warn("commons scenes:", e.message); counts.sourceErrors.commons = String(e?.message || e).slice(0, 240); }
  counts.commons = groups.commons.length;

  try { groups.wikidata = await wikidataImages(env, imdbId, signal); }
  catch (e) { console.warn("wikidata images:", e.message); counts.sourceErrors.wikidata = String(e?.message || e).slice(0, 240); }
  counts.wikidata = groups.wikidata.length;

  const selected = selectRepresentativeImages(groups, 20);
  counts.fetchedBySource = {
    crawlora: groups.crawlora.length,
    tmdb: groups.tmdb.length,
    commons: groups.commons.length,
    wikidata: groups.wikidata.length,
  };
  // Kaynak bazında gerçek seçimi raporla; 20 hedefi tamamlanamadıysa eksik
  // kalan miktar da teşhiste açıkça görülsün.
  counts.selected = selected.length;
  counts.selectedBySource = {
    crawlora: selected.filter(x => x.source === "crawlora").length,
    tmdb: selected.filter(x => x.source === "tmdb").length,
    commons: selected.filter(x => x.source === "commons").length,
    wikidata: selected.filter(x => x.source === "wikidata").length,
  };
  counts.remainingTo20 = Math.max(0, 20 - selected.length);
  counts.cacheIdentity = cacheIdentity;
  counts.refreshRequested = forceRefresh;

  // Yeni kaynaklar hiç sonuç vermediyse önceki geçerli galeri setini silme.
  if (selected.length) await saveVisualSamples(env, id, selected);
  // Hatalı/eksik taramayı da kaydet; cache kontrolü sourceErrors varsa yeniden dener.
  // Böylece önceki başarılı metadata, başarısız yenilemeden sonra eski sonucu gizleyemez.
  await saveVisualSampleSetMeta(env, id, counts);
  let images = selected.map(img => ({ ...img, thumbnailPath: `/image/thumbnail?src=${encodeURIComponent(img.url)}` }));
  if (!images.length) images = await loadStoredVisualSamples(env, id);
  return { images, counts, imdbId: imdbId || null,
    analysisStatus: images[0]?.analysis_status || "pending", sourcePolicyVersion: VISUAL_SAMPLE_POLICY_VERSION, cached: false };
}

export async function tmdbRoute(env, url, signal) {
  initKeys(env);
  const path = url.pathname.replace(/^\/tmdb/, "");
  if (path === "/genre/movie/list") return tmdb(env, path, { language: url.searchParams.get("language") || "tr-TR" }, signal);
  if (path === "/configuration/languages") return tmdb(env, path, {}, signal);
  if (path === "/configuration/countries") return tmdb(env, path, { language: url.searchParams.get("language") || "tr-TR" }, signal);
  if (path === "/search/movie") return tmdb(env, path, { query: url.searchParams.get("query") || "", language: url.searchParams.get("language") || "tr-TR", page: url.searchParams.get("page") || 1, include_adult: "false" }, signal);
  if (path === "/search/person") return tmdb(env, path, { query: url.searchParams.get("query") || "", language: url.searchParams.get("language") || "tr-TR", page: url.searchParams.get("page") || 1, include_adult: "false" }, signal);
  if (path === "/search/company") return tmdb(env, path, { query: url.searchParams.get("query") || "", page: url.searchParams.get("page") || 1 }, signal);
  if (path === "/search/keyword") return tmdb(env, path, { query: url.searchParams.get("query") || "", page: url.searchParams.get("page") || 1 }, signal);
  if (path === "/person/popular") return tmdb(env, path, { language: url.searchParams.get("language") || "tr-TR", page: url.searchParams.get("page") || 1 }, signal);
  if (path === "/discover/movie") {
    const allowed = ["language","sort_by","vote_average.gte","vote_average.lte","vote_count.gte","page","primary_release_date.gte","primary_release_date.lte","with_genres","without_genres","with_original_language","with_origin_country","with_runtime.gte","with_runtime.lte","with_text_query","with_companies","with_keywords","without_companies","without_keywords","with_cast","with_crew","with_people","with_release_type","release_date.gte","release_date.lte","with_watch_providers","with_status"];
    const params = {}; for (const k of allowed) if (url.searchParams.has(k)) params[k] = url.searchParams.get(k);
    return tmdb(env, path, params, signal);
  }
  throw Object.assign(new Error("Bilinmeyen TMDB uç noktası."), { status: 404 });
    } 

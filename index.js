// index.js — Faz G: /admin/d1-diag anlık teşhis endpoint'i eklendi
// Yeni /movie/rating-* ve /admin/user-* route'ları handleUser'a yönlendirildi
// Faz 6: /admin/config GET → auth varsa tüm config, yoksa sadece filter_info.*
import { corsHeaders } from "./cors.js";
import { createTursoAdapter } from "./turso-adapter.js";
import { handleAuth, getCurrentUserWithAdminBridge } from "./auth.js";
import { handleUser } from "./users.js";
import { handleSocial } from "./social.js";
import { handleAdmin } from "./admin.js";
import { processAdminTaskQueue } from "./admin-task-queue.js";
import {
  GEMINI_MODEL_DEFAULT, GROQ_MODEL_DEFAULT, buildGeminiChain, buildGroqChain,
  isAdmin, response, jsonError, omdb, tmdbRoute, handleImages, handleMovieDetails, handleResearchStream,
  getAllConfig, getLlmStats, getActiveDeadKeys, getFilterInfoAll, getAllStaticOptions,
  getMovieLists, metatakeExtended, filmmapLocations, deadKeysCache, safeJSON, getKeyHealth,
  tmdb, getSiteRatingForMovie, analyzeVisualMovie
} from "./worker-core.js";

const CORS = {
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

// Cloudflare Worker üzerinde galeri küçük resmi üretimi.
// Cloud Run server.js / Sharp kullanılmaz; dönüşüm cf.image üzerinden yapılır.
const THUMB_MAX_BYTES = 20 * 1024;
const THUMB_ALLOWED_HOSTS = new Set([
  "image.tmdb.org",
  "upload.wikimedia.org",
  "crawlora.net",
  "m.media-amazon.com",
  "images-na.ssl-images-amazon.com"
]);
function isAllowedThumbnailHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return THUMB_ALLOWED_HOSTS.has(host) || host.endsWith(".wikimedia.org") ||
    host.endsWith(".crawlora.net") || host.endsWith(".imdb.com") ||
    host.endsWith(".media-amazon.com");
}
function thumbnailError(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
async function handleThumbnailRequest(request) {
  if (request.method !== "GET") return thumbnailError("GET gerekli.", 405);
  const requestUrl = new URL(request.url);
  const source = requestUrl.searchParams.get("src") || "";
  let sourceUrl;
  try { sourceUrl = new URL(source); } catch { return thumbnailError("Geçersiz görsel adresi.", 400); }
  if (sourceUrl.protocol !== "https:" || !isAllowedThumbnailHost(sourceUrl.hostname)) {
    return thumbnailError("Görsel kaynağı izinli değil.", 403);
  }

  // Her denemede gerçek dönüştürülmüş gövde ölçülür. Sınır aşılırsa
  // daha küçük/düşük kaliteli varyant denenir; orijinal asla sunulmaz.
  const variants = [
    { width: 480, quality: 42 },
    { width: 360, quality: 36 },
    { width: 280, quality: 30 },
    { width: 220, quality: 25 },
    { width: 170, quality: 21 },
    { width: 128, quality: 18 },
    { width: 96, quality: 15 }
  ];

  for (const variant of variants) {
    let currentUrl = new URL(sourceUrl.href);
    let transformed = null;
    try {
      // Yönlendirmeler manuel izlenir; her hedef yeniden host allowlist
      // kontrolünden geçer. Böylece izinli kaynak üzerinden başka hosta kaçış olmaz.
      for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
        const upstream = await fetch(currentUrl.href, {
          method: "GET",
          redirect: "manual",
          signal: request.signal,
          headers: { "Accept": "image/webp,image/*;q=0.8", "User-Agent": "FilmKesifMotoru/1.0" },
          cf: { image: { width: variant.width, fit: "scale-down", quality: variant.quality, format: "webp" } }
        });
        if (upstream.status >= 300 && upstream.status < 400) {
          const location = upstream.headers.get("location");
          try { await upstream.body?.cancel(); } catch {}
          if (!location || redirectCount === 3) throw new Error("Görsel kaynağı çok fazla yönlendirme yaptı.");
          const nextUrl = new URL(location, currentUrl);
          if (nextUrl.protocol !== "https:" || !isAllowedThumbnailHost(nextUrl.hostname)) {
            throw new Error("Görsel kaynağı güvenli olmayan bir adrese yönlendirdi.");
          }
          currentUrl = nextUrl;
          continue;
        }
        transformed = upstream;
        break;
      }
      if (!transformed || !transformed.ok) continue;
      const contentType = (transformed.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (contentType !== "image/webp") { try { await transformed.body?.cancel(); } catch {} continue; }
      const bytes = await transformed.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > THUMB_MAX_BYTES) continue;
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "public, max-age=86400",
          "X-Image-Bytes": String(bytes.byteLength),
          "X-Image-Max-Bytes": String(THUMB_MAX_BYTES),
          "X-Image-Verified": "1"
        }
      });
    } catch (error) {
      console.warn("[image-thumbnail] variant failed", variant.width, variant.quality, error?.message || error);
    }
  }
  return thumbnailError("Görsel 20 KB sınırına indirilemedi; orijinal görsel gösterilmedi.", 422);
}

async function requireAdminEither(env, request) {
  if (isAdmin(request, env)) return { via: "bearer" };
  const user = await getCurrentUserWithAdminBridge(env, request);
  if (user && user.is_admin) return { via: "cookie", user };
  return null;
}

async function requireCardPermission(env, request, requiredPermission) {
  const viaBearer = isAdmin(request, env);
  if (viaBearer) return { via: "bearer" };
  const user = await getCurrentUserWithAdminBridge(env, request);
  if (!user) return null;
  if (user.is_admin) return { via: "cookie", user };
  if (!requiredPermission) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS ok FROM user_permissions WHERE user_id = ? AND permission = ? LIMIT 1"
    ).bind(user.user_id, requiredPermission).first();
    if (row?.ok === 1) return { via: "permission", user };
  } catch {}
  return null;
}

async function handleRequest(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const _u = new URL(request.url);
  const path = _u.pathname;

  // Vercel/Cloudflare ortak, gizli görev kuyruğu tetikleyicisi.
  // Yalnızca TASK_RUNNER_SECRET bilen sunucu çağrıları kullanabilir.
  if (path === "/internal/run-admin-tasks") {
    if (request.method !== "POST") return jsonError("POST gerekli.", 405);
    const secret = String(env.TASK_RUNNER_SECRET || "");
    const supplied = String(request.headers.get("authorization") || "");
    if (!secret || supplied !== `Bearer ${secret}`) return jsonError("Yetkisiz.", 401);
    if (!env.DB) return jsonError("Test veritabanına bağlanılamadı.", 503);
    try {
      const result = await processAdminTaskQueue(env, 1);
      // Bir öğe işlendi ise yeni bir Vercel Function çağrısı başlat.
      // Her çağrı kendi 300 saniyelik süresini kullanır; öğeler Turso'da kalıcıdır.
      if (result.processed >= 1 && typeof ctx?.waitUntil === "function") {
        const nextUrl = new URL("/internal/run-admin-tasks", request.url);
        const continuation = fetch(nextUrl, {
          method: "POST",
          headers: { "Authorization": `Bearer ${secret}` }
        }).then(response => {
          if (!response.ok) throw new Error(`Görev devam çağrısı HTTP ${response.status}`);
        }).catch(error => console.error("[admin-task-continuation]", error?.stack || error));
        ctx.waitUntil(continuation);
      }
      return response({ ok: true, ...result, environment: "test" });
    } catch (error) {
      console.error("[admin-task-runner]", error?.stack || error);
      return jsonError("Görev kuyruğu çalıştırılamadı.", 500);
    }
  }
  const dbRequired =
    path.startsWith("/auth/") ||
    path.startsWith("/user/") ||
    path.startsWith("/social/") ||
    (path.startsWith("/admin/") &&
      path !== "/admin/taxonomy/validate") ||
    path.startsWith("/movie/rating-stats/") ||
    path.startsWith("/movie/rating-users/") ||
    path === "/static/options" ||
    path === "/metatake/locations" ||
    path === "/filmmap/locations" ||
    path === "/movie/lists" ||
    path === "/movie/details" ||
    path === "/research" ||
    path === "/llm-interactions";
  if (dbRequired && !env.DB) {
    return jsonError("Seçilen ortamın Turso veritabanına bağlanılamadı.", 503);
  }
  if (_u.pathname.startsWith("/auth/")) return await handleAuth(request, env, ctx);
  if (_u.pathname.startsWith("/user/") ||
      _u.pathname.startsWith("/movie/rating-stats/") ||
      _u.pathname.startsWith("/movie/rating-users/") ||
      _u.pathname.startsWith("/admin/user-lists/") ||
      _u.pathname.startsWith("/admin/user-ratings/")) {
    return await handleUser(request, env, ctx);
  }
  if (_u.pathname.startsWith("/social/")) return await handleSocial(request, env, ctx);
  if (_u.pathname.startsWith("/admin/bulk/") ||
      _u.pathname.startsWith("/admin/users") || _u.pathname.startsWith("/admin/comments") ||
      _u.pathname.startsWith("/admin/locks") || _u.pathname.startsWith("/admin/suggestions") ||
      _u.pathname.startsWith("/admin/unlock") || _u.pathname.startsWith("/admin/messages") ||
      _u.pathname.startsWith("/admin/hf-import/")) {
    return await handleAdmin(request, env, ctx);
  }
  const url = _u;
  try {
    if (url.pathname === "/health") {
      const keyHealth = (() => { try { return getKeyHealth(); } catch { return {}; } })();
      return response({
        ok: true,
        geminiModel: env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT, geminiModels: buildGeminiChain(env),
        groqModel: env.GROQ_MODEL || GROQ_MODEL_DEFAULT, groqModels: buildGroqChain(env),
        tmdb: !!env.TMDB_API_KEY, tmdbKeys: [!!env.TMDB_API_KEY, !!env.TMDB_API_KEY_2, !!env.TMDB_API_KEY_3],
        omdb: !!env.OMDB_API_KEY, omdbKeys: [!!env.OMDB_API_KEY, !!env.OMDB_API_KEY_2, !!env.OMDB_API_KEY_3],
        tavily: !!env.TAVILY_API_KEY, tavilyKeys: [!!env.TAVILY_API_KEY, !!env.TAVILY_API_KEY_2, !!env.TAVILY_API_KEY_3],
        opensubtitles: !!env.OPENSUBTITLES_API_KEY, subsource: !!env.SUBSOURCE_API_KEY, subdl: !!env.SUBDL_API_KEY,
        turnstile: !!env.TURNSTILE_SECRET_KEY,
        groqKeys: [!!env.GROQ_API_KEY_1, !!env.GROQ_API_KEY_2, !!env.GROQ_API_KEY_3],
        geminiKeys: [!!env.GEMINI_API_KEY_1, !!env.GEMINI_API_KEY_2, !!env.GEMINI_API_KEY_3],
        adminToken: !!env.ADMIN_TOKEN, metatake: true, filmmap: true, staticOptions: true,
        d1: false,
        d1Disabled: true,
        turso: !!((env.IS_TEST_ENV ? env.TEST_TURSO_DATABASE_URL : env.TURSO_DATABASE_URL) &&
          (env.IS_TEST_ENV ? env.TEST_TURSO_AUTH_TOKEN : env.TURSO_AUTH_TOKEN)),
        tursoConfigured: !!((env.IS_TEST_ENV ? env.TEST_TURSO_DATABASE_URL : env.TURSO_DATABASE_URL) &&
          (env.IS_TEST_ENV ? env.TEST_TURSO_AUTH_TOKEN : env.TURSO_AUTH_TOKEN)),
        tursoConnected: await (async () => { try { return Number((await env.DB.prepare("SELECT 1 AS ok").first())?.ok) === 1; } catch { return false; } })(),
        dbType: "turso", defaultMinImdbVotes: 100, keyHealth
      });
    }
    if (url.pathname === "/static/options" && request.method === "GET") return response({ options: await getAllStaticOptions(env) });
    if (url.pathname === "/metatake/locations" && request.method === "GET") { const movieId = url.searchParams.get("movie_id") || ""; const title = url.searchParams.get("title") || ""; if (!movieId && !title) return jsonError("movie_id veya title gerekli.", 400); const mt = await metatakeExtended(env, { id: movieId, title, original_title: title }, request.signal); return response({ locations: mt?.locations || [], confidence: mt?.confidence ?? null }); }
    if (url.pathname === "/filmmap/locations" && request.method === "GET") { const movieId = url.searchParams.get("movie_id") || ""; const title = url.searchParams.get("title") || ""; if (!movieId && !title) return jsonError("movie_id veya title gerekli.", 400); const fm = await filmmapLocations(env, { id: movieId, title, original_title: title }, request.signal); return response({ locations: fm.locations || [], fromCache: fm.fromCache }); }
    if (url.pathname === "/movie/lists" && request.method === "POST") { let body; try { body = await request.json(); } catch { return jsonError("Geçersiz JSON.", 400); } const ids = Array.isArray(body.movie_ids) ? body.movie_ids.map(String) : []; const lists = await getMovieLists(env, ids); const obj = {}; for (const [k, v] of lists) obj[k] = v; return response({ lists: obj }); }

    if (url.pathname === "/admin/ping" && request.method === "GET") { const auth = await requireAdminEither(env, request); if (!auth) return jsonError("Yetkisiz.", 401); return response({ ok: true, via: auth.via }); }
    if (url.pathname === "/admin/taxonomy/validate" && request.method === "GET") {
      const auth = await requireAdminEither(env, request);
      if (!auth) return jsonError("Yetkisiz.", 401);
      const { validateTaxonomy } = await import("./taxonomy.config.js");
      return response(validateTaxonomy());
    }
    // === FAZ 6: /admin/config GET → auth varsa tüm config, yoksa sadece filter_info.* ===
    if (url.pathname === "/admin/config" && request.method === "GET") {
      const auth = await requireAdminEither(env, request);
      const allConfig = await getAllConfig(env);
      if (auth) return response({ config: allConfig });
      // Auth yoksa sadece filter_info.* (kullanıcı tooltip'leri için gerekli) döndür
      const filtered = {};
      for (const [k, v] of Object.entries(allConfig)) {
        if (k.startsWith("filter_info.")) filtered[k] = v;
      }
      return response({ config: filtered });
    }
    if (url.pathname === "/admin/config" && request.method === "PUT") { const auth = await requireAdminEither(env, request); if (!auth) return jsonError("Yetkisiz.", 401); let body; try { body = await request.json(); } catch { return jsonError("Geçersiz JSON.", 400); } if (!body.key || typeof body.value !== "string") return jsonError("key ve value gerekli.", 400); const { setConfig } = await import("./config.js"); await setConfig(env, body.key, body.value); return response({ ok: true, key: body.key }); }
    if (url.pathname === "/admin/filter_info" && request.method === "GET") return response({ config: await getFilterInfoAll(env) });
    if (url.pathname === "/admin/stats" && request.method === "GET") { const auth = await requireAdminEither(env, request); if (!auth) return jsonError("Yetkisiz.", 401); return response({ stats: await getLlmStats(env), deadKeys: await getActiveDeadKeys(env), keyHealth: (() => { try { return getKeyHealth(); } catch { return {}; } })() }); }

    // Turso teşhisi (geriye uyumluluk için eski /admin/d1-diag yolu da kabul edilir).
    if (["/admin/turso-diag", "/admin/d1-diag"].includes(url.pathname) && request.method === "GET") {
      const auth = await requireAdminEither(env, request);
      if (!auth) return jsonError("Yetkisiz.", 401);
      if (!env.DB) return jsonError("Turso bağlantısı yok", 503);
      const nowSec = Math.floor(Date.now() / 1000);
      const windowSec = 24 * 3600;
      const since = nowSec - windowSec;
      const sqlWrites = {
        llm_calls: "SELECT COUNT(*) AS c FROM llm_calls WHERE ts > ?",
        llm_rpm_tracker: "SELECT COUNT(*) AS c FROM llm_rpm_tracker WHERE window_start > ?",
        filter_verdicts: "SELECT COUNT(*) AS c FROM filter_verdicts WHERE created_at > ?",
        movie_profiles: "SELECT COUNT(*) AS c FROM movie_profiles WHERE updated_at > ?",
        movie_profile_fields: "SELECT COUNT(*) AS c FROM movie_profile_fields WHERE fetched_at > ?",
        user_sessions: "SELECT COUNT(*) AS c FROM user_sessions WHERE created_at > ?",
        users: "SELECT COUNT(*) AS c FROM users WHERE created_at > ?",
        comments: "SELECT COUNT(*) AS c FROM comments WHERE created_at > ?",
        edit_suggestions: "SELECT COUNT(*) AS c FROM edit_suggestions WHERE created_at > ?",
        login_attempts: "SELECT COUNT(*) AS c FROM login_attempts WHERE last_attempt_ts > ?",
        messages: "SELECT COUNT(*) AS c FROM messages WHERE created_at > ?",
        csv_imports: "SELECT COUNT(*) AS c FROM csv_imports WHERE imported_at > ?"
      };
      const writes24h = {};
      let total = 0;
      const errors = {};
      for (const [tbl, sql] of Object.entries(sqlWrites)) {
        try {
          const row = await env.DB.prepare(sql).bind(since).first();
          const c = Number(row?.c || 0);
          writes24h[tbl] = c;
          total += c;
        } catch (e) {
          writes24h[tbl] = null;
          errors[tbl] = String(e.message || e).slice(0, 120);
        }
      }
      let taxonomyFilterRows = null;
      try {
        const row = await env.DB.prepare(
          `SELECT COUNT(*) AS c FROM filter_verdicts WHERE (filter_signature LIKE '%"subgenres"%' OR filter_signature LIKE '%"tropes"%' OR filter_signature LIKE '%"themes"%')`
        ).first();
        taxonomyFilterRows = Number(row?.c || 0);
      } catch (e) { errors.taxonomy_filter_rows = String(e.message || e).slice(0, 120); }
      const latest = {};
      try { latest.llm_calls = (await env.DB.prepare("SELECT MAX(ts) AS m FROM llm_calls").first())?.m || null; } catch {}
      try { latest.llm_rpm_tracker = (await env.DB.prepare("SELECT MAX(window_start) AS m FROM llm_rpm_tracker").first())?.m || null; } catch {}
      try { latest.filter_verdicts = (await env.DB.prepare("SELECT MAX(created_at) AS m FROM filter_verdicts").first())?.m || null; } catch {}
      try { latest.movie_profiles = (await env.DB.prepare("SELECT MAX(updated_at) AS m FROM movie_profiles").first())?.m || null; } catch {}
      try { latest.movie_profile_fields = (await env.DB.prepare("SELECT MAX(fetched_at) AS m FROM movie_profile_fields").first())?.m || null; } catch {}
      const warnings = []; // Turso: günlük yazma limiti yok
      return response({
        ok: true,
        via: auth.via,
        window_hours: 24,
        since_ts: since,
        now_ts: nowSec,
        writes_24h: writes24h,
        total_writes_24h: total,
        taxonomy_filter_rows: taxonomyFilterRows,
        latest_timestamps: latest,
        hf_token_configured: !!env.HF_TOKEN,
        warnings,
        errors: Object.keys(errors).length ? errors : undefined
      });
    }

    if (url.pathname === "/admin/dead_keys" && request.method === "DELETE") { const auth = await requireAdminEither(env, request); if (!auth) return jsonError("Yetkisiz.", 401); if (env.DB) await env.DB.prepare("DELETE FROM dead_keys").run(); deadKeysCache.ts = 0; return response({ ok: true }); }

    if (url.pathname === "/admin/movie-profiles" && request.method === "GET") {
      const auth = await requireCardPermission(env, request, "db_cards_view");
      if (!auth) return jsonError("Bu kart listesini görüntüleme yetkiniz yok.", 403);
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
      const requestedPageSize = parseInt(url.searchParams.get("pageSize") || "10", 10);
      const pageSize = Number.isFinite(requestedPageSize)
        ? Math.min(100, Math.max(10, Math.floor(requestedPageSize / 10) * 10))
        : 10;
      const offset = (page - 1) * pageSize;
      const { results } = await env.DB.prepare(`
        SELECT movie_id,
               COALESCE(NULLIF(title,''), json_extract(data_json, '$.title'), json_extract(data_json, '$.original_title'), movie_id) AS title,
               COALESCE(year, CAST(json_extract(data_json, '$.year') AS INTEGER)) AS year,
               updated_at
        FROM movie_profiles ORDER BY updated_at DESC LIMIT ? OFFSET ?
      `).bind(pageSize, offset).all();
      const { results: countRows } = await env.DB.prepare("SELECT COUNT(*) AS c FROM movie_profiles").all();
      return response({ movies: results || [], total: countRows[0]?.c || 0, page, pageSize });
    }
    if (url.pathname === "/admin/movie-profiles" && request.method === "POST") {
      const auth = await requireCardPermission(env, request, "db_cards_bulk_open");
      if (!auth) return jsonError("Yetkisiz.", 401);
      let body; try { body = await request.json(); } catch { return jsonError("Geçersiz JSON.", 400); }
      const imdbId = String(body.imdbId || "").replace(/^tt/, "").trim();
      let tmdbId = body.tmdbId != null && !isNaN(parseInt(body.tmdbId)) ? parseInt(body.tmdbId) : null;
      if (!imdbId && !tmdbId) return jsonError("imdbId veya tmdbId gerekli.", 400);
      if (!tmdbId && imdbId) {
        try {
          const findData = await tmdb(env, `/find/tt${imdbId}`, { external_source: "imdb_id", language: "tr-TR" }, request.signal);
          const m = (findData.movie_results || [])[0];
          if (!m) return jsonError("Film TMDB'de bulunamadı", 404);
          tmdbId = m.id;
        } catch (e) { return jsonError(`TMDB find hatası: ${e.message}`, 500); }
      }
      try {
        const result = await handleMovieDetails(env, { movie: { id: tmdbId, imdb_id: imdbId ? `tt${imdbId}` : undefined }, forceAll: true }, request.signal);
        if (imdbId) {
          await env.DB.prepare("UPDATE user_movies SET tmdb_id = ?, updated_at = ? WHERE imdb_id = ?").bind(tmdbId, Math.floor(Date.now() / 1000), imdbId).run();
        }
        return response({ ok: true, tmdbId, movie: result.movie });
      } catch (e) { return jsonError("Kart oluşturulamadı: " + (e.message || e), 500); }
    }
    if (url.pathname.match(/^\/admin\/movie-profiles\/\d+$/) && request.method === "PUT") {
      const auth = await requireCardPermission(env, request, "field_unlock");
      if (!auth) return jsonError("Yetkisiz.", 401);
      const movieId = url.pathname.split("/").pop();
      let body; try { body = await request.json(); } catch { return jsonError("Geçersiz JSON.", 400); }
      const existing = await env.DB.prepare("SELECT data_json FROM movie_profiles WHERE movie_id = ?").bind(movieId).first();
      if (!existing) return jsonError("Kart bulunamadı.", 404);
      const profile = safeJSON(existing.data_json, {}) || {};
      const allowed = ["title", "original_title", "release_date", "runtime", "imdbRating", "imdbVotes", "imdbID", "imdb_id", "rated", "awards", "metascore", "boxOffice", "overview"];
      for (const f of allowed) if (f in body) profile[f] = body[f];
      const newTitle = profile.title || profile.original_title || null;
      const newYear = profile.year || (profile.release_date ? parseInt(String(profile.release_date).slice(0, 4)) : null);
      await env.DB.prepare("UPDATE movie_profiles SET title = COALESCE(?, title), year = COALESCE(?, year), data_json = ?, updated_at = ? WHERE movie_id = ?").bind(newTitle, newYear, JSON.stringify(profile), Math.floor(Date.now() / 1000), movieId).run();
      return response({ ok: true, movie: profile });
    }
    if (url.pathname.match(/^\/admin\/movie-profiles\/\d+$/) && request.method === "GET") {
      const auth = await requireAdminEither(env, request);
      if (!auth) return jsonError("Yetkisiz.", 401);
      const movieId = url.pathname.split("/").pop();
      const row = await env.DB.prepare("SELECT data_json FROM movie_profiles WHERE movie_id = ?").bind(movieId).first();
      if (!row) return jsonError("Bulunamadı.", 404);
      return response({ movie: safeJSON(row.data_json, {}) || {} });
    }
    if (url.pathname.match(/^\/admin\/movie-profiles\/\d+$/) && request.method === "DELETE") {
      const auth = await requireCardPermission(env, request, "db_cards_bulk_delete");
      if (!auth) return jsonError("Yetkisiz.", 401);
      const movieId = url.pathname.split("/").pop();
      await env.DB.prepare("DELETE FROM movie_profiles WHERE movie_id = ?").bind(movieId).run();
      await env.DB.prepare("DELETE FROM movie_profile_fields WHERE movie_id = ?").bind(movieId).run();
      await env.DB.prepare("UPDATE user_movies SET tmdb_id = NULL WHERE tmdb_id = ?").bind(parseInt(movieId)).run();
      return response({ ok: true });
    }

    if (url.pathname === "/admin/csv-cards" && request.method === "GET") {
      const auth = await requireCardPermission(env, request, "csv_cards_view");
      if (!auth) return jsonError("CSV kart listesini görüntüleme yetkiniz yok.", 403);
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
      const requestedPageSize = parseInt(url.searchParams.get("pageSize") || "10", 10);
      const pageSize = Number.isFinite(requestedPageSize)
        ? Math.min(100, Math.max(10, Math.floor(requestedPageSize / 10) * 10))
        : 10;
      const offset = (page - 1) * pageSize;
      const { results } = await env.DB.prepare(`SELECT um.user_id, um.movie_id, um.imdb_id, um.tmdb_id, um.title_original, um.title_tr, um.year, um.imdb_rating, um.user_rating, um.list_type, um.source, um.updated_at, u.username FROM user_movies um JOIN users u ON u.id = um.user_id WHERE um.source = 'csv' ORDER BY um.updated_at DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all();
      const { results: countRows } = await env.DB.prepare("SELECT COUNT(*) AS c FROM user_movies WHERE source = 'csv'").all();
      return response({ cards: results || [], total: countRows[0]?.c || 0, page, pageSize });
    }

    if (url.pathname.startsWith("/tmdb/")) return response(await tmdbRoute(env, url, request.signal));
    if (url.pathname === "/omdb") { const params = {}; for (const k of ["i","t","y","type"]) if (url.searchParams.has(k)) params[k] = url.searchParams.get(k); return response(await omdb(env, params, request.signal)); }
    if (url.pathname === "/image/thumbnail") return await handleThumbnailRequest(request);
    if (url.pathname === "/images") return response(await handleImages(env, url, request.signal));
    if (url.pathname === "/visual/analyze" && request.method === "POST") {
      const user = await getCurrentUserWithAdminBridge(env, request);
      if (!user) return jsonError("Görsel analizi için giriş yapmalısınız.", 401);
      let body; try { body = await request.json(); } catch { return jsonError("Geçersiz JSON.", 400); }
      if (!body?.movieId) return jsonError("movieId gerekli.", 400);
      try { return response(await analyzeVisualMovie(env, body.movieId, request.signal)); }
      catch (error) { console.error("[visual-analysis]", error?.message || error); return jsonError(error.message || "Görsel analiz başarısız.", error.status || 502); }
    }
    if (url.pathname === "/movie/details" && request.method === "POST") { let body; try { body = await request.json(); } catch { return jsonError("Geçersiz JSON.", 400); } return response(await handleMovieDetails(env, body, request.signal)); }
    if (url.pathname === "/research" || url.pathname === "/llm-interactions") {
      if (request.method !== "POST") return jsonError("Bu uç nokta POST bekliyor.", 405);
      const user = await getCurrentUserWithAdminBridge(env, request);
      if (!user) return jsonError("Arama yapmak için giriş yapmalısınız.", 401);
      let body; try { body = await request.json(); } catch { return jsonError("Geçersiz JSON gövdesi.", 400); }
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const controller = { enqueue: (chunk) => writer.write(chunk), close: () => writer.close() };
      const enc = new TextEncoder();
      const heartbeatTimer = setInterval(() => { try { writer.write(enc.encode(": ping\n\n")); } catch { clearInterval(heartbeatTimer); } }, 15000);
      const task = handleResearchStream(env, body, controller, request.signal)
        .catch(err => { console.error("[research-stream]", err.stack || err); try { controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "error", message: String(err.message || err) })}\n\n`)); } catch {} try { controller.close(); } catch {} })
        .finally(() => clearInterval(heartbeatTimer));
      if (ctx?.waitUntil) ctx.waitUntil(task);
      return new Response(readable, { headers: { ...CORS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
    }
    return jsonError("Uç nokta bulunamadı.", 404);
  } catch (e) { console.error(e.stack || e); const message = String(e.message || e); const status = e.status || (/API_KEY|Secret .*tanımlı değil|gerekli/.test(message) ? 503 : 500); return jsonError(message, status); }
}

export default {
  async fetch(request, env, ctx) {
    let response;
// Bu Worker yalnızca test ortamında çalışır.
// Origin başlığından bağımsız olarak daima test veritabanını kullanır.
const appEnv = Object.assign({}, env, { IS_TEST_ENV: true });

try {
  // Yalnızca TEST_TURSO_DATABASE_URL ve TEST_TURSO_AUTH_TOKEN kullanılır.
  // Test bilgileri eksikse canlı veritabanına geçiş yapılmaz.
  appEnv.DB = createTursoAdapter(env, true);
} catch (e) {
  appEnv.DB = null;
  console.error("[turso-adapter-init] TEST DB", e?.stack || e);
}

    try {
      response = await handleRequest(request, appEnv, ctx);
    } catch (e) {
      console.error("[fetch-fatal]", e?.stack || e);
      response = jsonError("Sunucu isteği işlerken beklenmeyen bir hata oluştu.", 500);
    }

    const newHeaders = new Headers(response.headers);
    newHeaders.delete("Access-Control-Allow-Origin");
    newHeaders.delete("Access-Control-Allow-Credentials");
    for (const [k, v] of Object.entries(corsHeaders(request))) newHeaders.set(k, v);
    newHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Type, X-Image-Bytes, X-Image-Max-Bytes, X-Image-Verified");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  },

  async scheduled(controller, env, ctx) {
    // Bu Worker yalnızca TEST Turso dalını kullanır.
    const appEnv = Object.assign({}, env, { IS_TEST_ENV: true });
    try {
      appEnv.DB = createTursoAdapter(env, true);
      const result = await processAdminTaskQueue(appEnv, 1);
      console.log("[admin-task-queue]", JSON.stringify(result));
      return result;
    } catch (error) {
      console.error("[admin-task-queue-scheduled]", error?.stack || error);
      throw error;
    }
  }
}; 

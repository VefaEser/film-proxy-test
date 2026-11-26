// db.js — Faz B: taxonomy alanları arrayFields'a eklendi
// SCHEMA_VERSION 12 → DEĞİŞMEDİ (ek rapor kararı).
import { FIELD_DEFS } from "./fields.config.js";

export const VERDICT_TTL = 86400;
export const deadKeysCache = { ts: 0, gemini: new Map(), groq: new Set() };

export const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
export function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } }); }
export function jsonError(message, status = 500, extra = {}) { return response({ error: String(message), ...extra }, status); }
export function timingSafeEqualStr(a, b) { if (typeof a !== "string" || typeof b !== "string") return false; const len = Math.max(a.length, b.length); let diff = a.length ^ b.length; for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }
export function isAdmin(request, env) { if (!env.ADMIN_TOKEN) return false; return timingSafeEqualStr(request.headers.get("Authorization") || "", `Bearer ${env.ADMIN_TOKEN}`); }

export function safeJSON(text, fallback = null) { try { return JSON.parse(text); } catch { return fallback; } }
export function norm(s) { return String(s || "").trim().toLowerCase().replace(/İ/g, "i").replace(/I/g, "ı").replace(/Ş/g, "ş").replace(/Ğ/g, "ğ").replace(/Ü/g, "ü").replace(/Ö/g, "ö").replace(/Ç/g, "ç").replace(/Â/g, "a").replace(/Î/g, "i").replace(/Û/g, "u").replace(/\s+/g, " "); }
export function yearOf(m) { return Number(String(m.release_date || "").slice(0, 4)) || Number(m.year) || 0; }
export function movieKey(m) { return String(m.id || m.tmdb_id || ""); }
export function simpleHash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

function requireDB(env, operation) {
  if (!env?.DB) {
    throw new Error(`Database binding is unavailable during ${operation}.`);
  }
  return env.DB;
}

function serializeJSON(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} could not be serialized: ${error.message}`);
  }
  if (serialized === undefined) {
    throw new TypeError(`${label} must be JSON-serializable.`);
  }
  return serialized;
}

function warnBestEffort(operation, error) {
  console.warn(`[db:${operation}] Best-effort write failed:`, error?.message || error);
}

const _inFlightLocks = new Map();

export function acquireInFlightLock(key, factory) {
  if (!key) return Promise.resolve().then(factory);
  if (_inFlightLocks.has(key)) return _inFlightLocks.get(key);

  const p = Promise.resolve().then(factory).finally(() => {
    if (_inFlightLocks.get(key) === p) _inFlightLocks.delete(key);
  });

  _inFlightLocks.set(key, p);
  return p;
}

export function recordLlmRpm(env, provider, model, keyIndex) {
  if (!env.DB) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - (nowSec % 60);

  env.DB.prepare(
    `INSERT INTO llm_rpm_tracker
      (provider, model, key_index, window_start, call_count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(provider, model, key_index, window_start)
     DO UPDATE SET call_count = llm_rpm_tracker.call_count + 1`
  )
    .bind(provider, model, keyIndex, windowStart)
    .run()
    .catch(e => warnBestEffort("RPM track", e));
}

export async function checkLlmRpm(env, provider, model, keyIndex, limit) {
  if (!env.DB || !limit) return { ok: true, count: 0 };

  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - (nowSec % 60);

  try {
    const row = await env.DB.prepare(
      "SELECT call_count FROM llm_rpm_tracker WHERE provider = ? AND model = ? AND key_index = ? AND window_start = ?"
    )
      .bind(provider, model, keyIndex, windowStart)
      .first();

    const count = Number(row?.call_count || 0);
    return { ok: count < limit, count };
  } catch (error) {
    warnBestEffort("RPM check", error);
    return { ok: true, count: 0 };
  }
}

export async function getProfileRow(env, movieId) {
  if (!env.DB) return null;

  try {
    const row = await env.DB.prepare(
      "SELECT data_json, updated_at, last_refreshed_at FROM movie_profiles WHERE movie_id = ?"
    )
      .bind(movieId)
      .first();

    if (!row) return null;

    return {
      data: safeJSON(row.data_json, {}) || {},
      updatedAt: row.updated_at,
      lastRefreshedAt: row.last_refreshed_at
    };
  } catch (error) {
    console.error("profile read:", error.message);
    return null;
  }
}

export async function getSiteRatingForMovie(env, { movieId, tmdbId, imdbId }) {
  if (!env.DB) return { avg: null, count: 0 };

  try {
    const rawImdb = String(imdbId || "").trim().replace(/^tt/, "");
    const tmdbIdStr = tmdbId != null
      ? String(tmdbId)
      : (movieId && /^\d+$/.test(String(movieId)) ? String(movieId) : null);

    const clauses = [];
    const params = [];

    if (tmdbIdStr) {
      clauses.push("(tmdb_id = ? OR movie_id = ?)");
      params.push(parseInt(tmdbIdStr) || tmdbIdStr, `tmdb:${tmdbIdStr}`);
    }

    if (rawImdb) {
      clauses.push("(imdb_id = ? OR imdb_id = ? OR movie_id = ?)");
      params.push(rawImdb, `tt${rawImdb}`, `imdb:${rawImdb}`);
    }

    if (movieId && !tmdbIdStr) {
      clauses.push("movie_id = ?");
      params.push(String(movieId));
    }

    if (!clauses.length) return { avg: null, count: 0 };

    const sql = `SELECT COUNT(*) AS c, AVG(user_rating) AS avg
      FROM user_movies
      WHERE user_rating IS NOT NULL AND (${clauses.join(" OR ")})`;

    const row = await env.DB.prepare(sql).bind(...params).first();
    const count = Number(row?.c || 0);
    const avg = row?.avg != null
      ? Math.round(Number(row.avg) * 10) / 10
      : null;

    return { avg, count };
  } catch (error) {
    console.warn("site rating:", error.message);
    return { avg: null, count: 0 };
  }
}

export async function getSiteRatingsBatch(env, movies) {
  if (!env.DB || !movies.length) return new Map();

  const results = new Map();
  for (const movie of movies) {
    results.set(String(movie.id), { count: 0, sum: 0 });
  }

  const tmdbIds = [];
  const imdbIds = [];
  const tmdbSet = new Set();
  const imdbSet = new Set();

  for (const movie of movies) {
    if (movie.id != null) {
      const id = parseInt(movie.id);
      if (Number.isFinite(id) && !tmdbSet.has(id)) {
        tmdbSet.add(id);
        tmdbIds.push(id);
      }
    }

    const imdb = String(movie.imdbID || movie.imdb_id || "")
      .replace(/^tt/, "")
      .trim();

    if (imdb && !imdbSet.has(imdb)) {
      imdbSet.add(imdb);
      imdbIds.push(imdb);
    }
  }

  if (!tmdbIds.length && !imdbIds.length) {
    for (const movie of movies) {
      results.set(String(movie.id), { avg: null, count: 0 });
    }
    return results;
  }

  const conditions = [];
  const params = [];

  if (tmdbIds.length) {
    const placeholders = tmdbIds.map(() => "?").join(",");
    conditions.push(`tmdb_id IN (${placeholders})`);
    params.push(...tmdbIds);

    conditions.push(`movie_id IN (${placeholders})`);
    params.push(...tmdbIds.map(id => `tmdb:${id}`));
  }

  if (imdbIds.length) {
    const placeholders = imdbIds.map(() => "?").join(",");
    conditions.push(`REPLACE(imdb_id, 'tt', '') IN (${placeholders})`);
    params.push(...imdbIds);

    conditions.push(`movie_id IN (${placeholders})`);
    params.push(...imdbIds.map(id => `imdb:${id}`));
  }

  const sql = `SELECT movie_id, tmdb_id,
      REPLACE(imdb_id, 'tt', '') AS imdb_clean, user_rating
    FROM user_movies
    WHERE user_rating IS NOT NULL AND (${conditions.join(" OR ")})`;

  let rows = [];

  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    rows = result.results || [];
  } catch (error) {
    console.warn("site-rating batch query:", error.message);
    return new Map(
      movies.map(movie => [String(movie.id), { avg: null, count: 0 }])
    );
  }

  for (const row of rows) {
    const rating = Number(row.user_rating);
    if (!Number.isFinite(rating)) continue;

    const rowTmdb = row.tmdb_id != null ? parseInt(row.tmdb_id) : null;
    const rowImdb = row.imdb_clean || null;
    const rowMovieId = String(row.movie_id || "");

    for (const movie of movies) {
      const movieTmdb = movie.id != null ? parseInt(movie.id) : null;
      const movieImdb = String(movie.imdbID || movie.imdb_id || "")
        .replace(/^tt/, "")
        .trim() || null;

      const tmdbMatch =
        movieTmdb != null &&
        Number.isFinite(movieTmdb) &&
        (rowTmdb === movieTmdb || rowMovieId === `tmdb:${movieTmdb}`);

      const imdbMatch =
        movieImdb != null &&
        (rowImdb === movieImdb || rowMovieId === `imdb:${movieImdb}`);

      if (tmdbMatch || imdbMatch) {
        const entry = results.get(String(movie.id));
        entry.count += 1;
        entry.sum += rating;
      }
    }
  }

  for (const [key, entry] of results) {
    if (entry.count > 0) {
      results.set(key, {
        avg: Math.round((entry.sum / entry.count) * 10) / 10,
        count: entry.count
      });
    } else {
      results.set(key, { avg: null, count: 0 });
    }
  }

  return results;
}

export async function putProfileRow(env, movieId, title, year, data, refreshed = false) {
  const db = requireDB(env, "profile write");

  if (!movieId) {
    throw new TypeError("movieId is required for profile write.");
  }

  const now = Math.floor(Date.now() / 1000);
  const refreshedAt = refreshed ? now : null;
  const safeTitle = title || data?.title || data?.original_title || data?.name || null;
  const safeYear = year || yearOf(data) || null;
  const dataJSON = serializeJSON(data, "Movie profile");

  await db.prepare(`INSERT INTO movie_profiles
    (movie_id, title, year, data_json, created_at, updated_at, last_refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(movie_id) DO UPDATE SET
      title = COALESCE(excluded.title, movie_profiles.title),
      year = COALESCE(excluded.year, movie_profiles.year),
      data_json = excluded.data_json,
      updated_at = excluded.updated_at,
      last_refreshed_at = COALESCE(excluded.last_refreshed_at, movie_profiles.last_refreshed_at)`)
    .bind(movieId, safeTitle, safeYear, dataJSON, now, now, refreshedAt)
    .run();
}

export async function getFieldRows(env, movieId) {
  if (!env.DB) return [];

  try {
    const { results } = await env.DB.prepare(
      "SELECT field, source, confidence, fetched_at FROM movie_profile_fields WHERE movie_id = ?"
    )
      .bind(movieId)
      .all();

    return results || [];
  } catch (error) {
    console.error("field rows read:", error.message);
    return [];
  }
}

export async function putFieldRows(env, movieId, fields, sourceLookup, confidenceLookup = null) {
  const db = requireDB(env, "profile field write");

  if (!Array.isArray(fields)) {
    throw new TypeError("fields must be an array.");
  }
  if (!fields.length) return;
  if (!movieId) {
    throw new TypeError("movieId is required for profile field write.");
  }

  const now = Math.floor(Date.now() / 1000);
  const sources = sourceLookup || {};

  const statements = fields.map(field => {
    if (typeof field !== "string" || !field) {
      throw new TypeError("Every profile field must be a non-empty string.");
    }

    const confidence = confidenceLookup
      ? (confidenceLookup[field] ?? null)
      : null;

    return db.prepare(`INSERT INTO movie_profile_fields
      (movie_id, field, source, confidence, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(movie_id, field) DO UPDATE SET
        source = excluded.source,
        confidence = COALESCE(excluded.confidence, movie_profile_fields.confidence),
        fetched_at = excluded.fetched_at`)
      .bind(movieId, field, sources[field] || "unknown", confidence, now);
  });

  await db.batch(statements);
}

export async function getProfileRowsBatch(env, movieIds) {
  if (!env.DB || !movieIds.length) return new Map();

  try {
    const placeholders = movieIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT movie_id, data_json, updated_at, last_refreshed_at
       FROM movie_profiles WHERE movie_id IN (${placeholders})`
    )
      .bind(...movieIds)
      .all();

    const byId = new Map();

    for (const row of results || []) {
      byId.set(row.movie_id, {
        data: safeJSON(row.data_json, {}) || {},
        updatedAt: row.updated_at,
        lastRefreshedAt: row.last_refreshed_at
      });
    }

    return byId;
  } catch (error) {
    console.error("profile batch read:", error.message);
    return new Map();
  }
}

export async function getFieldRowsBatch(env, movieIds) {
  if (!env.DB || !movieIds.length) return new Map();

  try {
    const placeholders = movieIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT movie_id, field, source, confidence, fetched_at
       FROM movie_profile_fields WHERE movie_id IN (${placeholders})`
    )
      .bind(...movieIds)
      .all();

    const byId = new Map();

    for (const row of results || []) {
      if (!byId.has(row.movie_id)) byId.set(row.movie_id, []);
      byId.get(row.movie_id).push(row);
    }

    return byId;
  } catch (error) {
    console.error("fields batch read:", error.message);
    return new Map();
  }
}

export async function putProfileRowsBatch(env, entries, refreshed = false) {
  const db = requireDB(env, "profile batch write");

  if (!Array.isArray(entries)) {
    throw new TypeError("entries must be an array.");
  }
  if (!entries.length) return;

  const now = Math.floor(Date.now() / 1000);
  const refreshedAt = refreshed ? now : null;

  const statements = entries.map((entry, index) => {
    if (!entry?.movieId) {
      throw new TypeError(`entries[${index}].movieId is required.`);
    }

    const safeTitle = entry.title || entry.data?.title || entry.data?.original_title || null;
    const safeYear = entry.year || yearOf(entry.data) || null;
    const dataJSON = serializeJSON(entry.data, `Profile data at entries[${index}]`);

    return db.prepare(`INSERT INTO movie_profiles
      (movie_id, title, year, data_json, created_at, updated_at, last_refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(movie_id) DO UPDATE SET
        title = COALESCE(excluded.title, movie_profiles.title),
        year = COALESCE(excluded.year, movie_profiles.year),
        data_json = excluded.data_json,
        updated_at = excluded.updated_at,
        last_refreshed_at = COALESCE(excluded.last_refreshed_at, movie_profiles.last_refreshed_at)`)
      .bind(entry.movieId, safeTitle, safeYear, dataJSON, now, now, refreshedAt);
  });

  await db.batch(statements);
}

export async function putFieldRowsBatch(env, entries) {
  const db = requireDB(env, "profile field batch write");

  if (!Array.isArray(entries)) {
    throw new TypeError("entries must be an array.");
  }
  if (!entries.length) return;

  const now = Math.floor(Date.now() / 1000);

  const statements = entries.map((entry, index) => {
    if (!entry?.movieId || typeof entry.field !== "string" || !entry.field) {
      throw new TypeError(`Invalid profile field entry at index ${index}.`);
    }

    return db.prepare(`INSERT INTO movie_profile_fields
      (movie_id, field, source, confidence, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(movie_id, field) DO UPDATE SET
        source = excluded.source,
        confidence = COALESCE(excluded.confidence, movie_profile_fields.confidence),
        fetched_at = excluded.fetched_at`)
      .bind(entry.movieId, entry.field, entry.source || "unknown", entry.confidence ?? null, now);
  });

  await db.batch(statements);
}

export async function getVerdictsBatch(env, movieIds, signature) {
  if (!env.DB || !movieIds.length) return new Map();

  try {
    const placeholders = movieIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT movie_id, verdict, reason, created_at
       FROM filter_verdicts
       WHERE movie_id IN (${placeholders}) AND filter_signature = ?`
    )
      .bind(...movieIds, signature)
      .all();

    const byId = new Map();
    const now = Math.floor(Date.now() / 1000);

    for (const row of results || []) {
      if (now - row.created_at > VERDICT_TTL) continue;

      byId.set(row.movie_id, {
        verdict: row.verdict,
        reason: row.reason || ""
      });
    }

    return byId;
  } catch (error) {
    console.warn("verdicts batch read:", error.message);
    return new Map();
  }
}

export async function putVerdictsBatch(env, entries, signature) {
  if (!env?.DB || !Array.isArray(entries) || !entries.length) return;

  const now = Math.floor(Date.now() / 1000);

  try {
    const statements = entries.map((entry, index) => {
      if (!entry?.movieId) {
        throw new TypeError(`entries[${index}].movieId is required.`);
      }

      return env.DB.prepare(`INSERT INTO filter_verdicts
        (movie_id, filter_signature, verdict, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(movie_id, filter_signature) DO UPDATE SET
          verdict = excluded.verdict,
          reason = excluded.reason,
          created_at = excluded.created_at`)
        .bind(entry.movieId, signature, entry.verdict, entry.reason || "", now);
    });

    await env.DB.batch(statements);
  } catch (error) {
    warnBestEffort("verdict batch", error);
  }
}

export async function getMetatakeExtendedCache(env, movieId) {
  if (!env.DB) return null;

  try {
    const row = await env.DB.prepare(
      "SELECT * FROM metatake_extended WHERE movie_id = ?"
    )
      .bind(movieId)
      .first();

    if (!row) return null;
    if (Math.floor(Date.now() / 1000) - row.fetched_at > 90 * 86400) return null;

    return {
      narrative_setting: safeJSON(row.narrative_setting_json, []) || [],
      kindred_films: safeJSON(row.kindred_films_json, []) || [],
      awards: safeJSON(row.awards_json, []) || [],
      confidence: row.confidence,
      locations: safeJSON(row.locations_json, []) || []
    };
  } catch (error) {
    console.warn("metatake extended cache read:", error.message);
    return null;
  }
}

export async function putMetatakeExtendedCache(env, movieId, data) {
  if (!env.DB) return;

  try {
    await env.DB.prepare(`INSERT INTO metatake_extended
      (movie_id, narrative_setting_json, kindred_films_json, awards_json,
       confidence, locations_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(movie_id) DO UPDATE SET
        narrative_setting_json = excluded.narrative_setting_json,
        kindred_films_json = excluded.kindred_films_json,
        awards_json = excluded.awards_json,
        confidence = excluded.confidence,
        locations_json = excluded.locations_json,
        fetched_at = excluded.fetched_at`)
      .bind(
        movieId,
        JSON.stringify(data.narrative_setting || []),
        JSON.stringify(data.kindred_films || []),
        JSON.stringify(data.awards || []),
        data.confidence ?? null,
        JSON.stringify(data.locations || []),
        Math.floor(Date.now() / 1000)
      )
      .run();
  } catch (error) {
    warnBestEffort("metatake extended cache", error);
  }
}

export async function getFilmmapCache(env, movieId) {
  if (!env.DB) return null;

  try {
    const row = await env.DB.prepare(
      "SELECT locations_json, fetched_at FROM filmmap_cache WHERE movie_id = ?"
    )
      .bind(movieId)
      .first();

    if (!row) return null;
    if (Math.floor(Date.now() / 1000) - row.fetched_at > 90 * 86400) return null;

    return safeJSON(row.locations_json, []);
  } catch (error) {
    console.warn("filmmap cache read:", error.message);
    return null;
  }
}

export async function putFilmmapCache(env, movieId, locations) {
  if (!env.DB) return;

  try {
    await env.DB.prepare(`INSERT INTO filmmap_cache
      (movie_id, locations_json, fetched_at)
      VALUES (?, ?, ?)
      ON CONFLICT(movie_id) DO UPDATE SET
        locations_json = excluded.locations_json,
        fetched_at = excluded.fetched_at`)
      .bind(movieId, JSON.stringify(locations), Math.floor(Date.now() / 1000))
      .run();
  } catch (error) {
    warnBestEffort("filmmap cache", error);
  }
}

export async function getVisualProfile(env, movieId) {
  if (!env.DB || !movieId) return null;

  try {
    const profile = await env.DB.prepare(
      "SELECT movie_id, schema_version, analysis_status, updated_at FROM visual_profiles WHERE movie_id = ?"
    )
      .bind(movieId)
      .first();

    if (!profile) return null;

    const { results: fields } = await env.DB.prepare(
      "SELECT field_name, value_json, confidence, sample_count, source_type, model_name, model_version, analyzed_at FROM visual_profile_fields WHERE movie_id = ?"
    )
      .bind(movieId)
      .all();

    const fieldMap = {};

    for (const field of fields || []) {
      fieldMap[field.field_name] = {
        value: safeJSON(field.value_json, null),
        confidence: field.confidence,
        sampleCount: field.sample_count,
        sourceType: field.source_type,
        modelName: field.model_name,
        modelVersion: field.model_version,
        analyzedAt: field.analyzed_at
      };
    }

    return {
      movieId: profile.movie_id,
      schemaVersion: profile.schema_version,
      analysisStatus: profile.analysis_status,
      updatedAt: profile.updated_at,
      fields: fieldMap
    };
  } catch (error) {
    console.warn("visual profile read:", error.message);
    return null;
  }
}

export async function getVisualProfilesBatch(env, movieIds) {
  if (!env.DB || !Array.isArray(movieIds) || !movieIds.length) return new Map();
  try {
    const placeholders = movieIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT f.movie_id, f.field_name, f.value_json, f.confidence, f.sample_count,
              f.source_type, f.model_name, f.model_version, f.analyzed_at,
              p.analysis_status, p.schema_version
       FROM visual_profile_fields f
       JOIN visual_profiles p ON p.movie_id = f.movie_id
       WHERE f.movie_id IN (${placeholders})`
    ).bind(...movieIds).all();
    const map = new Map();
    for (const row of results || []) {
      if (!map.has(row.movie_id)) map.set(row.movie_id, { analysisStatus: row.analysis_status, schemaVersion: row.schema_version, fields: {} });
      map.get(row.movie_id).fields[row.field_name] = {
        value: safeJSON(row.value_json, null), confidence: Number(row.confidence),
        sampleCount: Number(row.sample_count) || 0, sourceType: row.source_type,
        modelName: row.model_name, modelVersion: row.model_version, analyzedAt: row.analyzed_at
      };
    }
    return map;
  } catch (error) {
    console.warn("visual profile batch read:", error.message);
    return new Map();
  }
}

export async function putVisualProfile(env, movieId, fields, opts = {}) {
  const db = requireDB(env, "visual profile write");

  if (!movieId) {
    throw new TypeError("movieId is required for visual profile write.");
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new TypeError("fields must be an object.");
  }

  const entries = Object.entries(fields)
    .filter(([, entry]) => entry && typeof entry === "object");

  if (!entries.length) return;

  const now = Math.floor(Date.now() / 1000);
  const schemaVersion = opts.schemaVersion || 1;
  const status = opts.status || "complete";

  const statements = [
    db.prepare(`INSERT INTO visual_profiles
      (movie_id, schema_version, analysis_status, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(movie_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        analysis_status = excluded.analysis_status,
        updated_at = excluded.updated_at`)
      .bind(movieId, schemaVersion, status, now)
  ];

  for (const [name, entry] of entries) {
    const valueJSON = serializeJSON(entry.value, `Visual profile field ${name}`);

    statements.push(
      db.prepare(`INSERT INTO visual_profile_fields
        (movie_id, field_name, value_json, confidence, sample_count,
         source_type, model_name, model_version, analyzed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(movie_id, field_name) DO UPDATE SET
          value_json = excluded.value_json,
          confidence = excluded.confidence,
          sample_count = excluded.sample_count,
          source_type = excluded.source_type,
          model_name = excluded.model_name,
          model_version = excluded.model_version,
          analyzed_at = excluded.analyzed_at`)
        .bind(
          movieId,
          name,
          valueJSON,
          entry.confidence ?? null,
          entry.sampleCount ?? 1,
          entry.sourceType || "poster",
          entry.modelName || "canvas-colorthief",
          entry.modelVersion || "1.0",
          entry.analyzedAt || now
        )
    );
  }

  // Profil üst kaydı ve alan kayıtları tek transaction/batch içinde yazılır.
  await db.batch(statements);
}

export function isBadDetailArray(val) {
  if (!Array.isArray(val) || val.length === 0) return false;

  const looksLikeId = value => {
    if (typeof value !== "string") return false;

    const text = value.trim();
    if (!text) return true;

    return /^(nm|tt)\d+$/i.test(text) ||
      /^\d+$/.test(text) ||
      /^[QP]\d+$/.test(text) ||
      /^person[\/_-]\d+$/i.test(text) ||
      /^id[\/_-]?\d+$/i.test(text) ||
      /^@\d+$/.test(text) ||
      /^\[object /i.test(text) ||
      /^\{.*\}$/.test(text) ||
      /^\[.*\]$/.test(text) ||
      /":\s*"/.test(text) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text);
  };

  return val.some(value => {
    if (value == null) return true;

    if (typeof value === "string") {
      return looksLikeId(value);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return true;
    }

    if (typeof value === "object") {
      const candidates = [value.name, value.original_name];

      for (const candidate of candidates) {
        if (
          typeof candidate === "string" &&
          candidate.trim() &&
          !looksLikeId(candidate)
        ) {
          return false;
        }
      }

      return true;
    }

    return true;
  });
}

export function findStaleFields(profile, fieldRows, forceRefresh) {
  const now = Math.floor(Date.now() / 1000);
  const fetched = new Map(fieldRows.map(row => [row.field, Number(row.fetched_at)]));
  const stale = [];

  const detailFields = new Set([
    "writers", "writers_ids", "cast", "cast_ids",
    "director", "director_ids", "producers", "actors", "omdb_directors"
  ]);

  // Faz B: subgenres, tropes, themes arrayFields'a eklendi.
  const arrayFields = new Set([
    "genres", "genres_ids", "spoken_languages", "spoken_languages_ids",
    "production_countries", "production_countries_ids",
    "production_companies", "production_companies_ids",
    "director", "director_ids", "writers", "writers_ids",
    "producers", "cast", "cast_ids",
    "keywords", "keywords_ids",
    "story_locations", "story_period", "story_geography", "season",
    "character_traits",
    "narrative_style", "narrative_pace",
    "production_category", "cinema_approach", "technical_style",
    "sound", "reality", "story_dimensions",
    "related_films", "related_films_detail",
    "filming_locations", "filming_countries",
    "awards_ids", "nominated_ids",
    "color_style", "aspect_ratio", "location_mode",
    "subgenres", "tropes", "themes"
  ]);

  for (const [field, definition] of Object.entries(FIELD_DEFS)) {
    const raw = profile[field];
    const isEmptyArray = Array.isArray(raw) && raw.length === 0;
    const isEmptyString = typeof raw === "string" && raw.trim() === "";
    const hasValue =
      raw !== undefined &&
      raw !== null &&
      !isEmptyArray &&
      !isEmptyString;

    const badData =
      hasValue &&
      detailFields.has(field) &&
      isBadDetailArray(raw);

    if (!hasValue || badData) {
      stale.push(field);
      continue;
    }

    if (arrayFields.has(field) && !Array.isArray(raw)) {
      stale.push(field);
      continue;
    }

    if (forceRefresh) {
      stale.push(field);
      continue;
    }

    if (definition.ttl == null) continue;

    const fetchedAt = fetched.get(field) || 0;
    if (now - fetchedAt > definition.ttl) {
      stale.push(field);
    }
  }

  return stale;
}

export async function loadDeadKeys(env) {
  const now = Date.now();

  if (now - deadKeysCache.ts < 30000) return deadKeysCache;
  if (!env.DB) return deadKeysCache;

  try {
    const { results } = await env.DB.prepare(
      "SELECT provider, key_index, model FROM dead_keys WHERE until_ts > ?"
    )
      .bind(Math.floor(now / 1000))
      .all();

    const gemini = new Map();
    const groq = new Set();

    for (const row of results || []) {
      if (row.provider === "gemini") {
        if (!gemini.has(row.model)) {
          gemini.set(row.model, new Set());
        }
        gemini.get(row.model).add(row.key_index);
      } else if (row.provider === "groq") {
        groq.add(row.key_index);
      }
    }

    deadKeysCache.ts = now;
    deadKeysCache.gemini = gemini;
    deadKeysCache.groq = groq;

    return deadKeysCache;
  } catch (error) {
    console.warn("dead_keys read:", error.message);
    return deadKeysCache;
  }
}

export function isKeyDeadForModel(dead, model, index) {
  const forModel = dead.gemini.get(model) || new Set();
  const forAll = dead.gemini.get("") || new Set();

  return forModel.has(index) || forAll.has(index);
}

export async function markDeadKey(env, provider, keyIndex, untilTs, reason, model) {
  deadKeysCache.ts = 0;
  if (!env.DB) return;

  try {
    await env.DB.prepare(`INSERT INTO dead_keys
      (provider, key_index, model, until_ts, reason)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, key_index, model) DO UPDATE SET
        until_ts = excluded.until_ts,
        reason = excluded.reason`)
      .bind(provider, keyIndex, model || "", untilTs, reason || "")
      .run();
  } catch (error) {
    warnBestEffort("dead_keys write", error);
  }
}

export function logLlmCall(
  env,
  provider,
  model,
  keyIndex,
  ok,
  latencyMs,
  errSnippet,
  context
) {
  if (!env.DB) return;

  const now = Math.floor(Date.now() / 1000);
  const ctx = context || {};

  const inputTokens = ctx.inputTokens ?? null;
  const outputTokens = ctx.outputTokens ?? null;
  const wasFallback = ctx.wasFallback ? 1 : 0;
  const fromCache = ctx.fromCache ? 1 : 0;
  const httpStatus = ctx.httpStatus ?? null;
  const retryCount = ctx.retryCount ?? 0;

  env.DB.prepare(
    `INSERT INTO llm_calls
      (ts, provider, model, key_index, ok, latency_ms, error_snippet,
       input_tokens, output_tokens, was_fallback, from_cache,
       http_status, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      now,
      provider,
      model,
      keyIndex,
      ok ? 1 : 0,
      latencyMs,
      errSnippet || null,
      inputTokens,
      outputTokens,
      wasFallback,
      fromCache,
      httpStatus,
      retryCount
    )
    .run()
    .catch(error => warnBestEffort("LLM call log", error));

  try {
    recordLlmRpm(env, provider, model, keyIndex);
  } catch (error) {
    warnBestEffort("RPM track scheduling", error);
  }
}

export async function getDailyModelCalls(env, provider, model) {
  if (!env.DB) return 0;

  try {
    const since = Math.floor(Date.now() / 1000) - 86400;

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM llm_calls WHERE provider = ? AND model = ? AND ok = 1 AND ts > ?"
    )
      .bind(provider, model, since)
      .first();

    return Number(row?.c || 0);
  } catch (error) {
    console.warn("daily model calls read:", error.message);
    return 0;
  }
}

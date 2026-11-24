// admin.js — /admin/users listesinde rating_visibility döndürüldü
// Faz 3: CORS temizlendi (yerel "*" + credentials çelişkisi giderildi; index.js corsHeaders(request) ekler)
import { getCurrentUserWithAdminBridge } from "./auth.js";
import { processAdminTaskQueue } from "./admin-task-queue.js";

// === CORS: sadece method + header. Origin ve Credentials index.js son katmanı tarafından eklenir. ===
const CORS = { "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
function jsonRes(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } }); }
function jsonErr(msg, status = 500) { return jsonRes({ error: String(msg) }, status); }
function safeJSON(t, fb = null) { try { return JSON.parse(t); } catch { return fb; } }

async function requireAdmin(env, request) {
  const sess = await getCurrentUserWithAdminBridge(env, request);
  if (!sess || sess.is_suspended) {
    throw Object.assign(new Error("Giriş gerekli"), { status: 401 });
  }

  const path = new URL(request.url).pathname.replace(/^\/admin/, "");
  const isBulkRoute = path.startsWith("/bulk/");
  const isExternalReadRoute =
    path === "/hf-import/datasets" ||
    path === "/hf-import/dataset-rows";

  if (!sess.is_admin && !isBulkRoute && !isExternalReadRoute) {
    throw Object.assign(new Error("Admin yetkisi gerekli"), { status: 403 });
  }
  return sess;
}

const MANAGEMENT_PERMISSIONS = [
  "user_lists_view",
  "lists_bulk_remove",
  "lists_bulk_clear",
  "db_cards_view",
  "db_cards_bulk_open",
  "db_cards_bulk_refresh",
  "db_cards_bulk_delete",
  "csv_cards_view",
  "csv_cards_bulk_open",
  "csv_cards_bulk_refresh",
  "csv_cards_bulk_remove",
  "csv_cards_bulk_delete",
  "external_import_view",
  "external_import_bulk_remove",
  "external_import_bulk_delete"
];

const ALLOWED_PERMS = new Set([
  "refresh_movie",
  "edit_suggestions_approve",
  "comment_approve",
  "user_manage",
  "field_unlock",
  "csv_import_cards",
  "view_private",
  ...MANAGEMENT_PERMISSIONS
]);

const BULK_TASK_PERMISSIONS = {
  refresh_cards: "db_cards_bulk_refresh",
  create_cards: "db_cards_bulk_open",
  delete_cards: "db_cards_bulk_delete",
  create_csv_cards: "csv_cards_bulk_open",
  refresh_csv_cards: "csv_cards_bulk_refresh",
  remove_csv_cards: "csv_cards_bulk_remove",
  delete_csv_cards: "csv_cards_bulk_delete",
  remove_external_import: "external_import_bulk_remove",
  delete_external_import: "external_import_bulk_delete"
};

function hashListSnapshot(rows) {
  let hash = 2166136261;
  for (const row of rows || []) {
    const value = `${String(row.movie_id || "")}\u0000${row.user_rating == null ? "" : String(row.user_rating)}\u0001`;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function permissionForTask(task) {
  if (task?.task_type === "delete_list") {
    try {
      const parsed = JSON.parse(task.target || "null");
      if (parsed && Array.isArray(parsed.movieIds)) return "lists_bulk_remove";
    } catch {}
    return "lists_bulk_clear";
  }
  return BULK_TASK_PERMISSIONS[task?.task_type] || null;
}

async function hasExactPermission(env, sess, permission) {
  if (sess?.is_admin) return true;
  if (!sess || !permission) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ? LIMIT 1"
    ).bind(sess.user_id, permission).first();
    return !!row;
  } catch {
    return false;
  }
}

async function hasAnyBulkPermission(env, sess) {
  if (sess?.is_admin) return true;
  const permissions = [...Object.values(BULK_TASK_PERMISSIONS), "lists_bulk_remove", "lists_bulk_clear"];
  try {
    const placeholders = permissions.map(() => "?").join(",");
    const row = await env.DB.prepare(
      `SELECT 1 FROM user_permissions WHERE user_id = ? AND permission IN (${placeholders}) LIMIT 1`
    ).bind(sess.user_id, ...permissions).first();
    return !!row;
  } catch {
    return false;
  }
}

function _globalRowHash(s) {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function _cleanImdb(v) { return String(v || "").replace(/^tt/i, "").trim(); }
function _globalMovieId(row) {
  const imdb = _cleanImdb(row.imdb_id || row.Const || row.imdbId);
  if (imdb) return "imdb:" + imdb;
  const tmdb = parseInt(row.tmdb_id || row.tmdbId);
  if (Number.isFinite(tmdb)) return "tmdb:" + tmdb;
  return "row:" + _globalRowHash(String(row.title_original || row.title || "") + "|" + String(row.year || ""));
}
async function _upsertGlobalRows(env, rows, dataset, revision, atomicTail = null) {
  const now = Math.floor(Date.now() / 1000);
  const stmts = [];
  for (const row of rows) {
    const imdb = _cleanImdb(row.imdb_id || row.Const || row.imdbId);
    const tmdb = parseInt(row.tmdb_id || row.tmdbId);
    const movieId = _globalMovieId(row);
    const titleOriginal = String(row.title_original || row.original_title || row.title || "").trim();
    const titleTr = String(row.title_tr || row.title || "").trim();
    const year = parseInt(row.year) || null;
    const runtime = parseInt(row.runtime) || null;
    const imdbRating = row.imdb_rating != null ? Number(row.imdb_rating) : (row.imdbRating != null ? Number(row.imdbRating) : null);
    const imdbVotes = parseInt(String(row.imdb_votes || row.imdbVotes || "").replace(/[^\d]/g, "")) || null;
    const genres = Array.isArray(row.genres) ? row.genres.join(", ") : String(row.genres || "");
    const directors = Array.isArray(row.directors) ? row.directors.join(", ") : String(row.directors || "");
    const dataJson = JSON.stringify({ ...row, _raw_csv: row._raw_csv || row });
    const rowHash = _globalRowHash(`${imdb}|${titleOriginal}|${year}|${dataset}|${revision || ""}`);
    stmts.push(env.DB.prepare(
      `INSERT INTO global_movies (movie_id, imdb_id, tmdb_id, title_original, title_tr, year, runtime, imdb_rating, imdb_votes, genres, directors, source_dataset, source_revision, source_row_hash, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(movie_id) DO UPDATE SET
         imdb_id = excluded.imdb_id,
         tmdb_id = excluded.tmdb_id,
         title_original = excluded.title_original,
         title_tr = excluded.title_tr,
         year = excluded.year,
         runtime = excluded.runtime,
         imdb_rating = excluded.imdb_rating,
         imdb_votes = excluded.imdb_votes,
         genres = excluded.genres,
         directors = excluded.directors,
         source_dataset = excluded.source_dataset,
         source_revision = excluded.source_revision,
         source_row_hash = excluded.source_row_hash,
         data_json = excluded.data_json,
         updated_at = excluded.updated_at`
    ).bind(movieId, imdb || null, Number.isFinite(tmdb) ? tmdb : null, titleOriginal || null, titleTr || null, year, runtime, imdbRating, imdbVotes, genres || null, directors || null, dataset, revision || null, rowHash, dataJson, now, now));
  }
  if (atomicTail) {
    const tail = typeof atomicTail === "function" ? atomicTail({ inserted: rows.length, updated: 0, skipped: 0 }) : atomicTail;
    await env.DB.batch([...stmts, ...tail]);
  } else {
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  }
  return { inserted: rows.length, updated: 0, skipped: 0 };
}

export async function handleAdmin(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/admin/, "");
  const now = () => Math.floor(Date.now() / 1000);
  try {
    const sess = await requireAdmin(env, request);

    if (path === "/users" && request.method === "GET") {
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
      const requestedPageSize = parseInt(url.searchParams.get("pageSize") || "10", 10);
      const pageSize = Number.isFinite(requestedPageSize)
        ? Math.min(100, Math.max(10, Math.floor(requestedPageSize / 10) * 10))
        : 10;
      const offset = (page - 1) * pageSize;
      const { results } = await env.DB.prepare(
        `SELECT id, register_number, username, email, is_admin, is_approved, is_public, is_suspended, rating_visibility, created_at, suspended_at
         FROM users WHERE deleted_at IS NULL ORDER BY id ASC LIMIT ? OFFSET ?`
      ).bind(pageSize, offset).all();
      const { results: countRows } = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL").all();
      const permsRows = await env.DB.prepare("SELECT user_id, permission FROM user_permissions").all();
      const permsByUser = new Map();
      for (const r of permsRows.results || []) { if (!permsByUser.has(r.user_id)) permsByUser.set(r.user_id, []); permsByUser.get(r.user_id).push(r.permission); }
      const users = (results || []).map(u => ({ ...u, permissions: permsByUser.get(u.id) || [] }));
      return jsonRes({ users, total: countRows[0]?.c || 0, page, pageSize });
    }
    if (path === "/hf-import/datasets" && request.method === "GET") {
        if (!(await hasExactPermission(env, sess, "external_import_view"))) {
            return jsonErr("Harici veri kümelerini görüntüleme yetkiniz yok.", 403);
        }
        const { results } = await env.DB.prepare(`
            SELECT source_dataset, COUNT(*) AS row_count,
                   MAX(updated_at) AS updated_at,
                   MAX(source_revision) AS source_revision
            FROM global_movies
            WHERE source_dataset IS NOT NULL AND source_dataset <> ''
            GROUP BY source_dataset
            ORDER BY MAX(updated_at) DESC
            LIMIT 500
        `).all();
        return jsonRes({ datasets: results || [] });
    }

    if (path === "/hf-import/dataset-rows" && request.method === "GET") {
        if (!(await hasExactPermission(env, sess, "external_import_view"))) {
            return jsonErr("Harici veri kayıtlarını görüntüleme yetkiniz yok.", 403);
        }
        const dataset = String(url.searchParams.get("dataset") || "").trim();
        if (!dataset || dataset.length > 255) return jsonErr("Geçerli source_dataset gerekli.", 400);
        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
        const requestedSize = parseInt(url.searchParams.get("pageSize") || "20", 10);
        const pageSize = Number.isFinite(requestedSize)
            ? Math.min(100, Math.max(10, Math.floor(requestedSize / 10) * 10))
            : 20;
        const offset = (page - 1) * pageSize;
        const { results } = await env.DB.prepare(`
            SELECT movie_id, imdb_id, tmdb_id, title_original, year, source_revision, updated_at
            FROM global_movies
            WHERE source_dataset = ?
            ORDER BY updated_at DESC, movie_id
            LIMIT ? OFFSET ?
        `).bind(dataset, pageSize, offset).all();
        const count = await env.DB.prepare(
            "SELECT COUNT(*) AS total FROM global_movies WHERE source_dataset=?"
        ).bind(dataset).first();
        return jsonRes({
            rows: results || [],
            total: Number(count?.total || 0),
            page,
            pageSize
        });
    }

    if (path.startsWith("/users/") && request.method === "PUT") {
      const id = parseInt(path.replace("/users/", "").split("/")[0]);
      let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); }
      const updates = [], params = [];
      if (typeof body.isApproved === "boolean") { updates.push("is_approved = ?"); params.push(body.isApproved ? 1 : 0); }
      if (typeof body.isSuspended === "boolean") { updates.push("is_suspended = ?"); params.push(body.isSuspended ? 1 : 0); updates.push("suspended_at = ?"); params.push(body.isSuspended ? now() : null); }
      if (typeof body.isAdmin === "boolean") { updates.push("is_admin = ?"); params.push(body.isAdmin ? 1 : 0); }
      if (typeof body.username === "string" && body.username.trim()) {
        const newName = body.username.trim();
        if (!/^[A-Za-z0-9_.-]{3,32}$/.test(newName)) return jsonErr("Geçersiz kullanıcı adı", 400);
        const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ? AND deleted_at IS NULL").bind(newName, id).first();
        if (existing) return jsonErr("Kullanıcı adı zaten alınmış", 409);
        updates.push("username = ?"); params.push(newName);
      }
      if (body.deleted === true) { updates.push("deleted_at = ?"); params.push(now()); }
      if (updates.length) { updates.push("updated_at = ?"); params.push(now(), id); await env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...params).run(); }
      return jsonRes({ ok: true });
    }

    if (path.match(/^\/users\/\d+\/permissions$/) && request.method === "PUT") {
      const id = parseInt(path.split("/")[2]);
      let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); }
      const perm = String(body.permission || "");
      if (!ALLOWED_PERMS.has(perm)) return jsonErr("Geçersiz izin", 400);
      if (body.grant) {
        await env.DB.prepare(`INSERT INTO user_permissions (user_id, permission, granted_by, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, permission) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at`).bind(id, perm, sess.user_id, now()).run();
      } else {
        await env.DB.prepare("DELETE FROM user_permissions WHERE user_id = ? AND permission = ?").bind(id, perm).run();
      }
      return jsonRes({ ok: true });
    }

    if (path === "/unlock-ip" && request.method === "POST") { let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); } const ip = String(body.ip || "").trim(); if (!ip) return jsonErr("ip gerekli", 400); await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run(); return jsonRes({ ok: true }); }
    if (path === "/unlock-user" && request.method === "POST") { let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); } const userId = parseInt(body.userId); if (!userId) return jsonErr("userId gerekli", 400); await env.DB.prepare("DELETE FROM user_lockouts WHERE user_id = ?").bind(userId).run(); return jsonRes({ ok: true }); }
    if (path === "/locked-accounts" && request.method === "GET") { const nowTs = Math.floor(Date.now() / 1000); const { results: ipLocks } = await env.DB.prepare("SELECT ip, attempts, last_attempt_ts, locked_until_ts FROM login_attempts WHERE locked_until_ts > ?").bind(nowTs).all(); const { results: userLocks } = await env.DB.prepare(`SELECT l.user_id, l.failed_attempts, l.locked_until_ts, u.username FROM user_lockouts l JOIN users u ON u.id = l.user_id WHERE l.locked_until_ts > ?`).bind(nowTs).all(); return jsonRes({ ipLocks: ipLocks || [], userLocks: userLocks || [] }); }

    if (path === "/messages" && request.method === "GET") { const { results } = await env.DB.prepare("SELECT id, email, subject, content, ip, created_at, read_at FROM admin_messages ORDER BY created_at DESC LIMIT 200").all(); return jsonRes({ messages: results || [] }); }
    if (path.match(/^\/messages\/\d+\/read$/) && request.method === "PUT") { const id = parseInt(path.split("/")[2]); await env.DB.prepare("UPDATE admin_messages SET read_at = ? WHERE id = ? AND read_at IS NULL").bind(now(), id).run(); return jsonRes({ ok: true }); }

    if (path === "/comments" && request.method === "GET") { const status = url.searchParams.get("status") || "pending"; const { results } = await env.DB.prepare(`SELECT c.id, c.movie_id, c.content, c.status, c.created_at, u.username, u.id AS user_id FROM comments c JOIN users u ON u.id = c.user_id WHERE c.status = ? ORDER BY c.created_at ASC LIMIT 100`).bind(status).all(); return jsonRes({ comments: results || [] }); }
    if (path.match(/^\/comments\/\d+$/) && request.method === "PUT") { const id = parseInt(path.split("/")[2]); let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); } const newStatus = String(body.status || ""); if (!["approved","rejected","edited"].includes(newStatus)) return jsonErr("Geçersiz durum", 400); const content = body.content ? String(body.content).trim() : null; if (content) { await env.DB.prepare("UPDATE comments SET content = ?, status = ?, edited_by = ?, edited_at = ?, updated_at = ? WHERE id = ?").bind(content, newStatus, sess.user_id, now(), now(), id).run(); } else { await env.DB.prepare("UPDATE comments SET status = ?, updated_at = ? WHERE id = ?").bind(newStatus, now(), id).run(); } return jsonRes({ ok: true }); }

    if (path.match(/^\/locks\/[^/]+\/[^/]+$/) && request.method === "POST") { const parts = path.split("/"); await env.DB.prepare(`INSERT INTO movie_field_locks (movie_id, field, locked_by, locked_at) VALUES (?, ?, ?, ?) ON CONFLICT(movie_id, field) DO UPDATE SET locked_by = excluded.locked_by, locked_at = excluded.locked_at`).bind(decodeURIComponent(parts[2]), decodeURIComponent(parts[3]), sess.user_id, now()).run(); return jsonRes({ ok: true }); }
    if (path.match(/^\/locks\/[^/]+\/[^/]+$/) && request.method === "DELETE") { const parts = path.split("/"); await env.DB.prepare("DELETE FROM movie_field_locks WHERE movie_id = ? AND field = ?").bind(decodeURIComponent(parts[2]), decodeURIComponent(parts[3])).run(); return jsonRes({ ok: true }); }
    if (path.startsWith("/locks/") && request.method === "GET") { const movieId = decodeURIComponent(path.replace("/locks/", "")); const { results } = await env.DB.prepare("SELECT field, locked_by, locked_at FROM movie_field_locks WHERE movie_id = ?").bind(movieId).all(); return jsonRes({ movieId, locks: results || [] }); }

    if (path === "/suggestions" && request.method === "GET") { const status = url.searchParams.get("status") || "pending"; const { results } = await env.DB.prepare(`SELECT s.id, s.movie_id, s.field, s.suggested_value_json, s.status, s.created_at, u.username FROM edit_suggestions s JOIN users u ON u.id = s.user_id WHERE s.status = ? ORDER BY s.created_at ASC LIMIT 100`).bind(status).all(); return jsonRes({ suggestions: (results || []).map(r => ({ ...r, value: safeJSON(r.suggested_value_json, null) })) }); }
    if (path.match(/^\/suggestions\/\d+$/) && request.method === "PUT") {
      const id = parseInt(path.split("/")[2]);
      let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); }
      const newStatus = String(body.status || "");
      if (!["approved","rejected"].includes(newStatus)) return jsonErr("Geçersiz durum", 400);
      const sug = await env.DB.prepare("SELECT * FROM edit_suggestions WHERE id = ?").bind(id).first();
      if (!sug) return jsonErr("Öneri bulunamadı", 404);
      if (newStatus === "approved") {
        const movie = await env.DB.prepare("SELECT data_json FROM movie_profiles WHERE movie_id = ?").bind(sug.movie_id).first();
        if (movie) { const profile = safeJSON(movie.data_json, {}) || {}; profile[sug.field] = safeJSON(sug.suggested_value_json, null); await env.DB.prepare("UPDATE movie_profiles SET data_json = ?, updated_at = ? WHERE movie_id = ?").bind(JSON.stringify(profile), now(), sug.movie_id).run(); }
      }
      await env.DB.prepare("UPDATE edit_suggestions SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(newStatus, sess.user_id, now(), id).run();
      return jsonRes({ ok: true });
    }

// ============================================================
// TURSO: ADMIN TOPLU GÖREVLERİ
// ============================================================

if (path === "/bulk/task" && request.method === "POST") {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonErr("Geçersiz JSON", 400);
    }

    const taskType = String(body.taskType || "").trim();
    const target = String(body.target || "").trim();
    const listType = String(body.listType || "").trim();

    const allowed = [
        "refresh_cards",
        "delete_cards",
        "create_cards",
        "delete_list",
        "create_csv_cards",
        "refresh_csv_cards",
        "remove_csv_cards",
        "delete_csv_cards",
        "remove_external_import",
        "delete_external_import"
    ];

    if (!allowed.includes(taskType)) {
        return jsonErr("Geçersiz taskType", 400);
    }

    const selectedListIds = taskType === "delete_list" && body.movieIds != null
        ? body.movieIds
        : null;
    const requiredPermission = taskType === "delete_list"
        ? (selectedListIds ? "lists_bulk_remove" : "lists_bulk_clear")
        : BULK_TASK_PERMISSIONS[taskType];
    if (!(await hasExactPermission(env, sess, requiredPermission))) {
        return jsonErr("Bu toplu işlem için özel yetkiniz yok", 403);
    }

    let taskTarget = target || null;
    if (taskType === "delete_list") {
        const targetUserId = Number(body.userId ?? target);
        if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
            return jsonErr("Liste işlemi için geçerli user_id gereklidir", 400);
        }
        if (!["watched", "want", "wont"].includes(listType)) {
            return jsonErr("Geçersiz listType", 400);
        }
        if (selectedListIds !== null) {
            if (!Array.isArray(selectedListIds) || !selectedListIds.length || selectedListIds.length > 100 ||
                selectedListIds.some(id => typeof id !== "string" || !id.trim() || id.length > 200)) {
                return jsonErr("Seçili film ID listesi 1–100 geçerli kayıt içermeli", 400);
            }
            taskTarget = JSON.stringify({ userId: targetUserId, movieIds: [...new Set(selectedListIds)] });
        } else {
            taskTarget = String(targetUserId);
        }

        const action = String(body.action || "");
        if (action === "preview" || action === "confirm") {
            const selectedClause = selectedListIds
                ? ` AND movie_id IN (${[...new Set(selectedListIds)].map(() => "?").join(",")})`
                : "";
            const selectedArgs = selectedListIds ? [...new Set(selectedListIds)] : [];
            const { results: snapshotRows } = await env.DB.prepare(`
                SELECT movie_id, user_rating
                FROM user_movies
                WHERE user_id = ? AND list_type = ?${selectedClause}
                ORDER BY movie_id
            `).bind(targetUserId, listType, ...selectedArgs).all();
            const previewTotal = (snapshotRows || []).length;
            const ratedCount = (snapshotRows || []).filter(row => row.user_rating != null).length;
            const snapshotHash = hashListSnapshot(snapshotRows || []);
            if (action === "preview") {
                return jsonRes({ ok: true, preview: true, total: previewTotal, ratedCount, snapshotHash });
            }
            const expectedCount = Number(body.expectedCount);
            const expectedHash = String(body.snapshotHash || "");
            if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || !expectedHash) {
                return jsonErr("Önizlemeden dönen expectedCount ve snapshotHash gerekli", 400);
            }
            if (expectedCount !== previewTotal || expectedHash !== snapshotHash) {
                return jsonRes({ ok: false, error: "Liste önizlemeden sonra değişmiş. Yeniden önizleme yapın.", total: previewTotal, ratedCount, snapshotHash }, 409);
            }
            const targetPayload = { userId: targetUserId, expectedCount, snapshotHash };
            if (selectedListIds !== null) targetPayload.movieIds = [...new Set(selectedListIds)];
            taskTarget = JSON.stringify(targetPayload);
        } else {
            return jsonErr("Liste silme için önce preview, ardından confirm gönderilmelidir", 400);
        }
    }

    if (taskType === "delete_cards") {
        let ids;
        try {
            ids = JSON.parse(target || "[]");
        } catch {
            return jsonErr("delete_cards target geçerli JSON dizisi olmalı", 400);
        }

        if (!Array.isArray(ids) || !ids.length) {
            return jsonErr("Silinecek film ID listesi boş", 400);
        }
    }

    const timestamp = Math.floor(Date.now() / 1000);
    let itemPayloads = [];

    if (taskType === "delete_list") {
        let parsed = {};
        try { parsed = JSON.parse(taskTarget || "{}"); } catch {}
        const targetUserId = Number(parsed.userId || body.userId || target);
        const selectedIds = Array.isArray(parsed.movieIds) ? [...new Set(parsed.movieIds)] : null;
        const selectedClause = selectedIds
            ? ` AND movie_id IN (${selectedIds.map(() => "?").join(",")})`
            : "";
        const { results: rows } = await env.DB.prepare(`
            SELECT movie_id, user_rating
            FROM user_movies
            WHERE user_id = ? AND list_type = ?${selectedClause}
            ORDER BY movie_id
        `).bind(targetUserId, listType, ...(selectedIds || [])).all();

        if (Number.isSafeInteger(parsed.expectedCount) &&
            (rows || []).length !== parsed.expectedCount) {
            return jsonErr("Liste onaydan sonra değişmiş; yeniden önizleme yapın.", 409);
        }
        if (parsed.snapshotHash &&
            hashListSnapshot(rows || []) !== String(parsed.snapshotHash)) {
            return jsonErr("Liste onaydan sonra değişmiş; yeniden önizleme yapın.", 409);
        }
        itemPayloads = (rows || []).map(row => ({
            key: String(row.movie_id),
            payload: { userId: targetUserId, listType, movieId: String(row.movie_id) }
        }));
    } else if (taskType === "delete_cards") {
        const ids = JSON.parse(target || "[]");
        if (!Array.isArray(ids) || !ids.length || ids.length > 10000) {
            return jsonErr("Silinecek film ID listesi 1–10.000 kayıt içermeli.", 400);
        }
        itemPayloads = [...new Set(ids.map(String))].map(id => ({
            key: id,
            payload: { movieId: id }
        }));
    } else if (taskType === "remove_external_import" || taskType === "delete_external_import") {
        const dataset = String(body.sourceDataset || "").trim();
        if (!dataset || dataset.length > 255) return jsonErr("Geçerli sourceDataset gerekli.", 400);
        let rows;
        if (taskType === "remove_external_import") {
            const ids = body.movieIds;
            if (!Array.isArray(ids) || !ids.length || ids.length > 1000) {
                return jsonErr("Harici listeden kaldırmak için 1–1.000 film ID seçin.", 400);
            }
            const uniqueIds = [...new Set(ids.map(String))];
            const placeholders = uniqueIds.map(() => "?").join(",");
            const result = await env.DB.prepare(`
                SELECT movie_id FROM global_movies
                WHERE source_dataset=? AND movie_id IN (${placeholders})
            `).bind(dataset, ...uniqueIds).all();
            rows = result.results || [];
        } else {
            const result = await env.DB.prepare(
                "SELECT movie_id FROM global_movies WHERE source_dataset=? ORDER BY movie_id"
            ).bind(dataset).all();
            rows = result.results || [];
            if (body.expectedCount != null &&
                (!Number.isSafeInteger(Number(body.expectedCount)) ||
                 Number(body.expectedCount) !== rows.length)) {
                return jsonErr("Veri kümesi önizlemeden sonra değişmiş; listeyi yenileyip tekrar onaylayın.", 409);
            }
        }
        if (taskType === "remove_external_import" && rows.length !== new Set(body.movieIds.map(String)).size) {
            return jsonErr("Seçilen kayıtların bir kısmı veri kümesinde bulunamadı; listeyi yenileyin.", 409);
        }
        itemPayloads = rows.map(row => ({
            key: String(row.movie_id),
            payload: { movieId: String(row.movie_id), sourceDataset: dataset }
        }));
        if (taskType === "delete_external_import") {
            itemPayloads.push({
                key: "__finalize__",
                payload: { finalize: true, sourceDataset: dataset }
            });
        }
        taskTarget = JSON.stringify({ sourceDataset: dataset });
    } else if (["create_csv_cards", "refresh_csv_cards", "remove_csv_cards", "delete_csv_cards"].includes(taskType)) {
        const selectedRows = body.rows;
        if (!Array.isArray(selectedRows) || !selectedRows.length || selectedRows.length > 1000) {
            return jsonErr("CSV işlemi için 1–1.000 seçili kayıt gerekli.", 400);
        }
        const seenRows = new Set();
        for (const selected of selectedRows) {
            const userId = Number(selected?.userId);
            const rowListType = String(selected?.listType || "");
            const movieId = String(selected?.movieId || "");
            if (!Number.isSafeInteger(userId) || userId <= 0 ||
                !["watched", "want", "wont"].includes(rowListType) ||
                !movieId || movieId.length > 200) {
                return jsonErr("CSV seçimi geçersiz.", 400);
            }
            const key = `${userId}|${rowListType}|${movieId}`;
            if (seenRows.has(key)) continue;
            seenRows.add(key);

            const row = await env.DB.prepare(`
                SELECT user_id, list_type, movie_id, tmdb_id, imdb_id,
                       title_original, title_tr, year, directors
                FROM user_movies
                WHERE source='csv' AND user_id=? AND list_type=? AND movie_id=?
            `).bind(userId, rowListType, movieId).first();
            if (!row) continue;

            if (taskType === "remove_csv_cards") {
                itemPayloads.push({
                    key,
                    payload: { userId, listType: rowListType, movieId }
                });
            } else if (taskType === "delete_csv_cards" && row.tmdb_id) {
                const id = String(row.tmdb_id);
                itemPayloads.push({ key: `tmdb:${id}`, payload: { movieId: id } });
            } else if (taskType === "refresh_csv_cards" && row.tmdb_id) {
                const id = String(row.tmdb_id);
                itemPayloads.push({ key: `tmdb:${id}`, payload: { movieId: id } });
            } else if (taskType === "create_csv_cards" && !row.tmdb_id && row.imdb_id) {
                itemPayloads.push({
                    key,
                    payload: {
                        userId,
                        listType: rowListType,
                        movieId,
                        imdbId: String(row.imdb_id).replace(/^tt/i, ""),
                        title_original: row.title_original,
                        title_tr: row.title_tr,
                        year: row.year,
                        directors: row.directors
                    }
                });
            }
        }
    } else if (taskType === "refresh_cards" || taskType === "create_cards") {
        const rawTargetCount = body.targetCount ?? body.limit ?? 250;
        const targetCount = String(rawTargetCount).toLowerCase() === "all"
            ? "all"
            : Number(rawTargetCount);
        if (targetCount !== "all" && ![250, 2000].includes(targetCount)) {
            return jsonErr("targetCount yalnızca 250, 2000 veya 'all' olabilir.", 400);
        }

        let rows;
        if (taskType === "refresh_cards" && body.movieIds != null) {
            if (!Array.isArray(body.movieIds)) {
                return jsonErr("Seçili kart listesi dizi olmalı.", 400);
            }
            const selectedIds = [...new Set(body.movieIds.map(String))];
            if (!selectedIds.length || selectedIds.length > 1000 ||
                selectedIds.some(id => !id.trim() || id.length > 200)) {
                return jsonErr("Seçili kart listesi 1–1.000 geçerli ID içermeli.", 400);
            }
            const placeholders = selectedIds.map(() => "?").join(",");
            const result = await env.DB.prepare(
                `SELECT movie_id FROM movie_profiles WHERE movie_id IN (${placeholders})`
            ).bind(...selectedIds).all();
            rows = result.results || [];
        } else if (taskType === "refresh_cards") {
            const query = targetCount === "all"
                ? "SELECT movie_id FROM movie_profiles ORDER BY updated_at DESC"
                : "SELECT movie_id FROM movie_profiles ORDER BY updated_at DESC LIMIT ?";
            const result = targetCount === "all"
                ? await env.DB.prepare(query).all()
                : await env.DB.prepare(query).bind(targetCount).all();
            rows = result.results || [];
        } else {
            const query = `
                SELECT CAST(g.tmdb_id AS TEXT) AS movie_id
                FROM global_movies g
                WHERE g.tmdb_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM movie_profiles p
                    WHERE CAST(p.movie_id AS TEXT) = CAST(g.tmdb_id AS TEXT)
                  )
                ORDER BY g.updated_at DESC
                ${targetCount === "all" ? "" : "LIMIT ?"}
            `;
            const result = targetCount === "all"
                ? await env.DB.prepare(query).all()
                : await env.DB.prepare(query).bind(targetCount).all();
            rows = result.results || [];
        }
        itemPayloads = rows.map(row => ({
            key: String(row.movie_id),
            payload: { movieId: String(row.movie_id) }
        }));
        taskTarget = JSON.stringify({ targetCount });
    }

    itemPayloads = [...new Map(itemPayloads.map(entry => [entry.key, entry])).values()];
    const taskTotal = itemPayloads.length;
    const taskId = "task_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    await env.DB.prepare(`
        INSERT INTO admin_tasks (
            id, admin_user_id, task_type, target, list_type,
            status, total, done, failed, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).bind(
        taskId,
        sess.user_id,
        taskType,
        taskTarget,
        listType || null,
        taskTotal ? "pending" : "completed",
        taskTotal,
        timestamp,
        timestamp
    ).run();
    if (taskTotal === 0) {
        await env.DB.prepare("UPDATE admin_tasks SET finished_at=? WHERE id=?").bind(timestamp, taskId).run();
    }

    let insertedItems = 0;
    try {
        for (let offset = 0; offset < itemPayloads.length; offset += 50) {
            const chunk = itemPayloads.slice(offset, offset + 50);
            await env.DB.batch(chunk.map((entry, index) => env.DB.prepare(`
                INSERT INTO admin_task_items (
                    id, task_id, item_key, payload_json, status, attempts,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
            `).bind(
                `${taskId}:${offset + index}`,
                taskId,
                entry.key,
                JSON.stringify(entry.payload),
                timestamp,
                timestamp
            )));
            insertedItems += chunk.length;
        }
    } catch (error) {
        await env.DB.prepare(`
            UPDATE admin_tasks
            SET status='failed', total=?, error_log=?, finished_at=?, updated_at=?
            WHERE id=?
        `).bind(
            insertedItems,
            String(error?.message || error).slice(0, 1000),
            timestamp,
            timestamp,
            taskId
        ).run();
        return jsonErr("Görev kuyruğu hazırlanamadı; kısmi kayıt güvenli biçimde başarısız olarak işaretlendi.", 500);
    }

    return jsonRes({ ok: true, taskId, total: taskTotal, status: taskTotal ? "pending" : "completed" });
}

if (path.startsWith("/bulk/task/") && request.method === "GET") {
    const taskId = decodeURIComponent(
        path.replace("/bulk/task/", "")
    );

    const row = await env.DB.prepare(`
        SELECT * FROM admin_tasks
        WHERE id = ? AND admin_user_id = ?
    `).bind(taskId, sess.user_id).first();

    if (!row) {
        return jsonErr("Görev bulunamadı", 404);
    }
    if (!(await hasExactPermission(env, sess, permissionForTask(row)))) {
        return jsonErr("Bu görevi görüntüleme yetkiniz yok", 403);
    }

    const { results: itemStats } = await env.DB.prepare(`
        SELECT status, COUNT(*) AS count
        FROM admin_task_items WHERE task_id = ?
        GROUP BY status
    `).bind(taskId).all();
    return jsonRes({ ok: true, task: row, itemStats: itemStats || [] });
}

if (path === "/bulk/tasks" && request.method === "GET") {
    if (!(await hasAnyBulkPermission(env, sess))) {
        return jsonErr("Toplu görevleri görüntüleme yetkiniz yok", 403);
    }
    const { results } = await env.DB.prepare(`
        SELECT * FROM admin_tasks
        WHERE admin_user_id = ?
        ORDER BY created_at DESC
        LIMIT 50
    `).bind(sess.user_id).all();

    return jsonRes({
        ok: true,
        tasks: results || []
    });
}

if (path === "/bulk/task/cancel" && request.method === "POST") {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonErr("Geçersiz JSON", 400);
    }

    const taskId = String(body.taskId || "").trim();

    if (!taskId) {
        return jsonErr("taskId gerekli", 400);
    }

    const cancelTask = await env.DB.prepare(
        "SELECT task_type, target FROM admin_tasks WHERE id = ? AND admin_user_id = ?"
    ).bind(taskId, sess.user_id).first();
    if (!cancelTask) return jsonErr("Görev bulunamadı", 404);
    if (!(await hasExactPermission(env, sess, permissionForTask(cancelTask)))) {
        return jsonErr("Bu görevi iptal etme yetkiniz yok", 403);
    }

    await env.DB.prepare(`
        UPDATE admin_tasks
        SET status = 'cancelled', updated_at = ?
        WHERE id = ?
          AND admin_user_id = ?
          AND status IN ('pending', 'running')
    `).bind(
        Math.floor(Date.now() / 1000),
        taskId,
        sess.user_id
    ).run();
    await env.DB.prepare(`
        UPDATE admin_task_items
        SET status='cancelled', lease_until=NULL, updated_at=?
        WHERE task_id=? AND status='pending'
    `).bind(Math.floor(Date.now() / 1000), taskId).run();

    return jsonRes({ ok: true });
}

if (path === "/bulk/run" && request.method === "POST") {
    let body;
    try { body = await request.json(); }
    catch { return jsonErr("Geçersiz JSON", 400); }

    const taskId = String(body.taskId || "").trim();
    if (!taskId) return jsonErr("taskId gerekli", 400);

    const task = await env.DB.prepare(`
        SELECT * FROM admin_tasks WHERE id=? AND admin_user_id=?
    `).bind(taskId, sess.user_id).first();

    if (!task) return jsonErr("Görev bulunamadı", 404);
    if (!(await hasExactPermission(env, sess, permissionForTask(task)))) {
        return jsonErr("Bu görevi çalıştırma yetkiniz yok", 403);
    }
    if (!["pending", "running"].includes(task.status)) {
        return jsonErr("Görev başlatılamaz; durum: " + task.status, 409);
    }

    await env.DB.prepare(`
        UPDATE admin_tasks SET status='running', updated_at=?
        WHERE id=? AND status IN ('pending','running')
    `).bind(now(), taskId).run();

    return jsonRes({
        ok: true,
        taskId,
        message: "Görev kalıcı kuyruğa alındı. Worker zamanlayıcısı öğeleri sürdürecek."
    });
}

if (path === "/bulk/step" && request.method === "POST") {
    let body;
    try { body = await request.json(); }
    catch { return jsonErr("Geçersiz JSON", 400); }
    const taskId = String(body.taskId || "").trim();
    if (!taskId) return jsonErr("taskId gerekli", 400);
    const task = await env.DB.prepare(
        "SELECT * FROM admin_tasks WHERE id=? AND admin_user_id=?"
    ).bind(taskId, sess.user_id).first();
    if (!task) return jsonErr("Görev bulunamadı", 404);
    if (!(await hasExactPermission(env, sess, permissionForTask(task)))) {
        return jsonErr("Bu görevi sürdürme yetkiniz yok", 403);
    }
    if (task.status !== "running") {
        return jsonRes({ ok: true, processed: 0, task });
    }
    const result = await processAdminTaskQueue(env, 1, taskId);
    const updated = await env.DB.prepare(
        "SELECT * FROM admin_tasks WHERE id=?"
    ).bind(taskId).first();
    return jsonRes({ ok: true, ...result, task: updated });
}

if (path === "/bulk/task/resume" && request.method === "POST") {
    let body;
    try { body = await request.json(); }
    catch { return jsonErr("Geçersiz JSON", 400); }
    const taskId = String(body.taskId || "").trim();
    if (!taskId) return jsonErr("taskId gerekli", 400);

    const task = await env.DB.prepare(
        "SELECT * FROM admin_tasks WHERE id=? AND admin_user_id=?"
    ).bind(taskId, sess.user_id).first();
    if (!task) return jsonErr("Görev bulunamadı", 404);
    if (!(await hasExactPermission(env, sess, permissionForTask(task)))) {
        return jsonErr("Bu görevi sürdürme yetkiniz yok", 403);
    }
    if (!["failed", "running", "pending"].includes(task.status)) {
        return jsonErr("Bu görev sürdürülemez: " + task.status, 409);
    }

    await env.DB.prepare(`
        UPDATE admin_task_items
        SET status='pending', attempts=0, lease_until=NULL,
            last_error=NULL, finished_at=NULL, updated_at=?
        WHERE task_id=? AND status='failed'
    `).bind(now(), taskId).run();
    await env.DB.prepare(`
        UPDATE admin_tasks SET status='running', finished_at=NULL, updated_at=?
        WHERE id=? AND status IN ('failed','running','pending')
    `).bind(now(), taskId).run();

    return jsonRes({ ok: true, taskId, status: "running" });
}

// ============================================================
// TURSO TOPLU GÖREVLERİ SONU
// ============================================================


if (path === "/hf-import/file/start" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); }
      const fileHash = String(body.fileHash || "").toLowerCase();
      const totalRows = Number(body.totalRows);
      const fileBytes = Number(body.fileSize || 0);
      if (!Number.isSafeInteger(fileBytes) || fileBytes < 0) return jsonErr("Dosya boyutu geçersiz", 400);
      if (!/^[a-f0-9]{64}$/.test(fileHash)) return jsonErr("Dosya parmak izi geçersiz", 400);
      if (!Number.isSafeInteger(totalRows) || totalRows < 1 || totalRows > 500000) return jsonErr("CSV satır sayısı geçersiz (1–500.000)", 400);
      const dataset = String(body.fileName || "admin-upload.csv").slice(0, 255);
      const nowTs = now();
      const id = `acsv_${sess.user_id}_${fileHash.slice(0, 20)}`;
      await env.DB.prepare(`INSERT OR IGNORE INTO csv_import_sessions
        (id, owner_type, owner_id, list_type, file_hash, file_name, source_dataset, source_revision, total_rows, next_row, chunk_size, status, created_at, updated_at)
        VALUES (?, 'admin', ?, '', ?, ?, ?, ?, ?, 0, 100, 'pending', ?, ?)`)
        .bind(id, sess.user_id, fileHash, dataset, dataset, String(body.sourceRevision || "").slice(0, 120) || null, totalRows, nowTs, nowTs).run();
      let session = await env.DB.prepare("SELECT * FROM csv_import_sessions WHERE owner_type='admin' AND owner_id=? AND list_type='' AND file_hash=?")
        .bind(sess.user_id, fileHash).first();
      if (!session) return jsonErr("Aktarım kaydı oluşturulamadı", 500);
      if (Number(session.total_rows) !== totalRows) return jsonErr("Aynı dosya parmak izi farklı satır sayısıyla geldi", 409);
      if (fileBytes && Number(session.file_bytes || 0) === 0) {
        await env.DB.prepare("UPDATE csv_import_sessions SET file_bytes=? WHERE id=? AND file_bytes=0").bind(fileBytes, session.id).run();
        session.file_bytes = fileBytes;
      } else if (fileBytes && Number(session.file_bytes) !== fileBytes) {
        return jsonErr("Aynı dosya parmak izi farklı boyutla geldi", 409);
      }
      if (["cancelled", "failed"].includes(session.status)) return jsonErr("Bu aktarım iptal edilmiş veya hata almış", 409);
      if (session.status !== "completed") {
        await env.DB.prepare("UPDATE csv_import_sessions SET status='running', updated_at=? WHERE id=? AND status IN ('pending','stopped','running')")
          .bind(nowTs, session.id).run();
        session = await env.DB.prepare("SELECT * FROM csv_import_sessions WHERE id=?").bind(session.id).first();
      }
      return jsonRes({ ok: true, session, nextRow: session.next_row, status: session.status });
    }
    if (path === "/hf-import/file/chunk" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); }
      const sessionId = String(body.sessionId || "");
      const chunkIndex = Number(body.chunkIndex), startRow = Number(body.startRow);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!sessionId || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !Number.isSafeInteger(startRow) || startRow < 0 || !rows.length || rows.length > 100) return jsonErr("CSV parçası geçersiz (en fazla 100 satır)", 400);
      const session = await env.DB.prepare("SELECT * FROM csv_import_sessions WHERE id=? AND owner_type='admin' AND owner_id=?")
        .bind(sessionId, sess.user_id).first();
      if (!session) return jsonErr("Aktarım kaydı bulunamadı", 404);
      const prior = await env.DB.prepare("SELECT result_json FROM csv_import_session_chunks WHERE session_id=? AND chunk_index=?")
        .bind(sessionId, chunkIndex).first();
      if (prior) return jsonRes({ ok: true, ...safeJSON(prior.result_json, {}), duplicate: true, session: await env.DB.prepare("SELECT * FROM csv_import_sessions WHERE id=?").bind(sessionId).first() });
      if (session.status !== "running") return jsonErr(`Aktarım durumu ${session.status}; önce devam ettirin.`, 409);
      if (startRow !== Number(session.next_row)) return jsonErr(`Sıra uyuşmazlığı: beklenen ${session.next_row}, gelen ${startRow}`, 409);
      if (startRow + rows.length > Number(session.total_rows)) return jsonErr("Parça toplam satır sayısını aşıyor", 400);
      const nowTs = now(), endRow = startRow + rows.length;
      const result = await _upsertGlobalRows(env, rows, session.source_dataset || session.file_name || "admin-upload.csv", session.source_revision, counts => [
        env.DB.prepare(`INSERT INTO csv_import_session_chunks (session_id, chunk_index, start_row, end_row, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(sessionId, chunkIndex, startRow, endRow, JSON.stringify(counts), nowTs),
        env.DB.prepare(`UPDATE csv_import_sessions SET next_row=?, inserted_rows=inserted_rows+?, status=?, updated_at=?, finished_at=? WHERE id=? AND status='running'`)
          .bind(endRow, counts.inserted, endRow >= Number(session.total_rows) ? "completed" : "running", nowTs, endRow >= Number(session.total_rows) ? nowTs : null, sessionId)
      ]);
      const updated = await env.DB.prepare("SELECT * FROM csv_import_sessions WHERE id=?").bind(sessionId).first();
      return jsonRes({ ok: true, ...result, nextRow: updated.next_row, totalRows: updated.total_rows, status: updated.status, session: updated });
    }
    if (path === "/hf-import/file/stop" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); }
      const id = String(body.sessionId || "");
      const r = await env.DB.prepare("UPDATE csv_import_sessions SET status='stopped', updated_at=? WHERE id=? AND owner_type='admin' AND owner_id=? AND status='running'")
        .bind(now(), id, sess.user_id).run();
      if (!r.meta?.changes) return jsonErr("Çalışan aktarım bulunamadı", 409);
      return jsonRes({ ok: true, status: "stopped" });
    }
    if (path === "/hf-import/file/cancel" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); }
      const id = String(body.sessionId || "");
      await env.DB.prepare("UPDATE csv_import_sessions SET status='cancelled', updated_at=?, finished_at=? WHERE id=? AND owner_type='admin' AND owner_id=? AND status IN ('pending','stopped','running')")
        .bind(now(), now(), id, sess.user_id).run();
      return jsonRes({ ok: true, status: "cancelled" });
    }
    if (path === "/hf-import/file/status" && request.method === "GET") {
      const id = String(url.searchParams.get("id") || "");
      if (!id) return jsonErr("id gerekli", 400);
      const session = await env.DB.prepare("SELECT * FROM csv_import_sessions WHERE id=? AND owner_type='admin' AND owner_id=?").bind(id, sess.user_id).first();
      if (!session) return jsonErr("Aktarım bulunamadı", 404);
      return jsonRes({ ok: true, session });
    }

    if (path === "/hf-import/start" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); }
      const sourceDataset = String(body.sourceDataset || "").trim();
      if (!sourceDataset) return jsonErr("sourceDataset gerekli", 400);
      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const nowTs = now();
      await env.DB.prepare(
        `INSERT INTO import_jobs (id, admin_user_id, source_dataset, source_revision, source_total_rows, source_total_chunks, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).bind(
        jobId, sess.user_id, sourceDataset, String(body.sourceRevision || "").trim() || null,
        Number.isFinite(parseInt(body.totalRows)) ? parseInt(body.totalRows) : null,
        Number.isFinite(parseInt(body.totalChunks)) ? parseInt(body.totalChunks) : null,
        nowTs, nowTs
      ).run();
      return jsonRes({ ok: true, jobId });
    }
    if (path === "/hf-import/chunk" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return jsonErr("Geçersiz JSON", 400); }
      const jobId = String(body.jobId || "").trim();
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!jobId) return jsonErr("jobId gerekli", 400);
      if (!rows.length) return jsonErr("rows boş", 400);
      if (rows.length > 250) return jsonErr("Tek chunk en fazla 250 satır olabilir", 400);
      const job = await env.DB.prepare("SELECT * FROM import_jobs WHERE id = ?").bind(jobId).first();
      if (!job) return jsonErr("Import job bulunamadı", 404);
      if (job.status === "completed" || job.status === "cancelled") return jsonErr("Bu job artık kapalı", 409);
      const res = await _upsertGlobalRows(env, rows, job.source_dataset, job.source_revision);
      const newCompleted = (job.completed_chunks || 0) + 1;
      const status = job.source_total_chunks && newCompleted >= job.source_total_chunks ? "completed" : "running";
      const finishedAt = status === "completed" ? now() : null;
      await env.DB.prepare(
        `UPDATE import_jobs SET completed_chunks = ?, inserted_rows = inserted_rows + ?, status = ?, updated_at = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`
      ).bind(newCompleted, res.inserted, status, now(), finishedAt, jobId).run();
      return jsonRes({ ok: true, jobId, completedChunks: newCompleted, insertedRows: res.inserted, status });
    }
    if (path === "/hf-import/status" && request.method === "GET") {
      const jobId = String(url.searchParams.get("id") || "").trim();
      if (!jobId && url.searchParams.get("list") === "1") {
        const { results } = await env.DB.prepare("SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT 20").all();
        return jsonRes({ ok: true, jobs: results || [] });
      }
      if (!jobId) return jsonErr("id veya list=1 gerekli", 400);
      const job = await env.DB.prepare("SELECT * FROM import_jobs WHERE id = ?").bind(jobId).first();
      if (!job) return jsonErr("Import job bulunamadı", 404);
      return jsonRes({ ok: true, job });
    }

    return jsonErr("Admin route bulunamadı", 404);
  } catch (e) { return jsonErr(e.message, e.status || 500); }
        } 

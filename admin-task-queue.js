// Durable, at-least-once admin task queue backed by Turso.
import { handleMovieDetails } from "./research.js";
import { bulkRemoveListRows } from "./users.js";

const now = () => Math.floor(Date.now() / 1000);

async function taskPermissionStillValid(env, task) {
  const permissionByType = {
    refresh_cards: "db_cards_bulk_refresh",
    create_cards: "db_cards_bulk_open",
    delete_cards: "db_cards_bulk_delete",
    create_csv_cards: "csv_cards_bulk_open",
    refresh_csv_cards: "csv_cards_bulk_refresh",
    remove_csv_cards: "csv_cards_bulk_remove",
    delete_csv_cards: "csv_cards_bulk_delete",
    remove_external_import: "external_import_bulk_remove",
    delete_external_import: "external_import_bulk_delete",
    delete_list: null
  };
  let permission = permissionByType[task.task_type] || null;
  if (task.task_type === "delete_list") {
    let target = {};
    try { target = JSON.parse(task.target || "{}"); } catch {}
    permission = Array.isArray(target.movieIds) ? "lists_bulk_remove" : "lists_bulk_clear";
  }
  if (!permission) return false;
  const user = await env.DB.prepare(
    "SELECT is_admin FROM users WHERE id = ?"
  ).bind(task.admin_user_id).first();
  if (Number(user?.is_admin || 0) === 1) return true;
  const row = await env.DB.prepare(
    "SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ? LIMIT 1"
  ).bind(task.admin_user_id, permission).first();
  return !!row;
}

async function refreshTaskSummary(env, taskId) {
  const ts = now();
  await env.DB.prepare(`
    UPDATE admin_tasks
    SET done = (SELECT COUNT(*) FROM admin_task_items WHERE task_id = ? AND status = 'completed'),
        failed = (SELECT COUNT(*) FROM admin_task_items WHERE task_id = ? AND status = 'failed'),
        status = CASE
          WHEN status = 'cancelled' THEN 'cancelled'
          WHEN EXISTS (SELECT 1 FROM admin_task_items WHERE task_id = ? AND status = 'failed') THEN 'failed'
          WHEN EXISTS (SELECT 1 FROM admin_task_items WHERE task_id = ? AND status IN ('pending','running')) THEN 'running'
          ELSE 'completed'
        END,
        updated_at = ?,
        finished_at = CASE
          WHEN NOT EXISTS (SELECT 1 FROM admin_task_items WHERE task_id = ? AND status IN ('pending','running'))
          THEN COALESCE(finished_at, ?)
          ELSE NULL
        END
    WHERE id = ?
  `).bind(taskId, taskId, taskId, taskId, ts, taskId, ts, taskId).run();
}

async function processOne(env, onlyTaskId = null) {
  const ts = now();
  // Atomic claim: one invocation owns one item. Expired leases are reclaimed.
  const item = await env.DB.prepare(`
    UPDATE admin_task_items
    SET status = 'running',
        attempts = attempts + 1,
        lease_until = ?,
        started_at = COALESCE(started_at, ?),
        updated_at = ?
    WHERE id = (
      SELECT i.id
      FROM admin_task_items i
      JOIN admin_tasks t ON t.id = i.task_id
      WHERE t.status = 'running'
        AND (? IS NULL OR t.id = ?)
        AND (i.status = 'pending' OR (i.status = 'running' AND i.lease_until < ?))
        AND (
          COALESCE(json_extract(i.payload_json, '$.finalize'), 0) != 1
          OR NOT EXISTS (
            SELECT 1
            FROM admin_task_items prior
            WHERE prior.task_id = i.task_id
              AND prior.item_key != i.item_key
              AND prior.status != 'completed'
          )
        )
      ORDER BY t.created_at ASC, i.id ASC
      LIMIT 1
    )
    RETURNING *
  `).bind(ts + 600, ts, ts, onlyTaskId, onlyTaskId, ts).first();

  if (!item) return false;

  const task = await env.DB.prepare(
    "SELECT * FROM admin_tasks WHERE id = ?"
  ).bind(item.task_id).first();

  if (!task || task.status === "cancelled") {
    await env.DB.prepare(
      "UPDATE admin_task_items SET status='cancelled', lease_until=NULL, updated_at=? WHERE id=?"
    ).bind(now(), item.id).run();
    if (task) await refreshTaskSummary(env, task.id);
    return true;
  }

  try {
    if (!(await taskPermissionStillValid(env, task))) {
      throw new Error("Görev sahibinin ilgili işlem yetkisi kaldırılmış.");
    }

    const payload = JSON.parse(item.payload_json || "{}");
    const movieId = String(payload.movieId || "");

    if (task.task_type === "delete_cards" || task.task_type === "delete_csv_cards") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM movie_profile_fields WHERE movie_id = ?").bind(movieId),
        env.DB.prepare("DELETE FROM movie_profiles WHERE movie_id = ?").bind(movieId),
        env.DB.prepare("UPDATE user_movies SET tmdb_id = NULL, updated_at = ? WHERE tmdb_id = ?")
          .bind(now(), Number(movieId) || movieId)
      ]);
    } else if (task.task_type === "delete_list" || task.task_type === "remove_csv_cards") {
      if (payload.clearAll === true) {
        const { results: currentRows } = await env.DB.prepare(`
          SELECT movie_id FROM user_movies WHERE user_id=? AND list_type=?
        `).bind(Number(payload.userId), String(payload.listType)).all();
        if (Number(payload.expectedCount) !== (currentRows || []).length) {
          throw new Error("Liste görev kuyruğuna alındıktan sonra değişmiş; güvenlik için sıfırlama durduruldu.");
        }
      }
      await bulkRemoveListRows(
        env,
        Number(payload.userId),
        String(payload.listType),
        payload.clearAll === true ? null : [movieId]
      );
    } else if (task.task_type === "create_csv_cards") {
      const { refreshCardForImdb } = await import("./users.js");
      const result = await refreshCardForImdb(env, payload.imdbId, null, payload);
      await env.DB.prepare(`
        UPDATE user_movies SET tmdb_id=?, updated_at=?
        WHERE user_id=? AND list_type=? AND movie_id=? AND source='csv'
      `).bind(result.tmdbId, now(), payload.userId, payload.listType, payload.movieId).run();
    } else if (
      task.task_type === "refresh_cards" ||
      task.task_type === "create_cards" ||
      task.task_type === "refresh_csv_cards"
    ) {
      if (!movieId) throw new Error("Görev öğesinde movieId bulunamadı.");
      await handleMovieDetails(
        env,
        { movie: { id: Number(movieId) || movieId }, forceAll: true },
        null
      );
    } else if (task.task_type === "remove_external_import" || task.task_type === "delete_external_import") {
      if (payload.finalize) {
        await env.DB.prepare(
          "DELETE FROM import_jobs WHERE source_dataset = ?"
        ).bind(payload.sourceDataset).run();
      } else {
        await env.DB.prepare(
          "DELETE FROM global_movies WHERE movie_id = ? AND source_dataset = ?"
        ).bind(movieId, payload.sourceDataset).run();
      }
    } else {
      throw new Error(`Desteklenmeyen görev türü: ${task.task_type}`);
    }

    await env.DB.prepare(`
      UPDATE admin_task_items
      SET status='completed', lease_until=NULL, last_error=NULL,
          finished_at=?, updated_at=?
      WHERE id=? AND status='running'
    `).bind(now(), now(), item.id).run();
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    const terminal = Number(item.attempts || 0) >= 3 || error?.code === "ambiguous";
    await env.DB.prepare(`
      UPDATE admin_task_items
      SET status=?, lease_until=NULL, last_error=?, updated_at=?,
          finished_at=CASE WHEN ? = 1 THEN ? ELSE NULL END
      WHERE id=? AND status='running'
    `).bind(
      terminal ? "failed" : "pending",
      message,
      now(),
      terminal ? 1 : 0,
      now(),
      item.id
    ).run();
    console.error("[admin-task-item]", task.id, item.item_key, message);
  }

  await refreshTaskSummary(env, task.id);
  return true;
}

export async function processAdminTaskQueue(env, maxItems = 1, onlyTaskId = null) {
  if (!env?.DB) throw new Error("Turso DB bağlantısı gerekli.");
  const limit = Math.max(1, Math.min(5, Number(maxItems) || 1));
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const didWork = await processOne(env, onlyTaskId);
    if (!didWork) break;
    processed++;
  }
  return { processed };
}

import { createServer } from "node:http";
import { once } from "node:events";
import worker from "./index.js";

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY_BYTES = Number(process.env.MAX_HTTP_BODY_BYTES || 20 * 1024 * 1024);
const pendingTasks = new Set();

// Cloud Run bu servisi yalnızca test ortamı olarak çalıştırır.
// Canlı Turso değişkenleri bulunsa bile DB adaptörü index.js içinde
// TEST_TURSO_DATABASE_URL / TEST_TURSO_AUTH_TOKEN ile oluşturulur.
const env = { ...process.env, IS_TEST_ENV: "true" };

function track(promise) {
  const task = Promise.resolve(promise);
  pendingTasks.add(task);
  task.catch((error) => console.error("[background-task]", error?.stack || error))
    .finally(() => pendingTasks.delete(task));
}

const ctx = { waitUntil: track };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`İstek gövdesi ${MAX_BODY_BYTES} bayt sınırını aşıyor.`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return size ? Buffer.concat(chunks) : undefined;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function writeWebResponse(nodeRes, webRes) {
  const headers = {};
  webRes.headers.forEach((value, key) => { headers[key] = value; });
  nodeRes.writeHead(webRes.status, headers);
  if (!webRes.body) return nodeRes.end();

  const reader = webRes.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!nodeRes.write(Buffer.from(value))) await once(nodeRes, "drain");
    }
    nodeRes.end();
  } catch (error) {
    console.error("[response-stream]", error?.stack || error);
    nodeRes.destroy(error);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url || "/", `http://${host}`);

    // Cloud Scheduler için korumalı, test-only dakikalık görev endpoint'i.
    if (url.pathname === "/internal/run-admin-tasks") {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST gerekli." });
      const expected = String(process.env.CRON_SECRET || "");
      const auth = String(req.headers.authorization || "");
      if (!expected || auth !== `Bearer ${expected}`) {
        return sendJson(res, 401, { ok: false, error: "Yetkisiz." });
      }
      try {
        await worker.scheduled({}, env, ctx);
        return sendJson(res, 200, { ok: true, environment: "test" });
      } catch (error) {
        console.error("[scheduled-task]", error?.stack || error);
        return sendJson(res, 500, { ok: false, error: "Zamanlanmış görev başarısız." });
      }
    }

    const body = await readBody(req);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      ...(body && !["GET", "HEAD"].includes(req.method)
        ? { body, duplex: "half" }
        : {})
    });
    const response = await worker.fetch(request, env, ctx);
    await writeWebResponse(res, response);
  } catch (error) {
    console.error("[http-server]", error?.stack || error);
    if (!res.headersSent) sendJson(res, error.status || 500, {
      ok: false,
      error: error.status === 413 ? error.message : "Sunucu isteği işleyemedi."
    });
    else res.destroy(error);
  }
});

server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[startup] Cloud Run test API listening on ${PORT}`);
  console.log(`[startup] IS_TEST_ENV=true; test Turso credentials required`);
});

async function shutdown(signal) {
  console.log(`[shutdown] ${signal}; draining HTTP and ${pendingTasks.size} background task(s)`);
  server.close();
  const deadline = Date.now() + 25_000;
  while (pendingTasks.size && Date.now() < deadline) {
    await Promise.race([
      Promise.allSettled([...pendingTasks]),
      new Promise(resolve => setTimeout(resolve, 250))
    ]);
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

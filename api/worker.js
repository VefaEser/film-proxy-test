import sharp from "sharp";
import { waitUntil } from "@vercel/functions";
import worker from "../index.js";
import { createHash } from "node:crypto";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const THUMB_MAX_BYTES = 20 * 1024;
const thumbCache = new Map();
const ALLOWED_ORIGINS = new Set([
  "https://vefaeser-kestiktest.static.hf.space"
]);

function allowedImageHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "image.tmdb.org" || h === "upload.wikimedia.org" || h.endsWith(".wikimedia.org") ||
    h === "m.media-amazon.com" || h.endsWith(".media-amazon.com") ||
    h === "images-na.ssl-images-amazon.com" || h === "crawlora.net" ||
    h.endsWith(".crawlora.net") || h.endsWith(".imdb.com");
}

function corsFor(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return {};
  if (!ALLOWED_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Type, X-Image-Bytes, X-Image-Max-Bytes, X-Image-Verified",
    "Vary": "Origin"
  };
}

function sendJson(res, status, payload, extra = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...extra
  });
  res.end(body);
}

async function serveThumbnail(req, res, url) {
  const cors = corsFor(req);
  if (cors === null) {
    return sendJson(res, 403, { ok: false, error: "Bu kaynaktan küçük görsel isteğine izin verilmiyor." });
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...cors, "Access-Control-Max-Age": "600" });
    return res.end();
  }
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "GET gerekli." }, cors);
  }

  let source;
  try {
    source = new URL(url.searchParams.get("src") || "");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Geçersiz görsel adresi." }, cors);
  }

  if (source.protocol !== "https:" || !allowedImageHost(source.hostname)) {
    return sendJson(res, 403, { ok: false, error: "Görsel kaynağı izinli değil." }, cors);
  }

  const cacheKey = createHash("sha256").update(source.href).digest("hex");
  const cached = thumbCache.get(cacheKey);
  if (cached) {
    res.writeHead(200, {
      "Content-Type": "image/webp",
      "Content-Length": cached.length,
      "Cache-Control": "public, max-age=86400",
      "X-Image-Bytes": String(cached.length),
      "X-Image-Max-Bytes": String(THUMB_MAX_BYTES),
      "X-Image-Verified": "1",
      ...cors
    });
    return res.end(cached);
  }

  let upstream;
  try {
    upstream = await fetch(source, {
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "FilmKesifMotoru/1.0" }
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get("location");
      let redirected;
      try { redirected = new URL(loc, source); } catch {}
      if (!redirected || redirected.protocol !== "https:" || !allowedImageHost(redirected.hostname)) {
        return sendJson(res, 502, { ok: false, error: "Görsel kaynağı güvenli olmayan yönlendirme yaptı." }, cors);
      }
      upstream = await fetch(redirected, {
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
        headers: { "User-Agent": "FilmKesifMotoru/1.0" }
      });
    }
  } catch {
    return sendJson(res, 502, { ok: false, error: "Görsel kaynağına erişilemedi." }, cors);
  }

  if (!upstream.ok) {
    return sendJson(res, 502, { ok: false, error: `Görsel kaynağı HTTP ${upstream.status}.` }, cors);
  }
  if (!(upstream.headers.get("content-type") || "").toLowerCase().startsWith("image/")) {
    return sendJson(res, 415, { ok: false, error: "Kaynak bir görsel döndürmedi." }, cors);
  }

  const raw = Buffer.from(await upstream.arrayBuffer());
  if (!raw.length || raw.length > 12 * 1024 * 1024) {
    return sendJson(res, 413, { ok: false, error: "Kaynak görsel boyutu sınırı aşıyor." }, cors);
  }

  let output = null;
  try {
    for (const width of [480, 400, 320, 260, 220, 180, 140, 100]) {
      for (const quality of [66, 56, 46, 36, 28, 22, 18]) {
        const candidate = await sharp(raw, { limitInputPixels: 40000000 })
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .webp({ quality, effort: 4 })
          .toBuffer();
        if (candidate.length <= THUMB_MAX_BYTES) {
          output = candidate;
          break;
        }
      }
      if (output) break;
    }
  } catch {
    return sendJson(res, 422, { ok: false, error: "Görsel dönüştürülemedi." }, cors);
  }

  if (!output) {
    return sendJson(res, 422, {
      ok: false,
      error: "Görsel 20 KB sınırına indirilemedi; orijinal görsel sunulmadı."
    }, cors);
  }

  if (thumbCache.size >= 1000) thumbCache.delete(thumbCache.keys().next().value);
  thumbCache.set(cacheKey, output);

  res.writeHead(200, {
    "Content-Type": "image/webp",
    "Content-Length": output.length,
    "Cache-Control": "public, max-age=86400",
    "X-Image-Bytes": String(output.length),
    "X-Image-Max-Bytes": String(THUMB_MAX_BYTES),
    "X-Image-Verified": "1",
    ...cors
  });
  res.end(output);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("İstek gövdesi 20 MB sınırını aşıyor.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return size ? Buffer.concat(chunks) : undefined;
}

export default async function handler(req, res) {
  try {
    const incoming = new URL(req.url || "/", `https://${req.headers.host || "vercel.local"}`);

    // Vercel rewrite, özgün yolu bu sabit Function'a query parametresiyle taşır.
    // İç parametre çıkarılır; diğer sorgu parametreleri aynen uygulamaya aktarılır.
    const forwardedPath = incoming.searchParams.get("__vercel_route_path");
    let pathname;

    if (forwardedPath !== null) {
      pathname = forwardedPath.startsWith("/") ? forwardedPath : `/${forwardedPath}`;
      incoming.searchParams.delete("__vercel_route_path");
      if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
    } else {
      // /api/worker doğrudan çağrılırsa eski davranış korunur.
      pathname = incoming.pathname.replace(/^\/api\/worker/, "") || "/";
      if (pathname === "/api") pathname = "/";
      else if (pathname.startsWith("/api/")) pathname = pathname.slice(4);
    }

    const target = new URL(pathname + incoming.search, "https://worker.internal");

    // Dağıtım sonrası Function yönlendirmesini DB/API'den bağımsız doğrula.
    if (pathname === "/__vercel-route-check" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        function: "api/worker.js",
        routePath: pathname,
        method: req.method,
        testEnvironment: true
      });
    }

    if (pathname === "/image/thumbnail") {
      return await serveThumbnail(req, res, incoming);
    }

    const body = await readBody(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers || {})) {
      if (Array.isArray(value)) headers.set(key, value.join(", "));
      else if (value !== undefined) headers.set(key, String(value));
    }
    headers.delete("host");

    const request = new Request(target, {
      method: req.method || "GET",
      headers,
      ...(body && !["GET", "HEAD"].includes(req.method) ? { body, duplex: "half" } : {})
    });

    const ctx = {
      waitUntil(promise) {
        waitUntil(Promise.resolve(promise));
      }
    };
    const env = { ...process.env, IS_TEST_ENV: "true" };

    console.info("[vercel-env-check]", {
      processUrlPresent: Boolean(process.env.TEST_TURSO_DATABASE_URL),
      processTokenPresent: Boolean(process.env.TEST_TURSO_AUTH_TOKEN),
      forwardedUrlPresent: Boolean(env.TEST_TURSO_DATABASE_URL),
      forwardedTokenPresent: Boolean(env.TEST_TURSO_AUTH_TOKEN)
    });

    const response = await worker.fetch(request, env, ctx);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (!response.body) return res.end();
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise(resolve => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (error) {
    console.error("[vercel-handler]", error?.stack || error);
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, {
        ok: false,
        error: error.statusCode === 413
          ? error.message
          : "Sunucu isteği işlerken hata oluştu."
      });
    } else {
      res.destroy(error);
    }
  }
                               }

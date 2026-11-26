import worker from "../index.js";
import sharp from "sharp";
import { waitUntil } from "@vercel/functions";

const MAX_THUMB_BYTES = 20 * 1024;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const thumbnailCache = new Map();
const ALLOWED_ORIGINS = new Set([
  "https://vefaeser-kestiktest.static.hf.space",
  ...String(process.env.THUMBNAIL_ALLOWED_ORIGINS || "")
    .split(",").map(value => value.trim()).filter(Boolean)
]);

function allowedImageHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "image.tmdb.org" || h === "upload.wikimedia.org" ||
    h.endsWith(".wikimedia.org") || h === "m.media-amazon.com" ||
    h.endsWith(".media-amazon.com") || h === "images-na.ssl-images-amazon.com" ||
    h === "crawlora.net" || h.endsWith(".crawlora.net") || h.endsWith(".imdb.com");
}

function thumbnailCors(request) {
  const origin = request.headers.get("origin") || "";
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

function jsonError(message, status, headers = {}) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}

async function handleThumbnail(request) {
  const cors = thumbnailCors(request);
  if (cors === null) return jsonError("Bu kaynaktan küçük görsel isteğine izin verilmiyor.", 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Max-Age": "600" } });
  if (request.method !== "GET") return jsonError("GET gerekli.", 405, cors);

  const source = new URL(request.url).searchParams.get("src") || "";
  let current;
  try { current = new URL(source); } catch { return jsonError("Geçersiz görsel adresi.", 400, cors); }
  if (current.protocol !== "https:" || !allowedImageHost(current.hostname)) {
    return jsonError("Görsel kaynağı izinli değil.", 403, cors);
  }

  const cached = thumbnailCache.get(source);
  if (cached) return new Response(cached, { status: 200, headers: {
    "Content-Type": "image/webp", "Content-Length": String(cached.length),
    "Cache-Control": "public, max-age=86400", "X-Image-Bytes": String(cached.length),
    "X-Image-Max-Bytes": String(MAX_THUMB_BYTES), "X-Image-Verified": "1", ...cors
  }});

  let upstream;
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      upstream = await fetch(current, { redirect: "manual", signal: request.signal,
        headers: { "User-Agent": "FilmKesifMotoru/1.0" } });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get("location");
      try { await upstream.body?.cancel(); } catch {}
      if (!location || redirects === 3) return jsonError("Görsel kaynağı çok fazla yönlendirme yaptı.", 502, cors);
      current = new URL(location, current);
      if (current.protocol !== "https:" || !allowedImageHost(current.hostname)) {
        return jsonError("Görsel kaynağı güvenli olmayan bir adrese yönlendirdi.", 502, cors);
      }
    }
    if (!upstream?.ok) return jsonError(`Görsel kaynağı HTTP ${upstream?.status || 502}.`, 502, cors);
    const type = (upstream.headers.get("content-type") || "").toLowerCase();
    if (!type.startsWith("image/")) return jsonError("Kaynak bir görsel döndürmedi.", 415, cors);
    const raw = Buffer.from(await upstream.arrayBuffer());
    if (!raw.length || raw.length > MAX_SOURCE_BYTES) return jsonError("Kaynak görsel boyutu sınırı aşıyor.", 413, cors);

    let output = null;
    for (const width of [480, 400, 320, 260, 220, 180]) {
      for (const quality of [66, 56, 46, 36, 28]) {
        const candidate = await sharp(raw, { limitInputPixels: 40000000 })
          .rotate().resize({ width, withoutEnlargement: true }).webp({ quality, effort: 4 }).toBuffer();
        if (candidate.length <= MAX_THUMB_BYTES) { output = candidate; break; }
      }
      if (output) break;
    }
    if (!output) return jsonError("Görsel 20 KB sınırına indirilemedi; orijinal görsel sunulmadı.", 422, cors);
    if (thumbnailCache.size >= 1000) thumbnailCache.delete(thumbnailCache.keys().next().value);
    thumbnailCache.set(source, output);
    return new Response(output, { status: 200, headers: {
      "Content-Type": "image/webp", "Content-Length": String(output.length),
      "Cache-Control": "public, max-age=86400", "X-Image-Bytes": String(output.length),
      "X-Image-Max-Bytes": String(MAX_THUMB_BYTES), "X-Image-Verified": "1", ...cors
    }});
  } catch (error) {
    console.error("[vercel-thumbnail]", error?.stack || error);
    return jsonError("Küçük görsel oluşturulamadı.", 502, cors);
  }
}

export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);
    // vercel.json rewrites the public path to /api/<original-path>.
    incomingUrl.pathname = incomingUrl.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
    const forwardedRequest = new Request(incomingUrl, request);

    if (incomingUrl.pathname === "/image/thumbnail") return handleThumbnail(forwardedRequest);

    // The V5.5 Worker adapter is deliberately locked to the test environment.
    // Live TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are never used by index.js.
    const env = { ...process.env, IS_TEST_ENV: "true" };
    const ctx = { waitUntil: promise => waitUntil(Promise.resolve(promise)) };
    return worker.fetch(forwardedRequest, env, ctx);
  }
};

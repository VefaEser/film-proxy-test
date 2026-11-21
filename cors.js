
// cors.js — Merkezi CORS politikası.
// Credentialed isteklerde Access-Control-Allow-Origin: "*" kullanılamaz.
// Yalnızca açıkça izin verilen frontend origin'ine CORS izni verilir.

const ALLOWED_ORIGINS = new Set([
  "https://vefaeser-kestik.static.hf.space"
]);

const BASE_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

export function corsHeaders(request) {
  const origin = request?.headers?.get?.("Origin") || "";
  const headers = { ...BASE_CORS_HEADERS };

  // Origin yoksa (ör. sunucudan sunucuya istek) veya izinli değilse
  // ACAO / credentials başlıkları eklenmez.
  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

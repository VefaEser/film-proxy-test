// cors.js — Yalnızca test HF sitesi için merkezi CORS.
// Cookie tabanlı oturumlarda wildcard kullanılmaz.
const ALLOWED_ORIGINS = new Set([
  "https://vefaeser-kestiktest.static.hf.space"
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

  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

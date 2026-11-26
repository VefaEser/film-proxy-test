# Vercel test adapter (V5.5)

This change adds a Vercel Node.js Function entry point for the existing V5.5 Worker application.

## Files
- `api/[...path].js`: catch-all Node.js function; rewrites `/...` to `/api/...`, restores the original path, invokes the existing Worker `fetch()` handler, connects `waitUntil`, and uses the existing `sharp` dependency for `/image/thumbnail`.
- `vercel.json`: routes all public paths through the catch-all function and sets a 300-second maximum function duration.
- `package.json`: adds `@vercel/functions` for Vercel's `waitUntil()` helper.

## Required Vercel environment variables
Set the TEST-only values in the Vercel project. Do not add live database credentials.

- `TEST_TURSO_DATABASE_URL`
- `TEST_TURSO_AUTH_TOKEN`
- Existing test API secrets used by the project (TMDB, OMDb, Gemini, Groq, Tavily, Turnstile, Crawlora and other configured integrations)
- `THUMBNAIL_ALLOWED_ORIGINS` (optional comma-separated extra origins)

The adapter sets `IS_TEST_ENV=true`; the existing `index.js` uses only the TEST Turso URL/token. Missing test DB credentials do not fall back to the live database.

## Important known gap before production-like testing
The V5.5 admin task queue is currently advanced by the Cloudflare Worker `scheduled()` handler. Vercel does not call that Worker lifecycle method. The Vercel adapter in this patch does not yet implement a safe queue pump/continuation mechanism for long CSV/card bulk jobs. Do not consider bulk queue behavior migrated or validated until that is implemented and tested. Normal HTTP routes and streamed research are the target of this first adapter test.

## Deployment settings
- Root directory: repository root (`./`)
- Framework / preset: Node.js (or Other if Vercel's UI requires a framework-specific choice; the repository's `api/` function is Node.js)
- Build command: leave default / unset
- Output directory: leave unset
- Install command: leave default
- Do not add a new Turso integration; use the existing TEST Turso credentials as environment variables.

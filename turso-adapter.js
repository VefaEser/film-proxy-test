// Cloudflare Workers: web/fetch tabanlı libSQL istemcisi.
import { createClient } from "@libsql/client/web";
import { createTursoAdapterWithClient } from "./turso-adapter-core.js";

export function createTursoAdapter(env, useTest = false) {
  return createTursoAdapterWithClient(env, useTest, createClient);
}

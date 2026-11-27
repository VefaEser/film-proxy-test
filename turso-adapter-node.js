// Vercel / Node.js: Node.js uyumlu libSQL istemcisi.
import { createClient } from "@libsql/client/node";
import { createTursoAdapterWithClient } from "./turso-adapter-core.js";

export function createTursoAdapter(env, useTest = false) {
  return createTursoAdapterWithClient(env, useTest, createClient);
}

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv[2] === "production";
const statePath = join(
  webRoot,
  "work",
  "openai-manual",
  production ? "openai-state.production.json" : "openai-state.json",
);
const state = JSON.parse(await readFile(statePath, "utf8"));
const vectorStoreId = String(state.vectorStoreId || "").trim();

if (state.status !== "completed" || !/^vs_[A-Za-z0-9_-]+$/.test(vectorStoreId)) {
  throw new Error(`색인이 완료된 ${production ? "운영용" : "시험용"} Vector Store 상태 파일이 필요합니다.`);
}

const result = spawnSync("npx", ["wrangler", "secret", "put", "OPENAI_VECTOR_STORE_ID"], {
  cwd: webRoot,
  input: `${vectorStoreId}\n`,
  encoding: "utf8",
  stdio: ["pipe", "inherit", "inherit"],
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`${production ? "운영용" : "시험용"} 매뉴얼 Vector Store ID를 Cloudflare Secret으로 등록했습니다.`);

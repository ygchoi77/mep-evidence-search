#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { askOpenAi } from "../server/ai-core.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv[2] === "--production";
const statePath = join(
  webRoot,
  "work",
  "openai-manual",
  production ? "openai-state.production.json" : "openai-state.json",
);
const question = process.argv.slice(production ? 3 : 2).join(" ").trim()
  || "기계실 환기설비를 검토할 때 매뉴얼에서 확인할 사항을 알려주세요.";

function readOpenAiKey() {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  if (process.platform !== "darwin") throw new Error("OPENAI_API_KEY 환경 변수가 필요합니다.");
  try {
    return execFileSync("security", ["find-generic-password", "-s", "codex-openai-api", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("macOS 키체인 서비스 'codex-openai-api'를 찾지 못했습니다.");
  }
}

const state = JSON.parse(await readFile(statePath, "utf8"));
const vectorStoreId = String(state.vectorStoreId || "").trim();
if (!/^vs_[A-Za-z0-9_-]+$/.test(vectorStoreId)) {
  throw new Error("시험용 Vector Store 상태 파일이 필요합니다.");
}

const result = await askOpenAi({
  apiKey: readOpenAiKey(),
  model: process.env.OPENAI_MODEL?.trim() || "gpt-5.6-terra",
  question,
  evidence: [],
  safetyIdentifier: createHash("sha256").update("mep-evidence:manual-smoke-test").digest("hex"),
  vectorStoreId,
});

console.log(JSON.stringify({
  question,
  model: result.model,
  answer: result.answer,
  manualSources: result.manualSources.map((source) => ({
    page: source.page,
    title: source.title,
    score: source.score,
  })),
  manualCitationCheck: result.manualCitationCheck,
  fileSearch: result.fileSearch,
  usage: result.usage,
}, null, 2));

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";

const endpoint = process.env.AI_API_URL?.trim()
  || "https://mep-evidence-ai.ygchoi77.workers.dev/api/ask";
const question = process.argv.slice(2).join(" ").trim()
  || "연료전지를 실내에 설치할 때 매뉴얼에서 확인할 사항을 알려주세요.";

if (process.platform !== "darwin") {
  throw new Error("macOS 키체인에서 공유 비밀번호를 읽을 수 있는 환경이 필요합니다.");
}

let password;
try {
  password = execFileSync(
    "security",
    ["find-generic-password", "-s", "codex-facility-search-password", "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
} catch {
  throw new Error("macOS 키체인 서비스 'codex-facility-search-password'를 찾지 못했습니다.");
}

const token = pbkdf2Sync(password, "mep-evidence-ai-access-v1", 600_000, 32, "sha256")
  .toString("base64url");
password = "";

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    Origin: "https://ygchoi77.github.io",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ question, evidence: [] }),
});
const data = await response.json().catch(() => ({}));
if (!response.ok) {
  throw new Error(`Worker 점검 실패 (${response.status}): ${data.error || "응답 형식 오류"}`);
}

console.log(JSON.stringify({
  status: response.status,
  model: data.model,
  answerPreview: String(data.answer || "").slice(0, 700),
  completion: data.completion,
  manualPages: (data.manualSources || []).map((source) => source.page),
  manualCitationCheck: data.manualCitationCheck,
  fileSearch: data.fileSearch,
  usage: data.usage,
}, null, 2));

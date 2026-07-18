import { execFileSync, spawnSync } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";

if (process.platform !== "darwin") {
  console.error("이 도구는 macOS 키체인을 사용합니다.");
  process.exit(1);
}

function readKeychain(service) {
  return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

try {
  const openAiKey = readKeychain("codex-openai-api");
  const password = readKeychain("codex-facility-search-password");
  const accessToken = pbkdf2Sync(
    password,
    "mep-evidence-ai-access-v1",
    600_000,
    32,
    "sha256",
  ).toString("base64url");

  const result = spawnSync("npx", ["wrangler", "secret", "bulk"], {
    input: JSON.stringify({ OPENAI_API_KEY: openAiKey, AI_ACCESS_TOKEN: accessToken }),
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log("키체인의 OpenAI 키와 파생 접속 토큰을 Cloudflare Secrets에 등록했습니다.");
} catch {
  console.error("키체인 값을 읽거나 Cloudflare Secrets에 등록하지 못했습니다.");
  process.exit(1);
}

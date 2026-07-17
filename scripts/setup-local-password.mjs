#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { userInfo } from "node:os";

if (process.platform !== "darwin") {
  throw new Error("이 도구는 macOS 키체인용입니다. APP_SHARED_PASSWORD를 사용하세요.");
}

const account = userInfo().username;
const service = "codex-facility-search-password";
const rotate = process.argv.includes("--rotate");

let exists = false;
try {
  execFileSync("security", ["find-generic-password", "-a", account, "-s", service], {
    stdio: "ignore",
  });
  exists = true;
} catch {
  exists = false;
}

if (exists && !rotate) {
  console.log(JSON.stringify({ status: "unchanged", service, account }));
  process.exit(0);
}

const password = randomBytes(18).toString("base64url");
execFileSync(
  "security",
  ["add-generic-password", "-U", "-a", account, "-s", service, "-w", password],
  { stdio: "ignore" },
);

const clipboard = spawnSync("pbcopy", [], { input: password, encoding: "utf8" });
console.log(
  JSON.stringify({
    status: exists ? "rotated" : "created",
    service,
    account,
    copiedToClipboard: clipboard.status === 0,
  }),
);

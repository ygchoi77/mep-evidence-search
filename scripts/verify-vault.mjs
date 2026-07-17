#!/usr/bin/env node

import { createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const account = userInfo().username;

function keychainSecret(service, required = true) {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    if (required) throw new Error(`키체인 서비스 '${service}'를 찾지 못했습니다.`);
    return "";
  }
}

function decrypt(ciphertext, key, iv) {
  const body = ciphertext.subarray(0, -16);
  const tag = ciphertext.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

async function filesBelow(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !["node_modules", ".git", "data"].includes(entry.name))
      .map((entry) => filesBelow(join(path, entry.name))),
  );
  return nested.flat();
}

const password = keychainSecret("codex-facility-search-password");
const kcscKey = keychainSecret("codex-kcsc-api", false);
const vaultDir = join(webRoot, "public", "vault");
const manifest = JSON.parse(await readFile(join(vaultDir, "manifest.json"), "utf8"));
const salt = Buffer.from(manifest.kdf.salt, "base64");
const key = pbkdf2Sync(password, salt, manifest.kdf.iterations, 32, "sha256");
const indexCiphertext = await readFile(join(vaultDir, manifest.assets.index.path));
const manualCiphertext = await readFile(join(vaultDir, manifest.assets.manual.path));
const indexPlaintext = decrypt(
  indexCiphertext,
  key,
  Buffer.from(manifest.assets.index.iv, "base64"),
);
const manualPlaintext = decrypt(
  manualCiphertext,
  key,
  Buffer.from(manifest.assets.manual.iv, "base64"),
);
const index = JSON.parse(indexPlaintext.toString("utf8"));

if (index.meta.pages !== 466) throw new Error("PDF 페이지 수가 예상값과 다릅니다.");
if (index.meta.citations !== 1310) throw new Error("인용 수가 예상값과 다릅니다.");
if (!manualPlaintext.subarray(0, 4).equals(Buffer.from("%PDF"))) {
  throw new Error("복호화한 원문이 PDF 형식이 아닙니다.");
}

let wrongPasswordRejected = false;
try {
  const wrongKey = pbkdf2Sync(randomBytes(24), salt, manifest.kdf.iterations, 32, "sha256");
  decrypt(indexCiphertext, wrongKey, Buffer.from(manifest.assets.index.iv, "base64"));
} catch {
  wrongPasswordRejected = true;
}
if (!wrongPasswordRejected) throw new Error("틀린 비밀번호가 거부되지 않았습니다.");

const publicFiles = await filesBelow(webRoot);
const secrets = [password, kcscKey].filter((secret) => secret.length >= 8);
let secretMatches = 0;
for (const path of publicFiles) {
  const contents = await readFile(path);
  for (const secret of secrets) {
    if (contents.includes(Buffer.from(secret))) secretMatches += 1;
  }
}
if (secretMatches) throw new Error("프로젝트 파일에서 비밀값이 발견되었습니다.");

const searchableText = index.items
  .map((item) => `${item.title ?? ""} ${item.text ?? ""} ${item.context ?? ""}`)
  .join(" ");
const queries = ["급수", "환기", "배수", "KDS"];
const queryCoverage = Object.fromEntries(
  queries.map((query) => [query, searchableText.includes(query)]),
);
if (Object.values(queryCoverage).some((covered) => !covered)) {
  throw new Error("대표 검색어가 인덱스에 없습니다.");
}

console.log(
  JSON.stringify({
    status: "ok",
    items: index.items.length,
    pages: index.meta.pages,
    citations: index.meta.citations,
    mappedCitations: index.meta.mappedCitations,
    wrongPasswordRejected,
    pdfHeaderVerified: true,
    secretMatches,
    kcscKeyChecked: Boolean(kcscKey),
    queryCoverage,
  }),
);

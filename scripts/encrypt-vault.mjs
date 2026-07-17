#!/usr/bin/env node

import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const projectRoot = resolve(webRoot, "..");
const outputDir = join(webRoot, "public", "vault");
const service = "codex-facility-search-password";
const account = userInfo().username;
const iterations = 600_000;

function readPassword() {
  if (process.env.APP_SHARED_PASSWORD) return process.env.APP_SHARED_PASSWORD;
  if (process.platform !== "darwin") {
    throw new Error("APP_SHARED_PASSWORD 환경 변수가 필요합니다.");
  }
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error(`macOS 키체인 서비스 '${service}'를 찾지 못했습니다.`);
  }
}

function encrypt(buffer, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final(), cipher.getAuthTag()]);
  return { iv, ciphertext };
}

async function locateManual() {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(projectRoot);
  const filename = files.find((name) => name.endsWith(".pdf") && name.normalize("NFC").includes("기계설비"));
  if (!filename) throw new Error("기계설비 PDF 원본을 찾지 못했습니다.");
  return join(projectRoot, filename);
}

const password = readPassword();
if (password.length < 16) throw new Error("공유 비밀번호는 16자 이상이어야 합니다.");

const indexPath = join(webRoot, "data", "search-index.json");
const manualPath = await locateManual();
const index = await readFile(indexPath);
const manual = await readFile(manualPath);
const indexJson = JSON.parse(index.toString("utf8"));
const salt = randomBytes(16);
const key = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const encryptedIndex = encrypt(index, key);
const encryptedManual = encrypt(manual, key);

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "index.enc"), encryptedIndex.ciphertext);
await writeFile(join(outputDir, "manual.enc"), encryptedManual.ciphertext);
await writeFile(
  join(outputDir, "manifest.json"),
  JSON.stringify(
    {
      version: 1,
      algorithm: "AES-GCM",
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations,
        salt: salt.toString("base64"),
      },
      summary: indexJson.meta,
      assets: {
        index: {
          path: "index.enc",
          iv: encryptedIndex.iv.toString("base64"),
          bytes: encryptedIndex.ciphertext.length,
        },
        manual: {
          path: "manual.enc",
          iv: encryptedManual.iv.toString("base64"),
          bytes: encryptedManual.ciphertext.length,
          mime: "application/pdf",
        },
      },
    },
    null,
    2,
  ),
);

console.log(
  JSON.stringify({
    output: outputDir.replace(homedir(), "~"),
    indexBytes: encryptedIndex.ciphertext.length,
    manualBytes: encryptedManual.ciphertext.length,
    passwordSource: process.env.APP_SHARED_PASSWORD ? "environment" : "macOS-keychain",
  }),
);

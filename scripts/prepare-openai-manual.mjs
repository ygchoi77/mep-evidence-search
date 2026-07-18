#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(webRoot, "data", "search-index.json");
const outputRoot = join(webRoot, "work", "openai-manual");
const pagesDir = join(outputRoot, "pages");
const expectedPages = 466;

function cleanText(value = "") {
  return String(value)
    .normalize("NFC")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const index = JSON.parse(await readFile(indexPath, "utf8"));
const manualPages = index.items
  .filter((item) => item.kind === "manual")
  .sort((left, right) => Number(left.page) - Number(right.page));

if (manualPages.length !== expectedPages) {
  throw new Error(`매뉴얼 쪽수가 ${expectedPages}쪽이 아닙니다: ${manualPages.length}`);
}
if (manualPages.some((item, indexNumber) => Number(item.page) !== indexNumber + 1)) {
  throw new Error("매뉴얼 쪽 번호가 연속적이지 않습니다.");
}
if (manualPages.some((item) => item.source !== "기계설비 기술기준 매뉴얼")) {
  throw new Error("매뉴얼 이외의 자료가 업로드 목록에 포함되었습니다.");
}

// Preserve the ignored OpenAI state file so an interrupted upload can resume safely.
await rm(pagesDir, { recursive: true, force: true });
await mkdir(pagesDir, { recursive: true });

const files = [];
for (const item of manualPages) {
  const page = Number(item.page);
  const pageLabel = String(page).padStart(4, "0");
  const filename = `manual-page-${pageLabel}.md`;
  const title = cleanText(item.title) || `매뉴얼 ${page}쪽`;
  const body = cleanText(item.text);
  const contents = [
    `# ${title}`,
    "",
    "- 문서: 기계설비 기술기준 매뉴얼",
    `- 원문 PDF: ${page}쪽`,
    `- 자료 기준일: ${item.date || index.meta.sourceDate || "2022-05"}`,
    `- 근거 ID: ${item.id}`,
    "",
    body || "(이 쪽은 표지 또는 구분 페이지로 추출된 본문이 없습니다.)",
    "",
  ].join("\n");
  const path = join(pagesDir, filename);
  await writeFile(path, contents, "utf8");
  files.push({
    filename,
    page,
    title,
    bytes: Buffer.byteLength(contents),
    characters: contents.length,
    sha256: sha256(contents),
  });
}

const unexpectedFiles = (await readdir(pagesDir)).filter(
  (filename) => !files.some((file) => file.filename === filename),
);
if (unexpectedFiles.length) throw new Error("업로드 폴더에 예상하지 못한 파일이 있습니다.");

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  scope: "public-manual-only",
  document: index.meta.source,
  sourceDate: index.meta.sourceDate,
  pages: files.length,
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  totalCharacters: files.reduce((sum, file) => sum + file.characters, 0),
  excludedKinds: ["citation", "article", "instrument"],
  files,
};
await writeFile(join(outputRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

console.log(JSON.stringify({
  output: outputRoot,
  scope: manifest.scope,
  pages: manifest.pages,
  totalBytes: manifest.totalBytes,
  excludedKinds: manifest.excludedKinds,
}));

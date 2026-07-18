#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = join(webRoot, "work", "openai-manual");
const pagesDir = join(bundleRoot, "pages");
const manifestPath = join(bundleRoot, "manifest.json");
const apiBase = "https://api.openai.com/v1";
const requestedCommand = process.argv[2] || "status";
const production = requestedCommand.endsWith("-production");
const command = requestedCommand.replace(/-production$/, "");
const profile = production ? "production" : "pilot";
const statePath = join(
  bundleRoot,
  production ? "openai-state.production.json" : "openai-state.json",
);
const expiresDays = production
  ? null
  : Number.parseInt(process.env.OPENAI_VECTOR_STORE_EXPIRES_DAYS || "7", 10);

function readOpenAiKey() {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  if (process.platform !== "darwin") {
    throw new Error("OPENAI_API_KEY 환경 변수가 필요합니다.");
  }
  try {
    return execFileSync("security", ["find-generic-password", "-s", "codex-openai-api", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("macOS 키체인 서비스 'codex-openai-api'를 찾지 못했습니다.");
  }
}

const apiKey = readOpenAiKey();

async function api(path, options = {}, retries = 3) {
  let response;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.headers || {}),
      },
    });
    if (response.ok) return response;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === retries) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * 2 ** attempt));
  }
  const data = await response.json().catch(() => ({}));
  const message = data?.error?.message || `OpenAI API 오류 (${response.status})`;
  throw new Error(`${message}${data?.error?.code ? ` [${data.error.code}]` : ""}`);
}

async function apiJson(path, options = {}) {
  const response = await api(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  return response.json();
}

async function readState(required = true) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    if (required) throw new Error("로컬 OpenAI 상태 파일이 없습니다. 먼저 create를 실행하세요.");
    return { version: 1, uploadedFiles: [] };
  }
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function uploadFile(file, fileExpiresDays) {
  const contents = await readFile(join(pagesDir, file.filename));
  const form = new FormData();
  form.append("purpose", "assistants");
  form.append("file", new Blob([contents], { type: "text/markdown" }), file.filename);
  if (fileExpiresDays) {
    form.append("expires_after[anchor]", "created_at");
    form.append("expires_after[seconds]", String(fileExpiresDays * 24 * 60 * 60));
  }
  const response = await api("/files", { method: "POST", body: form });
  const uploaded = await response.json();
  return {
    id: uploaded.id,
    filename: file.filename,
    page: file.page,
    sha256: file.sha256,
    bytes: uploaded.bytes,
    expiresAt: uploaded.expires_at ?? null,
  };
}

async function pollFileBatch(state) {
  const deadline = Date.now() + 15 * 60_000;
  let current = await apiJson(
    `/vector_stores/${state.vectorStoreId}/file_batches/${state.fileBatchId}`,
  );
  let lastProgress = "";
  while (["in_progress", "queued"].includes(current.status) && Date.now() < deadline) {
    const progress = JSON.stringify({ status: current.status, fileCounts: current.file_counts });
    if (progress !== lastProgress) {
      console.log(JSON.stringify({ stage: "index", ...JSON.parse(progress) }));
      lastProgress = progress;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    current = await apiJson(
      `/vector_stores/${state.vectorStoreId}/file_batches/${state.fileBatchId}`,
    );
  }
  state.status = current.status;
  state.fileCounts = current.file_counts;
  await saveState(state);
  if (current.status !== "completed" || current.file_counts?.failed) {
    throw new Error(`Vector Store 색인이 아직 완료되지 않았습니다: ${current.status}`);
  }
  console.log(JSON.stringify({
    status: "completed",
    profile: state.profile || profile,
    expiresDays: state.expiresDays,
    files: current.file_counts?.completed,
  }));
}

async function createStore() {
  if (!production && (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 30)) {
    throw new Error("시험용 만료일은 1~30일 사이여야 합니다.");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.scope !== "public-manual-only" || manifest.pages !== 466) {
    throw new Error("공개 매뉴얼 전용 업로드 묶음이 아닙니다.");
  }
  const state = await readState(false);
  if (state.vectorStoreId && state.fileBatchId) {
    console.log(JSON.stringify({ stage: "resume", uploaded: state.uploadedFiles.length }));
    await pollFileBatch(state);
    return;
  }

  const uploadedByHash = new Map(
    state.uploadedFiles.map((file) => [`${file.filename}:${file.sha256}`, file]),
  );
  const pending = manifest.files.filter(
    (file) => !uploadedByHash.has(`${file.filename}:${file.sha256}`),
  );
  console.log(JSON.stringify({ stage: "upload", total: manifest.files.length, pending: pending.length }));

  const uploadBatchSize = 8;
  for (let start = 0; start < pending.length; start += uploadBatchSize) {
    const batch = pending.slice(start, start + uploadBatchSize);
    const uploaded = await Promise.all(
      batch.map((file) => uploadFile(file, production ? null : expiresDays + 1)),
    );
    state.uploadedFiles.push(...uploaded);
    await saveState(state);
    console.log(JSON.stringify({
      stage: "upload",
      completed: state.uploadedFiles.length,
      total: manifest.files.length,
    }));
  }

  if (!state.vectorStoreId) {
    const vectorStoreBody = {
      name: production
        ? "MEP Evidence 공개 매뉴얼 운영"
        : `MEP Evidence 공개 매뉴얼 시험 ${new Date().toISOString().slice(0, 10)}`,
      metadata: {
        scope: "public-manual-only",
        profile,
        source_date: manifest.sourceDate,
        pages: String(manifest.pages),
      },
    };
    if (!production) {
      vectorStoreBody.expires_after = { anchor: "last_active_at", days: expiresDays };
    }
    const vectorStore = await apiJson("/vector_stores", {
      method: "POST",
      body: JSON.stringify(vectorStoreBody),
    });
    state.vectorStoreId = vectorStore.id;
    state.profile = profile;
    state.expiresDays = expiresDays;
    state.createdAt = new Date().toISOString();
    await saveState(state);
  }

  const uploadedByName = new Map(state.uploadedFiles.map((file) => [file.filename, file]));
  const files = manifest.files.map((file) => ({
    file_id: uploadedByName.get(file.filename).id,
    attributes: {
      kind: "manual",
      page: file.page,
      source_date: manifest.sourceDate,
    },
  }));
  const fileBatch = await apiJson(`/vector_stores/${state.vectorStoreId}/file_batches`, {
    method: "POST",
    body: JSON.stringify({ files }),
  });
  state.fileBatchId = fileBatch.id;
  await saveState(state);
  await pollFileBatch(state);
}

async function showStatus() {
  const state = await readState();
  const store = await apiJson(`/vector_stores/${state.vectorStoreId}`);
  console.log(JSON.stringify({
    id: store.id,
    profile,
    name: store.name,
    status: store.status,
    usageBytes: store.usage_bytes ?? store.bytes ?? null,
    expiresAfter: store.expires_after,
    expiresAt: store.expires_at,
    lastActiveAt: store.last_active_at,
    fileCounts: store.file_counts,
  }, null, 2));
}

async function diagnoseStore() {
  const state = await readState();
  const uploadedById = new Map(
    (state.uploadedFiles || []).map((file) => [file.id, file]),
  );
  const result = await apiJson(
    `/vector_stores/${state.vectorStoreId}/files?filter=in_progress&limit=100`,
  );
  console.log(JSON.stringify({
    inProgress: (result.data || []).length,
    hasMore: Boolean(result.has_more),
    files: (result.data || []).map((item) => ({
      page: uploadedById.get(item.file_id || item.id)?.page ?? item.attributes?.page ?? null,
      filename: uploadedById.get(item.file_id || item.id)?.filename ?? null,
      status: item.status,
      lastError: item.last_error ?? null,
    })),
  }, null, 2));
}

async function searchStore() {
  const state = await readState();
  const query = process.argv.slice(3).join(" ").trim();
  if (query.length < 3) throw new Error("검색 질문을 3자 이상 입력하세요.");
  const result = await apiJson(`/vector_stores/${state.vectorStoreId}/search`, {
    method: "POST",
    body: JSON.stringify({ query, rewrite_query: false, max_num_results: 6 }),
  });
  console.log(JSON.stringify({
    query,
    rewrittenQuery: result.search_query,
    results: (result.data || []).map((item) => ({
      filename: item.filename,
      score: item.score,
      page: item.attributes?.page ?? null,
      preview: (item.content || []).map((part) => part.text || "").join(" ").slice(0, 240),
    })),
  }, null, 2));
}

async function deleteStore() {
  const state = await readState();
  if (state.vectorStoreId) {
    await api(`/vector_stores/${state.vectorStoreId}`, { method: "DELETE" });
  }
  const files = state.uploadedFiles || [];
  const deleteBatchSize = 12;
  for (let start = 0; start < files.length; start += deleteBatchSize) {
    await Promise.all(
      files.slice(start, start + deleteBatchSize).map((file) =>
        api(`/files/${file.id}`, { method: "DELETE" }).catch(() => null),
      ),
    );
  }
  await saveState({
    version: 1,
    deletedAt: new Date().toISOString(),
    deletedVectorStoreId: state.vectorStoreId,
    uploadedFiles: [],
  });
  console.log(JSON.stringify({ status: "deleted", files: files.length }));
}

if (command === "create") await createStore();
else if (command === "status") await showStatus();
else if (command === "diagnose") await diagnoseStore();
else if (command === "search") await searchStore();
else if (command === "delete") await deleteStore();
else throw new Error("명령은 create, status, diagnose, search, delete와 -production 변형 중 하나여야 합니다.");

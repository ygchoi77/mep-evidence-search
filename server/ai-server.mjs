import { createHash, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { askOpenAi, validateRequest } from "./ai-core.mjs";

const PORT = Number.parseInt(process.env.PORT ?? process.env.AI_PORT ?? "8787", 10);
const HOST = process.env.AI_HOST?.trim() || "127.0.0.1";
const MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5.6-terra";
const VECTOR_STORE_ID = /^vs_[A-Za-z0-9_-]+$/.test(process.env.OPENAI_VECTOR_STORE_ID?.trim() || "")
  ? process.env.OPENAI_VECTOR_STORE_ID.trim()
  : "";
const ACCESS_SALT = "mep-evidence-ai-access-v1";
const ACCESS_ITERATIONS = 600_000;
const MAX_BODY_BYTES = 48 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 10;
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const DEFAULT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS?.split(",") ?? DEFAULT_ORIGINS)
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean),
);
const rateBuckets = new Map();

function readKeychain(service) {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function getOpenAiKey() {
  const key = process.env.OPENAI_API_KEY?.trim() || readKeychain("codex-openai-api");
  if (!key) throw new Error("OpenAI API 키가 서버에 설정되지 않았습니다.");
  return key;
}

function deriveAccessToken(sharedPassword) {
  return pbkdf2Sync(sharedPassword, ACCESS_SALT, ACCESS_ITERATIONS, 32, "sha256")
    .toString("base64url");
}

function getExpectedAccessToken() {
  const configured = process.env.AI_ACCESS_TOKEN?.trim();
  if (configured) return configured;
  const password = readKeychain("codex-facility-search-password");
  if (!password) throw new Error("AI 접속 토큰 또는 공유 비밀번호가 서버에 설정되지 않았습니다.");
  return deriveAccessToken(password);
}

function tokenMatches(received, expected) {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function setCorsHeaders(request, response) {
  const origin = request.headers.origin?.replace(/\/$/, "");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  return !origin || allowedOrigins.has(origin);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let rejected = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (rejected) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        rejected = true;
        reject(Object.assign(new Error("요청 본문이 너무 큽니다."), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(Object.assign(new Error("JSON 요청 형식이 올바르지 않습니다."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function requestIp(request) {
  const remoteAddress = request.socket.remoteAddress || "unknown";
  if (!TRUST_PROXY) return remoteAddress;
  const forwarded = request.headers["x-forwarded-for"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0])?.trim()
    || remoteAddress;
}

function checkRateLimit(request) {
  const now = Date.now();
  const ip = requestIp(request);
  if (rateBuckets.size > 5_000) {
    for (const [key, bucket] of rateBuckets) {
      if (now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  const current = rateBuckets.get(ip);
  if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT_REQUESTS;
}

const server = createServer(async (request, response) => {
  const corsAllowed = setCorsHeaders(request, response);
  if (request.method === "OPTIONS") {
    response.writeHead(corsAllowed ? 204 : 403, { "Cache-Control": "no-store" });
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, model: MODEL, manualSearch: Boolean(VECTOR_STORE_ID) });
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/ask") {
    sendJson(response, 404, { error: "요청 경로를 찾을 수 없습니다." });
    return;
  }
  if (!corsAllowed) {
    sendJson(response, 403, { error: "허용되지 않은 웹사이트에서 보낸 요청입니다." });
    return;
  }

  try {
    const authorization = request.headers.authorization ?? "";
    const receivedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!receivedToken || !tokenMatches(receivedToken, getExpectedAccessToken())) {
      sendJson(response, 401, { error: "AI 접속 권한을 확인하지 못했습니다." });
      return;
    }
    if (!checkRateLimit(request)) {
      sendJson(response, 429, { error: "요청이 많습니다. 1분 뒤 다시 시도해 주세요." });
      return;
    }
    const { question, evidence } = validateRequest(await readJson(request), {
      allowEmptyEvidence: Boolean(VECTOR_STORE_ID),
    });
    const safetyIdentifier = createHash("sha256")
      .update(`mep-evidence:${requestIp(request)}`)
      .digest("hex");
    const result = await askOpenAi({
      apiKey: getOpenAiKey(),
      model: MODEL,
      question,
      evidence,
      safetyIdentifier,
      vectorStoreId: VECTOR_STORE_ID,
    });
    sendJson(response, 200, result);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || (error?.name === "TimeoutError" ? 504 : 500);
    if (error?.openAiCode) console.error(`[AI API] upstream error: ${error.openAiCode}`);
    else if (statusCode >= 500) console.error(`[AI API] ${error?.message || "unknown server error"}`);
    sendJson(response, statusCode, {
      error: statusCode >= 500 ? "AI 답변 서버에서 오류가 발생했습니다." : error.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI 중계 서버가 http://${HOST}:${PORT} 에서 실행 중입니다.`);
  console.log(`모델: ${MODEL} · 허용 출처: ${[...allowedOrigins].join(", ")}`);
});

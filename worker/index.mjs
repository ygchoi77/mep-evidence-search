import { askOpenAi, validateRequest } from "../server/ai-core.mjs";

const MAX_BODY_BYTES = 48 * 1024;
const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const encoder = new TextEncoder();
const localRateBuckets = new Map();

function allowedOrigins(env) {
  return new Set(
    (env.ALLOWED_ORIGINS?.split(",") ?? DEFAULT_ORIGINS)
      .map((value) => value.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin")?.replace(/\/$/, "");
  if (!origin || !allowedOrigins(env).has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function isCorsAllowed(request, env) {
  const origin = request.headers.get("Origin")?.replace(/\/$/, "");
  return !origin || allowedOrigins(env).has(origin);
}

function jsonResponse(request, env, value, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(request, env),
    },
  });
}

function tokenMatches(received, expected) {
  const left = encoder.encode(received);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function vectorStoreId(env) {
  const value = env.OPENAI_VECTOR_STORE_ID?.trim() || "";
  return /^vs_[A-Za-z0-9_-]+$/.test(value) ? value : "";
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error("요청 본문이 너무 큽니다."), { statusCode: 413 });
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error("요청 본문이 너무 큽니다."), { statusCode: 413 });
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes) || "{}");
  } catch {
    throw Object.assign(new Error("JSON 요청 형식이 올바르지 않습니다."), { statusCode: 400 });
  }
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function localRateLimit(key) {
  const now = Date.now();
  const current = localRateBuckets.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    localRateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 10;
}

async function checkRateLimit(request, env) {
  const key = `ai:${clientIp(request)}`;
  if (env.AI_RATE_LIMITER) {
    const { success } = await env.AI_RATE_LIMITER.limit({ key });
    return success;
  }
  return localRateLimit(key);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname === "/api/ask") {
      return new Response(null, {
        status: isCorsAllowed(request, env) ? 204 : 403,
        headers: { "Cache-Control": "no-store", ...corsHeaders(request, env) },
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(request, env, {
        ok: true,
        model: env.OPENAI_MODEL || DEFAULT_MODEL,
        manualSearch: Boolean(vectorStoreId(env)),
      });
    }
    if (request.method !== "POST" || url.pathname !== "/api/ask") {
      return jsonResponse(request, env, { error: "요청 경로를 찾을 수 없습니다." }, 404);
    }
    if (!isCorsAllowed(request, env)) {
      return jsonResponse(request, env, { error: "허용되지 않은 웹사이트에서 보낸 요청입니다." }, 403);
    }

    try {
      const authorization = request.headers.get("Authorization") || "";
      const receivedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!env.AI_ACCESS_TOKEN) throw new Error("AI 접속 토큰이 서버에 설정되지 않았습니다.");
      if (!receivedToken || !tokenMatches(receivedToken, env.AI_ACCESS_TOKEN)) {
        return jsonResponse(request, env, { error: "AI 접속 권한을 확인하지 못했습니다." }, 401);
      }
      if (!await checkRateLimit(request, env)) {
        return jsonResponse(request, env, { error: "요청이 많습니다. 1분 뒤 다시 시도해 주세요." }, 429);
      }
      const manualStoreId = vectorStoreId(env);
      const { question, evidence } = validateRequest(await readJson(request), {
        allowEmptyEvidence: Boolean(manualStoreId),
      });
      const result = await askOpenAi({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL || DEFAULT_MODEL,
        question,
        evidence,
        safetyIdentifier: await sha256(`mep-evidence:${clientIp(request)}`),
        vectorStoreId: manualStoreId,
      });
      return jsonResponse(request, env, result);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (error?.openAiCode) console.error(`[AI API] upstream error: ${error.openAiCode}`);
      else if (statusCode >= 500) console.error(`[AI API] ${error?.message || "unknown server error"}`);
      return jsonResponse(request, env, {
        error: statusCode >= 500 ? "AI 답변 서버에서 오류가 발생했습니다." : error.message,
      }, statusCode);
    }
  },
};

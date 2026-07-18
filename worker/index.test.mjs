import assert from "node:assert/strict";
import test from "node:test";
import worker from "./index.mjs";

const env = {
  OPENAI_API_KEY: "test-openai-key",
  AI_ACCESS_TOKEN: "test-access-token",
  OPENAI_MODEL: "test-model",
  ALLOWED_ORIGINS: "https://ygchoi77.github.io,http://localhost:5173",
  AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
};

function request(path, options = {}) {
  return new Request(`https://mep-evidence-ai.example.workers.dev${path}`, options);
}

test("health check does not expose secrets", async () => {
  const response = await worker.fetch(request("/health"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, model: "test-model" });
});

test("rejects an origin outside the allowlist", async () => {
  const response = await worker.fetch(request("/api/ask", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  }), env);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("rejects a request without the access token", async () => {
  const response = await worker.fetch(request("/api/ask", {
    method: "POST",
    headers: { Origin: "https://ygchoi77.github.io" },
  }), env);
  assert.equal(response.status, 401);
});

test("forwards only validated evidence and returns usage", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.headers.Authorization, "Bearer test-openai-key");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.model, "test-model");
    assert.match(body.input, /\[근거 1\]/);
    return Response.json({
      id: "resp_test",
      model: "test-model",
      output_text: "테스트 답변 [근거 1]",
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    });
  };

  const response = await worker.fetch(request("/api/ask", {
    method: "POST",
    headers: {
      Origin: "https://ygchoi77.github.io",
      Authorization: "Bearer test-access-token",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10",
    },
    body: JSON.stringify({
      question: "이 근거의 내용을 알려주세요.",
      evidence: [{ id: "1", title: "근거", excerpt: "검증할 근거 본문" }],
    }),
  }), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://ygchoi77.github.io");
  const data = await response.json();
  assert.equal(data.answer, "테스트 답변 [근거 1]");
  assert.equal(data.usage.totalTokens, 120);
});

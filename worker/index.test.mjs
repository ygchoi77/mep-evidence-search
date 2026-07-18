import assert from "node:assert/strict";
import test from "node:test";
import { extractManualSources, inspectManualCitations } from "../server/ai-core.mjs";
import worker from "./index.mjs";

const env = {
  OPENAI_API_KEY: "test-openai-key",
  AI_ACCESS_TOKEN: "test-access-token",
  OPENAI_MODEL: "test-model",
  OPENAI_VECTOR_STORE_ID: "vs_test_manual",
  ALLOWED_ORIGINS: "https://ygchoi77.github.io,http://localhost:5173",
  AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
};

function request(path, options = {}) {
  return new Request(`https://mep-evidence-ai.example.workers.dev${path}`, options);
}

test("detects a manual citation that does not match retrieved PDF pages", () => {
  assert.deepEqual(
    inspectManualCitations("확인했습니다. [매뉴얼 120쪽]", [{ page: 123 }]),
    { status: "mismatch", citedPages: [120], unmatchedPages: [120] },
  );
});

test("keeps the highest-scoring chunk when one manual page is returned twice", () => {
  const output = [{
    type: "file_search_call",
    results: [
      {
        file_id: "file_same",
        filename: "manual-page-0012.md",
        score: 0.9,
        content: [{ type: "text", text: "# 높은 점수\n본문 A" }],
      },
      {
        file_id: "file_same",
        filename: "manual-page-0012.md",
        score: 0.7,
        content: [{ type: "text", text: "# 낮은 점수\n본문 B" }],
      },
    ],
  }];
  const sources = extractManualSources({ output });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].score, 0.9);
  assert.equal(sources[0].title, "높은 점수");
});

test("health check does not expose secrets", async () => {
  const response = await worker.fetch(request("/health"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    model: "test-model",
    manualSearch: true,
  });
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
    assert.deepEqual(body.tools, [{
      type: "file_search",
      vector_store_ids: ["vs_test_manual"],
      max_num_results: 6,
    }]);
    assert.equal(body.tool_choice, "required");
    assert.deepEqual(body.include, ["file_search_call.results"]);
    return Response.json({
      id: "resp_test",
      model: "test-model",
      output_text: "테스트 답변 [근거 1]",
      output: [{
        type: "file_search_call",
        status: "completed",
        results: [{
          file_id: "file_manual_123",
          filename: "manual-page-0123.md",
          score: 0.88,
          attributes: { page: 123 },
          content: [{ type: "text", text: "# 급수 배관\n관경 산정 관련 시험 본문" }],
        }],
      }],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 10 },
      },
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
  assert.equal(data.usage.cachedInputTokens, 10);
  assert.equal(data.fileSearch.status, "completed");
  assert.equal(data.manualSources.length, 1);
  assert.equal(data.manualSources[0].page, 123);
  assert.equal(data.manualSources[0].score, 0.88);
  assert.equal(data.manualCitationCheck.status, "none");
});

test("allows a manual-only question when the vector store is configured", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.input, /브라우저 검색 근거 없음/);
    return Response.json({
      id: "resp_manual_only",
      model: "test-model",
      output_text: "매뉴얼 답변 [매뉴얼 45쪽]",
      output: [{
        type: "file_search_call",
        status: "completed",
        results: [{
          file_id: "file_manual_45",
          filename: "manual-page-0045.md",
          score: 0.75,
          attributes: { page: 45 },
          content: [{ type: "text", text: "# 환기설비\n환기 관련 시험 본문" }],
        }],
      }],
    });
  };

  const response = await worker.fetch(request("/api/ask", {
    method: "POST",
    headers: {
      Origin: "https://ygchoi77.github.io",
      Authorization: "Bearer test-access-token",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.11",
    },
    body: JSON.stringify({ question: "기계실 환기 기준을 알려주세요.", evidence: [] }),
  }), env);

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.manualSources[0].page, 45);
  assert.equal(data.manualCitationCheck.status, "verified");
});

test("still rejects empty evidence when manual search is not configured", async () => {
  const { OPENAI_VECTOR_STORE_ID: _unused, ...envWithoutStore } = env;
  const response = await worker.fetch(request("/api/ask", {
    method: "POST",
    headers: {
      Origin: "https://ygchoi77.github.io",
      Authorization: "Bearer test-access-token",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.12",
    },
    body: JSON.stringify({ question: "기계실 환기 기준을 알려주세요.", evidence: [] }),
  }), envWithoutStore);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "답변에 사용할 검색 근거가 없습니다." });
});

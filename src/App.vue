<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

type ItemKind = "manual" | "citation" | "article" | "instrument";
type ItemStatus = "source" | "current" | "review";

type SearchItem = {
  id: string;
  kind: ItemKind;
  title: string;
  source?: string;
  page?: number | null;
  pageMapping?: string;
  line?: number | string;
  section?: string;
  text?: string;
  quote?: string;
  context?: string;
  summary?: string;
  instrument?: string;
  article?: string;
  hierarchy?: string;
  confidence?: string;
  reviewReason?: string;
  officialUrl?: string;
  effectiveDate?: string;
  changeStatus?: string;
  code?: string;
  status: ItemStatus;
};

type SearchIndex = {
  meta: {
    title: string;
    source: string;
    sourceDate: string;
    snapshotDate: string;
    pages: number;
    citations: number;
    articles: number;
    instruments: number;
    reviews: number;
    mappedCitations: number;
    notice: string;
  };
  items: SearchItem[];
};

type VaultAsset = {
  path: string;
  iv: string;
  bytes: number;
  mime?: string;
};

type VaultManifest = {
  version: number;
  algorithm: "AES-GCM";
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  summary: SearchIndex["meta"];
  assets: {
    index: VaultAsset;
    manual: VaultAsset;
  };
};

type AiEvidence = {
  id: string;
  title: string;
  source: string;
  page: number | null;
  article: string;
  status: ItemStatus;
  excerpt: string;
  officialUrl: string;
};

type AiResult = {
  answer: string;
  model: string;
  requestId: string | null;
  completion?: {
    status: string;
    reason: string | null;
  };
  manualSources?: Array<{
    fileId: string;
    filename: string;
    page: number | null;
    title: string;
    score: number | null;
    excerpt: string;
  }>;
  manualCitationCheck?: {
    status: "none" | "verified" | "mismatch";
    citedPages: number[];
    unmatchedPages: number[];
  };
  fileSearch?: {
    enabled: boolean;
    status: "disabled" | "enabled" | "completed" | "no_results" | "fallback";
    resultCount: number;
  };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cachedInputTokens?: number | null;
    cacheWriteTokens?: number | null;
  };
};

type AiUsageSummary = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

const kindLabels: Record<ItemKind, string> = {
  manual: "매뉴얼",
  citation: "인용 근거",
  article: "현행 조문",
  instrument: "법령·기준",
};

const quickQueries = [
  "급수 배관 관경",
  "기계실 환기",
  "급탕 배관 보온",
  "배수 통기관",
  "기계설비 착공 전 확인",
  "KDS 31 35 12",
];

const PAGE_SIZE = 20;

const stopWords = new Set([
  "기준",
  "관련",
  "대한",
  "어디",
  "무엇",
  "찾아줘",
  "알려줘",
  "설계",
  "적용",
]);

const manifest = ref<VaultManifest | null>(null);
const manifestUrl = ref<URL | null>(null);
const searchIndex = ref<SearchIndex | null>(null);
const cryptoKey = ref<CryptoKey | null>(null);
const password = ref("");
const showPassword = ref(false);
const unlocking = ref(false);
const unlockError = ref("");
const query = ref("");
const kind = ref<"all" | ItemKind>("all");
const status = ref<"all" | ItemStatus>("all");
const currentPage = ref(1);
const pdfLoading = ref(false);
const pdfUrl = ref<string | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const resultsHeading = ref<HTMLElement | null>(null);
const aiAccessToken = ref("");
const aiLoading = ref(false);
const aiResult = ref<AiResult | null>(null);
const aiError = ref("");
const aiSources = ref<AiEvidence[]>([]);
const aiCostAcknowledged = ref(false);
const aiUsageSummary = ref<AiUsageSummary>({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});
const aiApiUrl = import.meta.env.VITE_AI_API_URL?.trim()
  || (import.meta.env.DEV ? "http://localhost:8787/api/ask" : "");

function bytesFromBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function normalize(value = "") {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("ko")
    .replace(/[^0-9a-z가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function condensed(value = "") {
  return normalize(value).replace(/\s/g, "");
}

function safeOfficialUrl(value = "") {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function itemText(item: SearchItem) {
  return [
    item.title,
    item.source,
    item.section,
    item.text,
    item.quote,
    item.context,
    item.summary,
    item.instrument,
    item.article,
    item.hierarchy,
    item.changeStatus,
    item.code,
  ]
    .filter(Boolean)
    .join(" ");
}

function scoreItem(item: SearchItem, searchQuery: string) {
  const phrase = normalize(searchQuery);
  const needle = condensed(searchQuery);
  if (!needle) return 0;

  const title = normalize(
    `${item.title} ${item.instrument ?? ""} ${item.article ?? ""} ${item.code ?? ""}`,
  );
  const body = normalize(itemText(item));
  const condensedTitle = title.replace(/\s/g, "");
  const condensedBody = body.replace(/\s/g, "");
  const tokens = phrase
    .split(" ")
    .filter((token) => token.length > 1 && !stopWords.has(token));

  let score = 0;
  if (condensedTitle.includes(needle)) score += 90;
  if (condensedBody.includes(needle)) score += 48;
  for (const token of tokens) {
    if (title.includes(token)) score += 18;
    if (normalize(item.quote ?? "").includes(token)) score += 11;
    if (normalize(item.context ?? "").includes(token)) score += 8;
    if (body.includes(token)) score += 4;
  }
  if (tokens.length && tokens.every((token) => body.includes(token))) score += 24;
  if (item.kind === "citation" && item.officialUrl) score += 3;
  if (item.status === "current") score += 1;
  return score;
}

function makeSnippet(item: SearchItem, searchQuery: string) {
  const fields = [item.context, item.quote, item.summary, item.text].filter(
    (value): value is string => Boolean(value),
  );
  const tokens = normalize(searchQuery)
    .split(" ")
    .filter((token) => token.length > 1 && !stopWords.has(token));
  const selected =
    fields.find((field) => tokens.some((token) => normalize(field).includes(token))) ??
    fields[0] ??
    "";
  if (selected.length <= 360) return selected;
  return `${selected.slice(0, 360).trim()}…`;
}

function makeEvidenceExcerpt(item: SearchItem, searchQuery: string) {
  const fields = [item.context, item.quote, item.text, item.summary].filter(
    (value): value is string => Boolean(value),
  );
  const tokens = normalize(searchQuery)
    .split(" ")
    .filter((token) => token.length > 1 && !stopWords.has(token));
  const ordered = [
    ...fields.filter((field) => tokens.some((token) => normalize(field).includes(token))),
    ...fields,
  ];
  const unique = [...new Set(ordered)].join("\n");
  return unique.length <= 1400 ? unique : `${unique.slice(0, 1400).trim()}…`;
}

function statusLabel(value: ItemStatus) {
  if (value === "current") return "현행 확인";
  if (value === "review") return "검토 필요";
  return "원문";
}

async function deriveKey(sharedPassword: string, vault: VaultManifest) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sharedPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: bytesFromBase64(vault.kdf.salt),
      iterations: vault.kdf.iterations,
      hash: vault.kdf.hash,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function deriveAiAccessToken(sharedPassword: string) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sharedPassword),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode("mep-evidence-ai-access-v1"),
      iterations: 600_000,
      hash: "SHA-256",
    },
    material,
    256,
  );
  const binary = Array.from(new Uint8Array(bits), (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function decryptAsset(asset: VaultAsset, key: CryptoKey, vaultUrl: URL) {
  const response = await fetch(new URL(asset.path, vaultUrl));
  if (!response.ok) throw new Error("암호화 자료를 불러오지 못했습니다.");
  const encrypted = await response.arrayBuffer();
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesFromBase64(asset.iv) },
    key,
    encrypted,
  );
}

const results = computed(() => {
  if (!searchIndex.value) return [];
  const filtered = searchIndex.value.items.filter(
    (item) =>
      (kind.value === "all" || item.kind === kind.value) &&
      (status.value === "all" || item.status === status.value),
  );
  if (!query.value.trim()) {
    return filtered
      .filter((item) => item.kind === "citation" && item.officialUrl)
      .slice(0, 18)
      .map((item) => ({ item, score: 0 }));
  }
  return filtered
    .map((item) => ({ item, score: scoreItem(item, query.value) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score);
});

const totalPages = computed(() => Math.max(1, Math.ceil(results.value.length / PAGE_SIZE)));
const resultOffset = computed(() => (currentPage.value - 1) * PAGE_SIZE);
const paginatedResults = computed(() =>
  results.value.slice(resultOffset.value, resultOffset.value + PAGE_SIZE),
);
const visiblePages = computed(() => {
  if (totalPages.value <= 7) {
    return Array.from({ length: totalPages.value }, (_, index) => index + 1);
  }
  return [...new Set([
    1,
    totalPages.value,
    currentPage.value - 1,
    currentPage.value,
    currentPage.value + 1,
  ])]
    .filter((page) => page >= 1 && page <= totalPages.value)
    .sort((left, right) => left - right);
});

const aiEvidence = computed<AiEvidence[]>(() =>
  results.value
    .slice(0, 8)
    .map(({ item }) => ({
      id: item.id,
      title: item.title || item.article || item.source || "제목 없음",
      source: item.source ?? "",
      page: item.page ?? null,
      article: item.article ?? item.code ?? "",
      status: item.status,
      excerpt: makeEvidenceExcerpt(item, query.value),
      officialUrl: safeOfficialUrl(item.officialUrl),
    }))
    .filter((item) => item.excerpt),
);

async function unlock() {
  if (!manifest.value || !manifestUrl.value || unlocking.value) return;
  unlocking.value = true;
  unlockError.value = "";
  try {
    const sharedPassword = password.value;
    const [key, accessToken] = await Promise.all([
      deriveKey(sharedPassword, manifest.value),
      deriveAiAccessToken(sharedPassword),
    ]);
    const decrypted = await decryptAsset(manifest.value.assets.index, key, manifestUrl.value);
    searchIndex.value = JSON.parse(new TextDecoder().decode(decrypted)) as SearchIndex;
    cryptoKey.value = key;
    aiAccessToken.value = accessToken;
    password.value = "";
    window.setTimeout(() => searchInput.value?.focus(), 50);
  } catch {
    unlockError.value = "비밀번호가 맞지 않거나 암호화 자료가 손상되었습니다.";
  } finally {
    unlocking.value = false;
  }
}

function lock() {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
  pdfUrl.value = null;
  cryptoKey.value = null;
  searchIndex.value = null;
  query.value = "";
  kind.value = "all";
  status.value = "all";
  currentPage.value = 1;
  aiAccessToken.value = "";
  aiResult.value = null;
  aiSources.value = [];
  aiError.value = "";
  aiCostAcknowledged.value = false;
  aiUsageSummary.value = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function goToPage(page: number) {
  const nextPage = Math.min(Math.max(page, 1), totalPages.value);
  if (nextPage === currentPage.value) return;
  currentPage.value = nextPage;
  window.requestAnimationFrame(() => {
    resultsHeading.value?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function askAi() {
  const question = query.value.trim();
  if (aiLoading.value || !question || !aiCostAcknowledged.value) {
    return;
  }
  if (!aiApiUrl) {
    aiError.value = "공개 AI 중계 서버 주소가 아직 설정되지 않았습니다.";
    return;
  }
  if (!aiAccessToken.value) {
    aiError.value = "자료를 다시 잠근 뒤 비밀번호로 접속해 주세요.";
    return;
  }

  aiLoading.value = true;
  aiError.value = "";
  aiResult.value = null;
  const evidence = aiEvidence.value;
  try {
    const response = await fetch(aiApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiAccessToken.value}`,
      },
      body: JSON.stringify({ question, evidence }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof data.error === "string" ? data.error : "AI 답변을 생성하지 못했습니다.",
      );
    }
    const result = data as AiResult;
    aiResult.value = result;
    aiSources.value = evidence;
    aiUsageSummary.value = {
      requests: aiUsageSummary.value.requests + 1,
      inputTokens: aiUsageSummary.value.inputTokens + (result.usage.inputTokens ?? 0),
      outputTokens: aiUsageSummary.value.outputTokens + (result.usage.outputTokens ?? 0),
      totalTokens: aiUsageSummary.value.totalTokens + (result.usage.totalTokens ?? 0),
    };
  } catch (error) {
    aiError.value = error instanceof Error ? error.message : "AI 답변을 생성하지 못했습니다.";
  } finally {
    aiLoading.value = false;
  }
}

watch([query, kind, status], () => {
  currentPage.value = 1;
  aiResult.value = null;
  aiSources.value = [];
  aiError.value = "";
});

async function openManual(page = 1) {
  if (!manifest.value || !manifestUrl.value || !cryptoKey.value || pdfLoading.value) return;
  if (pdfUrl.value) {
    window.open(`${pdfUrl.value}#page=${page}`, "_blank", "noopener,noreferrer");
    return;
  }

  const popup = window.open("about:blank", "_blank");
  if (popup) {
    popup.document.title = "원문 PDF 여는 중";
    popup.document.body.innerHTML =
      '<p style="font:16px system-ui;padding:32px;color:#17343d">암호화된 원문 PDF를 여는 중입니다…</p>';
  }
  pdfLoading.value = true;
  try {
    const decrypted = await decryptAsset(
      manifest.value.assets.manual,
      cryptoKey.value,
      manifestUrl.value,
    );
    const url = URL.createObjectURL(
      new Blob([decrypted], { type: manifest.value.assets.manual.mime }),
    );
    pdfUrl.value = url;
    if (popup) {
      popup.opener = null;
      popup.location.href = `${url}#page=${page}`;
    } else {
      window.open(`${url}#page=${page}`, "_blank", "noopener,noreferrer");
    }
  } catch {
    if (popup) popup.close();
    unlockError.value = "PDF 원문을 복호화하지 못했습니다. 다시 잠근 뒤 접속해 주세요.";
  } finally {
    pdfLoading.value = false;
  }
}

onMounted(() => {
  const url = new URL("vault/manifest.json", window.location.href);
  manifestUrl.value = url;
  fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error("보안 자료가 아직 준비되지 않았습니다.");
      return response.json();
    })
    .then((data: VaultManifest) => {
      manifest.value = data;
    })
    .catch((error: Error) => {
      unlockError.value = error.message;
    });
});

onBeforeUnmount(() => {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
});
</script>

<template>
  <main v-if="!searchIndex" class="lock-page">
    <section class="lock-intro" aria-labelledby="lock-title">
      <div class="brand brand-light">
        <span class="brand-mark" aria-hidden="true" />
        <span>MEP EVIDENCE</span>
      </div>
      <p class="eyebrow">기계설비 설계 근거 라이브러리</p>
      <h1 id="lock-title">설계 판단의 시작을<br /><em>근거</em>에서.</h1>
      <p class="lock-lead">
        매뉴얼, 법령, KDS·KCS를 하나의 검색창에서 찾고 원문까지 추적합니다.
      </p>
      <div class="lock-stats" aria-label="검색 자료 현황">
        <div class="stat"><strong>{{ (manifest?.summary.pages ?? 466).toLocaleString("ko-KR") }}</strong><span>PDF 쪽</span></div>
        <div class="stat"><strong>{{ (manifest?.summary.citations ?? 1310).toLocaleString("ko-KR") }}</strong><span>인용 근거</span></div>
        <div class="stat"><strong>{{ (manifest?.summary.articles ?? 438).toLocaleString("ko-KR") }}</strong><span>현행 조문</span></div>
      </div>
      <p class="source-date">자료 현행화 기준 · {{ manifest?.summary.snapshotDate ?? "2026-07-17" }}</p>
    </section>

    <section class="unlock-panel" aria-labelledby="unlock-title">
      <div class="unlock-card">
        <div class="secure-badge"><span aria-hidden="true">●</span> 암호화 자료실</div>
        <h2 id="unlock-title">공유 비밀번호로 접속</h2>
        <p>전달받은 비밀번호를 입력하세요. 입력값은 서버로 전송하거나 저장하지 않습니다.</p>
        <form @submit.prevent="unlock">
          <label for="password">비밀번호</label>
          <div class="password-field">
            <input
              id="password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              minlength="16"
              autocomplete="current-password"
              placeholder="16자 이상 공유 비밀번호"
              required
              autofocus
            />
            <button type="button" @click="showPassword = !showPassword">
              {{ showPassword ? "숨김" : "표시" }}
            </button>
          </div>
          <button class="primary-button" type="submit" :disabled="!manifest || unlocking">
            {{ unlocking ? "자료 여는 중…" : "근거검색 시작" }}<span aria-hidden="true">→</span>
          </button>
        </form>
        <p v-if="unlockError" class="form-error" role="alert">{{ unlockError }}</p>
        <div class="security-note">
          <div>
            <strong>브라우저 안에서만 복호화</strong>
            <span>GitHub에는 암호화된 PDF와 검색 데이터만 저장됩니다.</span>
          </div>
        </div>
      </div>
      <p class="legal-note">공용 PC에서는 사용 후 반드시 자료를 잠가 주세요.</p>
    </section>
  </main>

  <main v-else class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true" />
        <span>설비 근거검색</span>
        <small>MEP EVIDENCE</small>
      </div>
      <div class="topbar-actions">
        <span class="snapshot"><i /> 현행화 {{ searchIndex.meta.snapshotDate }}</span>
        <button class="text-button" type="button" @click="lock">자료 잠금</button>
      </div>
    </header>

    <section class="search-hero" aria-labelledby="search-title">
      <div>
        <p class="eyebrow">EVIDENCE-FIRST SEARCH</p>
        <h1 id="search-title">어떤 설계 근거가 필요하신가요?</h1>
        <p>질문, 설비 용어, 법령명 또는 KDS·KCS 코드를 입력하세요.</p>
      </div>
      <div class="hero-stats" aria-label="자료 현황">
        <div class="stat"><strong>{{ searchIndex.meta.pages.toLocaleString("ko-KR") }}</strong><span>PDF 쪽</span></div>
        <div class="stat"><strong>{{ searchIndex.meta.citations.toLocaleString("ko-KR") }}</strong><span>인용 위치</span></div>
        <div class="stat"><strong>{{ searchIndex.meta.articles.toLocaleString("ko-KR") }}</strong><span>조문·기준</span></div>
        <div class="stat"><strong>{{ searchIndex.meta.reviews.toLocaleString("ko-KR") }}</strong><span>검토 대상</span></div>
      </div>
    </section>

    <section class="search-area">
      <div class="search-box">
        <span class="search-symbol" aria-hidden="true" />
        <label class="sr-only" for="search">설계 근거 검색</label>
        <input
          id="search"
          ref="searchInput"
          v-model="query"
          type="search"
          placeholder="예: 급수관 관경 결정 기준과 관련 조문"
          autocomplete="off"
        />
        <button v-if="query" class="clear-button" type="button" @click="query = ''">지우기</button>
      </div>
      <div class="quick-queries" aria-label="추천 검색어">
        <span>추천</span>
        <button v-for="quickQuery in quickQueries" :key="quickQuery" type="button" @click="query = quickQuery">
          {{ quickQuery }}
        </button>
      </div>
    </section>

    <div class="workspace">
      <aside class="filters" aria-label="검색 필터">
        <div class="filter-block">
          <h2>자료 종류</h2>
          <button :class="{ active: kind === 'all' }" type="button" @click="kind = 'all'">
            <span>전체 근거</span><small>{{ searchIndex.items.length.toLocaleString("ko-KR") }}</small>
          </button>
          <button
            v-for="value in (['manual', 'citation', 'article', 'instrument'] as ItemKind[])"
            :key="value"
            :class="{ active: kind === value }"
            type="button"
            @click="kind = value"
          >
            <span>{{ kindLabels[value] }}</span>
          </button>
        </div>
        <div class="filter-block">
          <h2>확인 상태</h2>
          <button :class="{ active: status === 'all' }" type="button" @click="status = 'all'"><span>전체</span></button>
          <button :class="{ active: status === 'current' }" type="button" @click="status = 'current'"><span>현행 확인</span></button>
          <button :class="{ active: status === 'review' }" type="button" @click="status = 'review'"><span>검토 필요</span></button>
          <button :class="{ active: status === 'source' }" type="button" @click="status = 'source'"><span>원문 자료</span></button>
        </div>
        <div class="scope-card">
          <strong>검색 범위</strong>
          <span>기계설비 기술기준 매뉴얼</span>
          <small>원문 2022.05 · 현행화 {{ searchIndex.meta.snapshotDate }}</small>
        </div>
      </aside>

      <section class="results" aria-live="polite">
        <section class="ai-panel" aria-labelledby="ai-panel-title">
          <div class="ai-panel-header">
            <div>
              <span class="ai-kicker">OPENAI · GROUNDED ANSWER</span>
              <h2 id="ai-panel-title">검색 근거로 AI 답변 만들기</h2>
            </div>
            <span :class="['ai-state', { ready: aiApiUrl }]">
              {{ aiApiUrl ? "연결 준비" : "공개 서버 준비 중" }}
            </span>
          </div>
          <p class="ai-description">
            공개 매뉴얼 의미검색과 현재 검색 결과 중 관련도 높은 최대 8건을 함께 사용합니다.
            OpenAI 비밀키와 원문 PDF는 브라우저로 전달하지 않습니다.
          </p>
          <div class="ai-cost-notice" role="note" aria-labelledby="ai-cost-title">
            <div class="ai-cost-copy">
              <span class="ai-cost-symbol" aria-hidden="true">!</span>
              <div>
                <strong id="ai-cost-title">질문을 전송할 때마다 OpenAI API 이용료가 발생합니다.</strong>
                <p>
                  질문과 후속 질문은 각각 별도 API 호출이며 매뉴얼 File Search 호출료가 추가될 수
                  있습니다. 실제 비용은 사용 토큰과 모델 가격에 따라 달라집니다.
                </p>
              </div>
            </div>
            <div v-if="aiUsageSummary.requests" class="ai-usage-summary" aria-label="현재 접속 사용량">
              <span><strong>{{ aiUsageSummary.requests.toLocaleString("ko-KR") }}</strong>회 질문</span>
              <span><strong>{{ aiUsageSummary.inputTokens.toLocaleString("ko-KR") }}</strong>입력 토큰</span>
              <span><strong>{{ aiUsageSummary.outputTokens.toLocaleString("ko-KR") }}</strong>출력 토큰</span>
              <span><strong>{{ aiUsageSummary.totalTokens.toLocaleString("ko-KR") }}</strong>합계 토큰</span>
            </div>
            <label class="ai-cost-confirm">
              <input v-model="aiCostAcknowledged" type="checkbox" />
              <span>API 이용료가 발생할 수 있음을 확인했습니다.</span>
            </label>
          </div>
          <div class="ai-action-row">
            <div>
              <strong>공개 매뉴얼 의미검색 + {{ aiEvidence.length }}건의 로컬 근거</strong>
              <span v-if="!query.trim()">먼저 위 검색창에 질문을 입력하세요.</span>
              <span v-else-if="!aiCostAcknowledged">위 비용 안내를 확인한 뒤 질문을 전송할 수 있습니다.</span>
              <span v-else-if="aiEvidence.length === 0">로컬 결과가 없어도 공개 매뉴얼에서 의미검색합니다.</span>
              <span v-else>AI가 매뉴얼과 로컬 근거를 함께 비교합니다.</span>
            </div>
            <button
              class="ai-button"
              type="button"
              :disabled="!query.trim() || aiLoading || !aiApiUrl || !aiCostAcknowledged"
              @click="askAi"
            >
              {{ aiLoading ? "API 사용 중…" : "비용 발생 · AI 답변 생성" }}
              <span aria-hidden="true">→</span>
            </button>
          </div>

          <p v-if="aiError" class="ai-error" role="alert">{{ aiError }}</p>

          <div v-if="aiResult" class="ai-answer">
            <div class="ai-answer-meta">
              <strong>AI 답변</strong>
              <span>
                {{ aiResult.model }}
                <template v-if="aiResult.usage.totalTokens">
                  · {{ aiResult.usage.totalTokens.toLocaleString("ko-KR") }} tokens
                </template>
              </span>
            </div>
            <p class="ai-answer-copy">{{ aiResult.answer }}</p>
            <p
              v-if="aiResult.completion?.status === 'incomplete'"
              class="ai-search-state"
              role="status"
            >
              <template v-if="aiResult.completion.reason === 'max_output_tokens'">
                AI 답변이 최대 길이에 도달해 일부가 생략됐을 수 있습니다. 질문 범위를 나누어
                다시 질문해 주세요.
              </template>
              <template v-else>
                AI 응답이 완전히 생성되지 않았습니다. 중요한 내용은 원문 근거에서 확인해 주세요.
              </template>
            </p>
            <div
              v-if="aiResult.manualSources?.length"
              class="ai-source-section"
              aria-label="OpenAI 매뉴얼 의미검색 근거"
            >
              <p class="ai-source-heading">
                <strong>매뉴얼 의미검색 근거</strong>
                <span>{{ aiResult.manualSources.length }}건 · 2022.05 공개 매뉴얼</span>
              </p>
              <div class="ai-source-list">
                <article v-for="source in aiResult.manualSources" :key="source.fileId || source.filename">
                  <strong>{{ source.title }}</strong>
                  <span>
                    {{ source.page ? `PDF ${source.page}쪽` : source.filename }}
                    <template v-if="source.score !== null"> · 검색점수 {{ source.score.toFixed(2) }}</template>
                  </span>
                  <p v-if="source.excerpt" class="ai-source-excerpt">{{ source.excerpt }}</p>
                  <div>
                    <button v-if="source.page" type="button" @click="openManual(source.page)">
                      PDF 원문 ↗
                    </button>
                  </div>
                </article>
              </div>
            </div>
            <p v-else-if="aiResult.fileSearch?.status === 'fallback'" class="ai-search-state">
              매뉴얼 의미검색을 사용할 수 없어 로컬 검색 근거만으로 답변했습니다.
            </p>
            <p
              v-if="aiResult.manualCitationCheck?.status === 'mismatch'"
              class="ai-search-state"
            >
              답변의 매뉴얼 쪽수와 검색된 PDF 쪽수가 일치하지 않습니다. 아래 PDF 원문 버튼으로
              내용을 직접 확인해 주세요.
            </p>
            <div v-if="aiSources.length" class="ai-source-section" aria-label="브라우저 검색 근거">
              <p class="ai-source-heading">
                <strong>현행 법령·로컬 검색 근거</strong>
                <span>{{ aiSources.length }}건</span>
              </p>
              <div class="ai-source-list">
              <article v-for="(source, sourceIndex) in aiSources" :key="source.id">
                <strong>[근거 {{ sourceIndex + 1 }}] {{ source.title }}</strong>
                <span>
                  {{ [source.source, source.page ? `PDF ${source.page}쪽` : ""].filter(Boolean).join(" · ") }}
                </span>
                <div>
                  <button v-if="source.page" type="button" @click="openManual(source.page)">
                    PDF 원문 ↗
                  </button>
                  <a v-if="source.officialUrl" :href="source.officialUrl" target="_blank" rel="noreferrer">
                    공식 원문 ↗
                  </a>
                </div>
              </article>
              </div>
            </div>
            <p class="ai-caution">
              AI 답변은 검색 보조 자료입니다. 최종 설계값과 적용 조문은 원문·발주 조건·관할 기관에서
              다시 확인하세요.
            </p>
          </div>
        </section>

        <div ref="resultsHeading" class="results-heading">
          <div>
            <p>{{ query ? `“${query}” 검색 결과` : "주요 공식 근거" }}</p>
            <strong>{{ results.length.toLocaleString("ko-KR") }}건</strong>
          </div>
          <span v-if="results.length">
            관련도순 · {{ (resultOffset + 1).toLocaleString("ko-KR") }}–{{
              Math.min(resultOffset + PAGE_SIZE, results.length).toLocaleString("ko-KR")
            }}건 표시
          </span>
        </div>

        <div v-if="results.length === 0" class="empty-state">
          <span aria-hidden="true">?</span>
          <h2>일치하는 근거를 찾지 못했습니다.</h2>
          <p>설비 용어를 짧게 입력하거나 법령명·KDS/KCS 코드로 다시 검색해 보세요.</p>
        </div>

        <div v-else class="result-list">
          <article
            v-for="({ item, score }, indexNumber) in paginatedResults"
            :key="`${item.kind}-${item.id}`"
            class="result-card"
          >
            <div class="result-index">{{ String(resultOffset + indexNumber + 1).padStart(2, "0") }}</div>
            <div class="result-content">
              <div class="result-meta">
                <span :class="['kind', `kind-${item.kind}`]">{{ kindLabels[item.kind] }}</span>
                <span :class="['status', `status-${item.status}`]">{{ statusLabel(item.status) }}</span>
                <span v-if="item.page">PDF {{ item.page }}쪽</span>
                <span v-if="score > 0">관련도 {{ Math.min(99, score) }}점</span>
              </div>
              <h2>{{ item.title || item.article || item.source }}</h2>
              <p class="breadcrumb">{{ [item.source, item.article, item.section].filter(Boolean).join("  /  ") }}</p>
              <p class="snippet">{{ makeSnippet(item, query) }}</p>
              <p v-if="item.reviewReason" class="review-reason"><strong>검토 사유</strong> {{ item.reviewReason }}</p>
              <div class="result-actions">
                <button v-if="item.page" type="button" :disabled="pdfLoading" @click="openManual(item.page || 1)">
                  {{ pdfLoading ? "PDF 여는 중…" : `원문 ${item.page}쪽` }} <span aria-hidden="true">↗</span>
                </button>
                <a
                  v-if="safeOfficialUrl(item.officialUrl)"
                  :href="safeOfficialUrl(item.officialUrl)"
                  target="_blank"
                  rel="noreferrer"
                >
                  공식 원문 <span aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
          </article>
        </div>

        <nav v-if="results.length && totalPages > 1" class="pagination" aria-label="검색 결과 페이지">
          <button
            class="pagination-nav"
            type="button"
            :disabled="currentPage === 1"
            aria-label="이전 검색 결과 페이지"
            @click="goToPage(currentPage - 1)"
          >
            ← 이전
          </button>
          <template v-for="(page, pageIndex) in visiblePages" :key="page">
            <span
              v-if="pageIndex > 0 && page - visiblePages[pageIndex - 1] > 1"
              class="pagination-ellipsis"
              aria-hidden="true"
            >
              …
            </span>
            <button
              type="button"
              :class="{ active: currentPage === page }"
              :aria-current="currentPage === page ? 'page' : undefined"
              :aria-label="`${page}페이지`"
              @click="goToPage(page)"
            >
              {{ page }}
            </button>
          </template>
          <button
            class="pagination-nav"
            type="button"
            :disabled="currentPage === totalPages"
            aria-label="다음 검색 결과 페이지"
            @click="goToPage(currentPage + 1)"
          >
            다음 →
          </button>
        </nav>
      </section>
    </div>

    <footer class="app-footer">
      <p><strong>주의</strong> {{ searchIndex.meta.notice }}</p>
      <span>원문 {{ searchIndex.meta.sourceDate }} · 데이터 {{ searchIndex.meta.snapshotDate }}</span>
    </footer>
  </main>
</template>

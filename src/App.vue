<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

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
const pdfLoading = ref(false);
const pdfUrl = ref<string | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);

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
    .sort((left, right) => right.score - left.score)
    .slice(0, 60);
});

async function unlock() {
  if (!manifest.value || !manifestUrl.value || unlocking.value) return;
  unlocking.value = true;
  unlockError.value = "";
  try {
    const key = await deriveKey(password.value, manifest.value);
    const decrypted = await decryptAsset(manifest.value.assets.index, key, manifestUrl.value);
    searchIndex.value = JSON.parse(new TextDecoder().decode(decrypted)) as SearchIndex;
    cryptoKey.value = key;
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
}

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
        <div class="results-heading">
          <div>
            <p>{{ query ? `“${query}” 검색 결과` : "주요 공식 근거" }}</p>
            <strong>{{ results.length.toLocaleString("ko-KR") }}건</strong>
          </div>
          <span>관련도순 · 최대 60건</span>
        </div>

        <div v-if="results.length === 0" class="empty-state">
          <span aria-hidden="true">?</span>
          <h2>일치하는 근거를 찾지 못했습니다.</h2>
          <p>설비 용어를 짧게 입력하거나 법령명·KDS/KCS 코드로 다시 검색해 보세요.</p>
        </div>

        <div v-else class="result-list">
          <article
            v-for="({ item, score }, indexNumber) in results"
            :key="`${item.kind}-${item.id}`"
            class="result-card"
          >
            <div class="result-index">{{ String(indexNumber + 1).padStart(2, "0") }}</div>
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
                <a v-if="item.officialUrl" :href="item.officialUrl" target="_blank" rel="noreferrer">
                  공식 원문 <span aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>

    <footer class="app-footer">
      <p><strong>주의</strong> {{ searchIndex.meta.notice }}</p>
      <span>원문 {{ searchIndex.meta.sourceDate }} · 데이터 {{ searchIndex.meta.snapshotDate }}</span>
    </footer>
  </main>
</template>

const app = document.getElementById("app");
const pageNumbers = document.getElementById("pageNumbers");
const paginationWrap = document.getElementById("paginationWrap");
const template = document.getElementById("cardTemplate");
const heroSlider = document.getElementById("heroSlider");
const sidebarTrending = document.getElementById("sidebarTrending");

const searchInput = document.getElementById("searchInput");
const dateFilter = document.getElementById("dateFilter");
const yearFilter = document.getElementById("yearFilter");
const monthFilter = document.getElementById("monthFilter");
const platformInput = document.getElementById("platformInput");
const presetSelect = document.getElementById("presetSelect");
const categoryFilter = document.getElementById("categoryFilter");

const FALLBACK_POSTER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='600' viewBox='0 0 400 600'%3E%3Crect width='400' height='600' fill='%230f1629'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%239fb0d7' font-size='28' font-family='Arial'%3ENo Poster%3C/text%3E%3C/svg%3E";

const state = {
  items: [],
  filtered: [],
  page: 1,
  pageSize: 24,
  itemCache: new Map(),
  sliderItems: [],
  sliderIndex: 0,
  sliderTimer: null,
  hblinksSearchCache: new Map(),
  hblinksPostCache: new Map(),
};

const COLLECTION_FALLBACKS = ["movies", "series", "anime"];
const PRESET_TO_ROUTE = {
  all: null,
  recent: "/api/recent",
  trending_movies: "/api/trending/movies",
  anime_feed: "/api/trending/anime",
  holly_movies: "/api/trending/movies",
  bolly_movies: "/api/trending/bolly_movies",
  holly_series: "/api/trending/series",
  bolly_series: "/api/trending/bolly_series",
};

function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function parseDateParts(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    dateIso: date.toISOString().slice(0, 10),
  };
}

function formatDateTime(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "N/A";
  const datePart = date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${datePart}, ${timePart}`;
}

function cleanKeywordFromTitle(title) {
  const raw = String(title || "").trim();
  const match = raw.match(/^(.+?\(\d{4}\))/);
  return (match ? match[1] : raw).slice(0, 80);
}

function parseCategories(rawCategories) {
  return String(rawCategories || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeResponse(payload, collectionHint = "") {
  const nested = payload?.data || payload?.results || payload?.items || payload?.docs;
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(nested)
    ? nested
    : payload && typeof payload === "object"
    ? [payload]
    : [];

  if (!Array.isArray(list)) return [];

  return list
    .map((raw, idx) => {
      const id = raw.id || raw._id || raw.slug || raw.postId || `${raw.title || "item"}-${idx}`;
      const title = raw.title || raw.name || raw.movieTitle || "Untitled";
      const date = raw.date || raw.release_date || raw.createdAt || raw.updatedAt || "";
      const featured_image = raw.featured_image || raw.poster || raw.image || raw.thumbnail || raw.imageUrl || "";
      const links = raw.links || raw.downloadLinks || "";
      const categoriesRaw = raw.categories || raw.category || raw.genre || "";
      const categories = parseCategories(categoriesRaw);
      const contentType = raw.contentType || raw.type || raw.collection || collectionHint || "unknown";
      const collection = raw.collection || raw.contentType || collectionHint || "movies";

      const item = { id: String(id), title, date, featured_image, links, categories, categoriesRaw, contentType, collection, raw };
      state.itemCache.set(`${item.collection}:${item.id}`, item);
      return item;
    })
    .filter((item) => item.title);
}

async function fetchJson(path) {
  const token = await getProxyToken(path);
  const headers = {
    Accept: "application/json",
    "X-Proxy-Token": token,
    "X-Requested-With": "XMLHttpRequest",
  };

  const res = await fetch(path, {
    method: "GET",
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });

  if (res.status === 401) {
    const retryToken = await getProxyToken(path);
    const retry = await fetch(path, {
      method: "GET",
      headers: { ...headers, "X-Proxy-Token": retryToken },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!retry.ok) throw new Error("Request failed.");
    return retry.json();
  }

  if (!res.ok) throw new Error("Request failed.");
  return res.json();
}

function getTokenPath(path) {
  const url = new URL(path, window.location.origin);
  const tokenPath = url.pathname.startsWith("/api/") ? url.pathname.slice(4) : url.pathname;
  return tokenPath.startsWith("/") ? tokenPath : `/${tokenPath}`;
}

async function getProxyToken(path) {
  const qs = new URLSearchParams({ path: getTokenPath(path) });
  const res = await fetch(`/api/token?${qs.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    credentials: "same-origin",
    cache: "no-store",
  });

  if (!res.ok) throw new Error("Request failed.");
  const data = await res.json();
  if (!data || typeof data.token !== "string") throw new Error("Request failed.");
  return data.token;
}

async function loadItems() {
  const category = presetSelect?.value || "all";
  const searchTerm = searchInput.value.trim();
  const platform = platformInput.value.trim();
  const tasks = [];
  const presetRoute = PRESET_TO_ROUTE[category];

  if (searchTerm) {
    tasks.push(fetchJson(`/api/search/${encodeURIComponent(searchTerm)}`));
  } else if (presetRoute) {
    tasks.push(fetchJson(presetRoute));
  } else if (["movies", "series", "anime"].includes(platform.toLowerCase())) {
    tasks.push(fetchJson(`/api/${encodeURIComponent(platform.toLowerCase())}`));
  } else {
    tasks.push(fetchJson("/api/trending"));
    tasks.push(fetchJson("/api/recent"));
    for (const c of COLLECTION_FALLBACKS) tasks.push(fetchJson(`/api/${c}`));
  }

  const settled = await Promise.allSettled(tasks);
  const merged = [];

  settled.forEach((result, i) => {
    if (result.status !== "fulfilled") return;
    const hint = searchTerm ? "search" : category === "all" ? ["trending", "recent", ...COLLECTION_FALLBACKS][i] || "all" : category;
    merged.push(...normalizeResponse(result.value, hint));
  });

  const unique = new Map();
  for (const item of merged) {
    const key = `${item.collection}:${item.id}:${item.title}`;
    if (!unique.has(key)) unique.set(key, item);
  }

  state.items = Array.from(unique.values());
}

async function loadSidebarTrending() {
  if (!sidebarTrending) return;
  try {
    const trendingData = await fetchJson("/api/trending/movies");
    const trendingItems = normalizeResponse(trendingData, "trending").slice(0, 14);

    sidebarTrending.innerHTML = `
      <section>
        <h3 class="side-group-title">Trending Movies</h3>
        ${trendingItems.map((item) => `
          <article class="side-item" data-collection="${safeText(item.collection)}" data-id="${safeText(item.id)}">
            <img src="${safeText(item.featured_image || FALLBACK_POSTER)}" alt="${safeText(item.title)}" loading="lazy" />
            <p>${safeText(item.title)}</p>
          </article>
        `).join("")}
      </section>
    `;

    sidebarTrending.querySelectorAll(".side-item").forEach((el) => {
      el.addEventListener("click", () => {
        window.location.hash = `#/post/${encodeURIComponent(el.dataset.collection || "movies")}/${encodeURIComponent(el.dataset.id || "")}`;
      });
    });
  } catch {
    sidebarTrending.innerHTML = '<p class="status">Unable to load trending list.</p>';
  }
}

function normalizeSliderPayload(payload) {
  const list = Array.isArray(payload) ? payload : payload?.data || payload?.results || payload?.items || [];
  if (!Array.isArray(list)) return [];

  return list
    .map((raw) => {
      const image = raw.image || raw.poster || raw.featured_image || raw.thumbnail || raw.cover || "";
      const year = raw.year || raw.releaseYear || raw.release_date || raw.date || "";
      return {
        image,
        year: String(year || "").slice(0, 4),
      };
    })
    .filter((x) => x.image)
    .slice(0, 8);
}

async function loadSlider() {
  try {
    const data = await fetchJson("/api/ext/slider");
    state.sliderItems = normalizeSliderPayload(data);

    if (state.sliderItems.length === 0) {
      const trend = await fetchJson("/api/trending");
      state.sliderItems = normalizeResponse(trend, "trending").slice(0, 8).map((x) => ({ image: x.featured_image, year: parseDateParts(x.date)?.year || "" })).filter((x) => x.image);
    }
  } catch {
    state.sliderItems = [];
  }

  renderSlider();
}

function renderSlider() {
  if (!heroSlider) return;
  if (!state.sliderItems.length) {
    heroSlider.innerHTML = '<p class="status">No slider data.</p>';
    return;
  }

  heroSlider.innerHTML = state.sliderItems
    .map((item, idx) => `
      <div class="slide${idx === state.sliderIndex ? " active" : ""}">
        <img src="${safeText(item.image)}" alt="Slider ${idx + 1}" loading="lazy" />
        <span class="year-badge">${safeText(item.year || "Year N/A")}</span>
      </div>
    `)
    .join("");

  if (state.sliderTimer) clearInterval(state.sliderTimer);
  state.sliderTimer = setInterval(() => {
    state.sliderIndex = (state.sliderIndex + 1) % state.sliderItems.length;
    renderSlider();
  }, 3800);
}

function applyLocalFilters() {
  const term = searchInput.value.trim().toLowerCase();
  const year = yearFilter.value;
  const month = monthFilter.value;
  const exactDate = dateFilter.value;
  const categorySelected = (categoryFilter?.value || "").toLowerCase();

  state.filtered = state.items.filter((item) => {
    const hay = `${item.title} ${item.contentType} ${(item.categories || []).join(" ")}`.toLowerCase();
    if (term && !hay.includes(term)) return false;
    if (categorySelected && !(item.categories || []).some((c) => c.toLowerCase() === categorySelected)) return false;

    const parts = parseDateParts(item.date);
    if (year && (!parts || parts.year !== year)) return false;
    if (month && (!parts || parts.month !== month)) return false;
    if (exactDate && (!parts || parts.dateIso !== exactDate)) return false;

    return true;
  });

  state.filtered.sort((a, b) => {
    const da = new Date(a.date).getTime() || 0;
    const db = new Date(b.date).getTime() || 0;
    return db - da;
  });
}

function syncCategoryOptions() {
  if (!categoryFilter) return;
  const current = categoryFilter.value;
  const set = new Set();

  for (const item of state.items) {
    for (const cat of item.categories || []) set.add(cat);
  }

  const options = Array.from(set).sort((a, b) => a.localeCompare(b));
  categoryFilter.innerHTML = `<option value="">All Categories</option>${options
    .map((c) => `<option value="${safeText(c)}">${safeText(c)}</option>`)
    .join("")}`;
  if (options.includes(current)) categoryFilter.value = current;
}

function setCategoryByPriority(candidates) {
  if (!categoryFilter) return false;
  const options = Array.from(categoryFilter.options || []).map((o) => o.value);
  const found = candidates.find((c) => options.includes(c));
  if (!found) return false;
  categoryFilter.value = found;
  return true;
}

function syncFilterOptions() {
  const years = new Set();
  for (const item of state.items) {
    const parts = parseDateParts(item.date);
    if (parts?.year) years.add(parts.year);
  }

  const currentYear = yearFilter.value;
  const ordered = Array.from(years).sort((a, b) => Number(b) - Number(a));
  yearFilter.innerHTML = `<option value="">All Years</option>${ordered.map((year) => `<option value="${safeText(year)}">${safeText(year)}</option>`).join("")}`;
  if (ordered.includes(currentYear)) yearFilter.value = currentYear;

  const monthLabels = [["01", "January"], ["02", "February"], ["03", "March"], ["04", "April"], ["05", "May"], ["06", "June"], ["07", "July"], ["08", "August"], ["09", "September"], ["10", "October"], ["11", "November"], ["12", "December"]];
  const currentMonth = monthFilter.value;
  monthFilter.innerHTML = `<option value="">All Months</option>${monthLabels.map(([val, label]) => `<option value="${val}">${label}</option>`).join("")}`;
  monthFilter.value = currentMonth;
}

function renderList() {
  if (!app || !template || !paginationWrap) return;
  paginationWrap.hidden = false;
  applyLocalFilters();

  const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;

  const start = (state.page - 1) * state.pageSize;
  const pageItems = state.filtered.slice(start, start + state.pageSize);

  if (pageItems.length === 0) {
    app.innerHTML = `<p class="status">No content found for current filters.</p>`;
  } else {
    const grid = document.createElement("section");
    grid.className = "grid";

    pageItems.forEach((item) => {
      const card = template.content.firstElementChild.cloneNode(true);
      const img = card.querySelector(".poster");
      img.src = item.featured_image || FALLBACK_POSTER;
      img.alt = item.title;
      img.addEventListener("error", () => { img.src = FALLBACK_POSTER; }, { once: true });

      card.querySelector(".title").textContent = item.title;
      card.querySelector(".date").textContent = `Uploaded: ${formatDateTime(item.date)}`;
      card.addEventListener("click", () => {
        window.location.hash = `#/post/${encodeURIComponent(item.collection)}/${encodeURIComponent(item.id)}`;
      });

      grid.appendChild(card);
    });

    app.innerHTML = "";
    app.appendChild(grid);
  }

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const prev = document.getElementById("prevPage");
  const next = document.getElementById("nextPage");
  const goInput = document.getElementById("goPageInput");
  if (!prev || !next || !goInput || !pageNumbers) return;

  prev.disabled = state.page <= 1;
  next.disabled = state.page >= totalPages;
  goInput.max = String(totalPages);
  goInput.value = String(state.page);

  const start = Math.max(1, state.page - 2);
  const end = Math.min(totalPages, start + 4);

  pageNumbers.innerHTML = "";
  for (let i = start; i <= end; i += 1) {
    const btn = document.createElement("button");
    btn.className = `btn ghost page-number${i === state.page ? " active" : ""}`;
    btn.textContent = String(i);
    btn.addEventListener("click", () => {
      state.page = i;
      renderList();
    });
    pageNumbers.appendChild(btn);
  }
}

function parseLinks(links) {
  if (!links || typeof links !== "string") return [];

  return links
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((p) => p.trim()).filter(Boolean);
      const firstToken = parts[0] || "";
      const title = parts.length >= 2 ? parts[parts.length - 2] : "Download";
      const size = parts.length >= 1 ? parts[parts.length - 1] : "";

      const wrapped = firstToken.match(/vcloud=(https?:\/\/[^,\s]+)/i)?.[1] || "";
      const decoded = wrapped ? decodeURIComponent(wrapped) : firstToken;
      const url = decoded.includes("vcloud.zip/") ? decoded : "";

      const quality = title.match(/\b(480p|720p|1080p|2160p|4k)\b/i)?.[1] || "";
      const season = Number(title.match(/season\s*([0-9]+)/i)?.[1] || NaN);
      const label = `Vcloud${quality ? ` ${quality}` : ""}${size ? ` [${size.replace(/^\[|\]$/g, "")}]` : ""}`.trim();

      return { title, url, label: label || "Vcloud", season: Number.isFinite(season) ? season : null };
    })
    .filter((entry) => entry.url);
}

function extractVcloudUrl(input) {
  const source = String(input || "");
  const wrapped = source.match(/vcloud=(https?:\/\/[^\s,]+)/i)?.[1] || "";
  const decoded = wrapped ? decodeURIComponent(wrapped) : source;
  return decoded.includes("vcloud.zip/") ? decoded : "";
}

function qualityFromText(text, fallback = "") {
  return text.match(/\b(480p|720p|1080p|2160p|4k)\b/i)?.[1] || fallback;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "vcloud";
  }
}

function parseSeasonBlock(rawText, seasonNumber) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const seasonTitle = lines[0] || `Season ${seasonNumber}`;
  const body = lines.slice(1).join("\n") || text;
  const episodes = [];

  const re = /Episode\s*([0-9]+)\s*:\s*([\s\S]*?)(?=Episode\s*[0-9]+\s*:|$)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const epNum = Number(m[1]);
    const chunk = m[2] || "";
    const sources = [];
    const used = new Set();

    const qre = /(480p|720p|1080p|2160p|4k)\s*:\s*(https?:\/\/[^\s,]+)\s*,\s*([0-9.]+\s*(?:MB|GB))/gi;
    let qm;
    while ((qm = qre.exec(chunk)) !== null) {
      const url = extractVcloudUrl(qm[2]);
      if (!url || used.has(url)) continue;
      used.add(url);
      sources.push({ quality: qm[1], size: qm[3], url });
    }

    const firstPair = chunk.match(/(https?:\/\/[^\s,]+)\s*,\s*([0-9.]+\s*(?:MB|GB))/i);
    if (firstPair) {
      const firstUrl = extractVcloudUrl(firstPair[1]);
      if (firstUrl && !used.has(firstUrl)) {
        const inferredQ = qualityFromText(seasonTitle, "480p");
        used.add(firstUrl);
        sources.unshift({ quality: inferredQ, size: firstPair[2], url: firstUrl });
      }
    }

    if (Number.isFinite(epNum) && sources.length) {
      episodes.push({ episode: epNum, sources });
    }
  }

  return { season: seasonNumber, title: seasonTitle, episodes };
}

function parseSeasonMapFromItem(item) {
  const out = new Map();
  const raw = item?.raw || {};
  for (const [key, value] of Object.entries(raw)) {
    const sm = key.match(/^season[_\s-]?([0-9]+)$/i);
    if (!sm) continue;
    const seasonNo = Number(sm[1]);
    const parsed = parseSeasonBlock(value, seasonNo);
    if (parsed && parsed.episodes.length) out.set(seasonNo, parsed);
  }
  return out;
}

function extractLinksFromRenderedHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html || ""), "text/html");
  return Array.from(doc.querySelectorAll("a[href]"))
    .map((a) => ({
      href: a.getAttribute("href") || "",
      text: (a.textContent || "").trim() || (() => {
        try { return new URL(a.href).hostname; } catch { return "Open Link"; }
      })(),
    }))
    .filter((x) => /^https?:\/\//i.test(x.href));
}

async function fetchItem(collection, id) {
  const key = `${collection}:${id}`;
  if (state.itemCache.has(key)) return state.itemCache.get(key);
  try {
    const data = await fetchJson(`/api/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
    return normalizeResponse(data, collection)[0] || null;
  } catch {
    return null;
  }
}

async function loadHblinksSearchForItem(item) {
  const key = `${item.collection}:${item.id}`;
  if (state.hblinksSearchCache.has(key)) return state.hblinksSearchCache.get(key);

  const keyword = cleanKeywordFromTitle(item.title);
  if (!keyword) return [];

  try {
    const data = await fetchJson(`/api/ext/hblinks-search?keyword=${encodeURIComponent(keyword)}`);
    const rows = Array.isArray(data) ? data : data?.results || [];
    const mapped = rows
      .map((row) => ({
        id: Number(row.id || 0),
        title: String(row.title || row.name || "Untitled").replace(/<[^>]*>/g, ""),
        subtype: String(row.subtype || ""),
      }))
      .filter((x) => Number.isFinite(x.id) && x.id > 0);

    state.hblinksSearchCache.set(key, mapped);
    return mapped;
  } catch {
    return [];
  }
}

async function loadHblinksPost(id) {
  if (state.hblinksPostCache.has(id)) return state.hblinksPostCache.get(id);

  const data = await fetchJson(`/api/ext/hblinks-post/${encodeURIComponent(String(id))}`);
  const post = Array.isArray(data) ? data[0] : data;

  const result = {
    id: Number(post?.id || id),
    title: String(post?.title?.rendered || post?.title || `Post ${id}`).replace(/<[^>]*>/g, ""),
    date: String(post?.date || ""),
    links: extractLinksFromRenderedHtml(post?.content?.rendered || ""),
  };

  state.hblinksPostCache.set(id, result);
  return result;
}

function renderDetailView(item, links, seasonSelected, hblinksRows = []) {
  const seasonMap = parseSeasonMapFromItem(item);
  const seasonNums = Array.from(seasonMap.keys()).sort((a, b) => a - b);
  const categoriesHtml = (item.categories || [])
    .map((c) => `<span class="cat-chip">${safeText(c)}</span>`)
    .join("");

  let linksHtml = "";

  if (seasonNums.length && !seasonSelected) {
    linksHtml = `
      <div class="link-row">
        <p><strong>Available seasons</strong></p>
        ${seasonNums.map((n) => `
          <p><a href="#/post/${encodeURIComponent(item.collection)}/${encodeURIComponent(item.id)}/season/${n}">Season ${n}</a></p>
        `).join("")}
      </div>
    `;
  } else if (seasonNums.length && seasonSelected) {
    const seasonData = seasonMap.get(Number(seasonSelected));
    if (!seasonData) {
      linksHtml = '<p class="status warning">Season not found.</p>';
    } else {
      linksHtml = `
        <div class="link-row">
          <p><strong>Season ${seasonData.season}</strong></p>
          <p>${safeText(seasonData.title)}</p>
        </div>
        ${seasonData.episodes
          .sort((a, b) => a.episode - b.episode)
          .map((ep) => `
            <div class="link-row">
              <p><strong>Episode ${ep.episode}</strong></p>
              ${ep.sources.map((s) => `
                <p>${safeText(s.quality)} [${safeText(s.size)}] - <span class="muted-host">${safeText(hostFromUrl(s.url))}</span></p>
                <a href="${safeText(s.url)}" target="_blank" rel="noopener noreferrer">Open ${safeText(s.quality)}</a>
              `).join("")}
            </div>
          `)
          .join("")}
      `;
    }
  } else {
    const groups = new Map();
    for (const link of links) {
      const key = link.season ?? 0;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(link);
    }

    const hasSeasonGroups = Array.from(groups.keys()).some((k) => k > 0);
    if (hasSeasonGroups && !seasonSelected) {
      linksHtml = Array.from(groups.entries())
        .filter(([season]) => season > 0)
        .sort((a, b) => a[0] - b[0])
        .map(([season, rows]) => `
          <div class="link-row">
            <p><strong>Season ${season}</strong></p>
            <p>${rows.length} links available</p>
            <a href="#/post/${encodeURIComponent(item.collection)}/${encodeURIComponent(item.id)}/season/${season}">Open Season ${season}</a>
          </div>
        `)
        .join("");
    } else {
      const active = seasonSelected ? groups.get(Number(seasonSelected)) || [] : links;
      linksHtml = active.map((row) => `
        <div class="link-row">
          <p>${safeText(row.title)}</p>
          <a href="${safeText(row.url)}" target="_blank" rel="noopener noreferrer">${safeText(row.label)}</a>
        </div>
      `).join("") || "<p class=\"status warning\">No valid links found.</p>";
    }
  }

  const hdhubHtml = hblinksRows.length
    ? hblinksRows.map((row) => `
      <div class="hdhub-item">
        <p><strong>${safeText(row.title)}</strong></p>
        <p>${safeText(row.subtype || "archive")}</p>
        <button class="btn ghost open-hdhub" data-id="${row.id}">Click to View Links</button>
      </div>
    `).join("")
    : `<button class="btn" id="loadHdhubLinks">Load HDHub Links</button>`;

  app.innerHTML = `
    <section class="detail">
      <img class="poster" src="${safeText(item.featured_image || FALLBACK_POSTER)}" alt="${safeText(item.title)}" />
      <div class="panel">
        <h2>${safeText(item.title)}</h2>
        <p><strong>Uploaded:</strong> ${safeText(formatDateTime(item.date))}</p>
        <p><strong>Content Type:</strong> ${safeText(item.contentType || "N/A")}</p>
        <p><strong>Collection:</strong> ${safeText(item.collection || "N/A")}</p>
        <p><strong>Categories:</strong></p>
        <div class="categories-wrap">${categoriesHtml || '<span class="cat-chip">N/A</span>'}</div>
        <div class="links">${linksHtml}</div>
        <div class="hdhub-wrap">
          <h3>HDHub extracted links</h3>
          ${hdhubHtml}
        </div>
      </div>
    </section>
  `;

  const btn = document.getElementById("loadHdhubLinks");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Loading...";
      const rows = await loadHblinksSearchForItem(item);
      renderDetailView(item, links, seasonSelected, rows);
    });
  }

  app.querySelectorAll(".open-hdhub").forEach((el) => {
    el.addEventListener("click", () => {
      window.location.hash = `#/hblink/${encodeURIComponent(el.dataset.id || "")}`;
    });
  });
}

function renderHblinkPage(postData) {
  if (!app) return;
  const linksHtml = postData.links.length
    ? postData.links.map((l) => `
      <div class="link-row">
        <p>${safeText(l.text)}</p>
        <a href="${safeText(l.href)}" target="_blank" rel="noopener noreferrer">Open Link</a>
      </div>
    `).join("")
    : '<p class="status warning">No links found in this archive.</p>';

  app.innerHTML = `
    <section class="panel">
      <div class="subpage-head">
        <div>
          <h2>${safeText(postData.title)}</h2>
          <p>Date: ${safeText(postData.date || "N/A")}</p>
        </div>
        <button class="btn ghost close-x" id="closeHblink" aria-label="Close">×</button>
      </div>
      ${linksHtml}
    </section>
  `;

  document.getElementById("closeHblink")?.addEventListener("click", () => {
    if (window.history.length > 1) window.history.back();
    else window.location.hash = "#";
  });
}

async function renderRoute() {
  if (!app || !paginationWrap) return;
  const hash = window.location.hash || "#";

  if (hash.startsWith("#/hblink/")) {
    paginationWrap.hidden = true;
    const id = Number(decodeURIComponent(hash.split("/")[2] || ""));
    if (!Number.isFinite(id) || id <= 0) {
      app.innerHTML = '<p class="status warning">Invalid HDHub link page.</p>';
      return;
    }

    app.innerHTML = '<p class="status">Loading HDHub links...</p>';
    try {
      const postData = await loadHblinksPost(id);
      renderHblinkPage(postData);
    } catch {
      app.innerHTML = '<p class="status warning">Unable to load HDHub links.</p>';
    }
    return;
  }

  if (hash.startsWith("#/post/")) {
    paginationWrap.hidden = true;
    const parts = hash.split("/").map((p) => decodeURIComponent(p));
    const collection = parts[2] || "movies";
    const id = parts[3] || "";
    const season = parts[4] === "season" ? parts[5] : null;

    if (!id) {
      app.innerHTML = '<p class="status warning">Invalid post URL.</p>';
      return;
    }

    app.innerHTML = '<p class="status">Loading details...</p>';
    const item = await fetchItem(collection, id);

    if (!item) {
      app.innerHTML = '<p class="status warning">Unable to load this post.</p>';
      return;
    }

    const links = parseLinks(item.links);
    const cachedSearch = state.hblinksSearchCache.get(`${item.collection}:${item.id}`) || [];
    renderDetailView(item, links, season, cachedSearch);
    return;
  }

  paginationWrap.hidden = false;
  app.innerHTML = '<p class="status">Loading content...</p>';

  try {
    await loadItems();
    syncFilterOptions();
    syncCategoryOptions();
    renderList();
  } catch {
    app.innerHTML = '<p class="status warning">Unable to load content right now.</p>';
  }
}

function bindEvents() {
  presetSelect?.addEventListener("change", async () => {
    state.page = 1;
    if (window.location.hash.startsWith("#/post/") || window.location.hash.startsWith("#/hblink/")) {
      window.location.hash = "#";
      return;
    }
    await renderRoute();
  });

  categoryFilter?.addEventListener("change", async () => {
    state.page = 1;
    if (window.location.hash.startsWith("#/post/") || window.location.hash.startsWith("#/hblink/")) {
      window.location.hash = "#";
      return;
    }
    await renderRoute();
  });

  document.querySelectorAll(".quick-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.quick || "";

      if (key === "trending_movies") {
        if (presetSelect) presetSelect.value = "trending_movies";
        if (categoryFilter) categoryFilter.value = "";
        searchInput.value = "";
      } else if (key === "ultra_4k") {
        if (presetSelect) presetSelect.value = "all";
        searchInput.value = "2160p 4k ultra hd";
        if (!setCategoryByPriority(["2160p", "4K", "4k", "Ultra HD", "UltraHD"])) {
          if (categoryFilter) categoryFilter.value = "";
        }
      } else if (key === "anime") {
        if (presetSelect) presetSelect.value = "anime_feed";
        if (categoryFilter) categoryFilter.value = "Anime";
      } else if (key === "bolly") {
        if (presetSelect) presetSelect.value = "all";
        if (categoryFilter) categoryFilter.value = "Bolly";
      } else if (key === "south") {
        if (presetSelect) presetSelect.value = "all";
        if (categoryFilter) categoryFilter.value = "South";
      }

      state.page = 1;
      if (window.location.hash.startsWith("#/post/") || window.location.hash.startsWith("#/hblink/")) {
        window.location.hash = "#";
        return;
      }
      await renderRoute();
    });
  });

  document.getElementById("applyFilters")?.addEventListener("click", async () => {
    state.page = 1;
    if (window.location.hash.startsWith("#/post/") || window.location.hash.startsWith("#/hblink/")) {
      window.location.hash = "#";
      return;
    }
    await renderRoute();
  });

  document.getElementById("prevPage")?.addEventListener("click", () => {
    state.page -= 1;
    renderList();
  });

  document.getElementById("nextPage")?.addEventListener("click", () => {
    state.page += 1;
    renderList();
  });

  document.getElementById("goPage")?.addEventListener("click", () => {
    const input = document.getElementById("goPageInput");
    const value = Number(input?.value || "");
    if (Number.isFinite(value) && value > 0) {
      state.page = value;
      renderList();
    }
  });

  document.getElementById("backButton")?.addEventListener("click", () => {
    if (window.history.length > 1) window.history.back();
    else window.location.hash = "#";
  });

  window.addEventListener("hashchange", () => {
    renderRoute();
  });
}

function createUserHue() {
  const seed = `${navigator.userAgent}|${screen.width}x${screen.height}|${Intl.DateTimeFormat().resolvedOptions().timeZone || ""}|${Math.random()}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const normalized = Math.abs(hash) % 360;
  return String(normalized);
}

function applyUserTheme() {
  const key = "ma_user_hue";
  let hue = "";
  try {
    hue = localStorage.getItem(key) || "";
    if (!hue || Number.isNaN(Number(hue))) {
      hue = createUserHue();
      localStorage.setItem(key, hue);
    }
  } catch {
    hue = createUserHue();
  }
  document.documentElement.style.setProperty("--user-hue", String(Number(hue) % 360));
}

applyUserTheme();
bindEvents();
Promise.allSettled([loadSlider(), loadSidebarTrending()]).finally(() => {
  renderRoute();
});

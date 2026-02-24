const app = document.getElementById("app");
const pageNumbers = document.getElementById("pageNumbers");
const paginationWrap = document.getElementById("paginationWrap");
const template = document.getElementById("cardTemplate");

const searchInput = document.getElementById("searchInput");
const dateFilter = document.getElementById("dateFilter");
const yearFilter = document.getElementById("yearFilter");
const monthFilter = document.getElementById("monthFilter");
const platformInput = document.getElementById("platformInput");
const FALLBACK_POSTER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='600' viewBox='0 0 400 600'%3E%3Crect width='400' height='600' fill='%230f1629'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%239fb0d7' font-size='28' font-family='Arial'%3ENo Poster%3C/text%3E%3C/svg%3E";

const state = {
  items: [],
  filtered: [],
  page: 1,
  pageSize: 24,
  category: "all",
  loadedCategory: "",
  seasonRoute: null,
  itemCache: new Map(),
};

const COLLECTION_FALLBACKS = ["movies", "series", "anime"];

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
      const featured_image = raw.featured_image || raw.poster || raw.image || raw.thumbnail || "";
      const links = raw.links || raw.downloadLinks || "";
      const contentType = raw.contentType || raw.type || raw.collection || collectionHint || "unknown";
      const collection = raw.collection || raw.contentType || collectionHint || "movies";

      const item = { id: String(id), title, date, featured_image, links, contentType, collection, raw };
      state.itemCache.set(`${item.collection}:${item.id}`, item);
      return item;
    })
    .filter((item) => item.title);
}

async function fetchJson(path) {
  const token = await getProxyToken(path);
  const res = await fetch(path, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Proxy-Token": token,
    },
    credentials: "same-origin",
    cache: "no-store",
  });

  if (res.status === 401) {
    const retryToken = await getProxyToken(path);
    const retryRes = await fetch(path, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Proxy-Token": retryToken,
      },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!retryRes.ok) {
      throw new Error("Request failed.");
    }
    return retryRes.json();
  }

  if (!res.ok) {
    throw new Error("Request failed.");
  }

  return res.json();
}

function getTokenPath(path) {
  const tokenPath = path.startsWith("/api/") ? path.slice(4) : path;
  return tokenPath.startsWith("/") ? tokenPath : `/${tokenPath}`;
}

async function getProxyToken(path) {
  const qs = new URLSearchParams({ path: getTokenPath(path) });
  const res = await fetch(`/api/token?${qs.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error("Request failed.");
  }

  const data = await res.json();
  if (!data || typeof data.token !== "string" || !data.token.includes(".")) {
    throw new Error("Request failed.");
  }
  return data.token;
}

function getActiveCategory() {
  return document.querySelector(".cat-btn.active")?.dataset.category || "all";
}

async function loadItems() {
  const category = getActiveCategory();
  const searchTerm = searchInput.value.trim();
  const platform = platformInput.value.trim();
  const tasks = [];

  if (searchTerm) {
    tasks.push(fetchJson(`/api/search/${encodeURIComponent(searchTerm)}`));
  } else if (category === "trending") {
    tasks.push(fetchJson("/api/trending"));
  } else if (category === "recent") {
    tasks.push(fetchJson("/api/recent"));
  } else if (["movies", "series", "anime"].includes(category)) {
    if (platform) {
      tasks.push(fetchJson(`/api/platform/${encodeURIComponent(platform)}/${encodeURIComponent(category)}`));
    } else {
      tasks.push(fetchJson(`/api/${encodeURIComponent(category)}`));
    }
  } else {
    tasks.push(fetchJson("/api/trending"));
    tasks.push(fetchJson("/api/recent"));
    for (const c of COLLECTION_FALLBACKS) tasks.push(fetchJson(`/api/${c}`));
  }

  const settled = await Promise.allSettled(tasks);
  const merged = [];

  settled.forEach((result, i) => {
    if (result.status !== "fulfilled") return;
    const hint = searchTerm
      ? "search"
      : category === "all"
      ? ["trending", "recent", ...COLLECTION_FALLBACKS][i] || "all"
      : category;
    merged.push(...normalizeResponse(result.value, hint));
  });

  const unique = new Map();
  for (const item of merged) {
    const key = `${item.collection}:${item.id}:${item.title}`;
    if (!unique.has(key)) unique.set(key, item);
  }

  state.items = Array.from(unique.values());
  state.loadedCategory = category;
}

function applyLocalFilters() {
  const term = searchInput.value.trim().toLowerCase();
  const year = yearFilter.value;
  const month = monthFilter.value;
  const exactDate = dateFilter.value;

  state.filtered = state.items.filter((item) => {
    const hay = `${item.title} ${item.contentType}`.toLowerCase();
    if (term && !hay.includes(term)) return false;

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

function syncFilterOptions() {
  const years = new Set();
  for (const item of state.items) {
    const parts = parseDateParts(item.date);
    if (parts?.year) years.add(parts.year);
  }

  const currentYear = yearFilter.value;
  const ordered = Array.from(years).sort((a, b) => Number(b) - Number(a));
  yearFilter.innerHTML = `<option value="">All Years</option>${ordered
    .map((year) => `<option value="${safeText(year)}">${safeText(year)}</option>`)
    .join("")}`;
  if (ordered.includes(currentYear)) yearFilter.value = currentYear;

  const monthLabels = [
    ["01", "January"], ["02", "February"], ["03", "March"], ["04", "April"],
    ["05", "May"], ["06", "June"], ["07", "July"], ["08", "August"],
    ["09", "September"], ["10", "October"], ["11", "November"], ["12", "December"],
  ];
  const currentMonth = monthFilter.value;
  monthFilter.innerHTML = `<option value="">All Months</option>${monthLabels
    .map(([val, label]) => `<option value="${val}">${label}</option>`)
    .join("")}`;
  monthFilter.value = currentMonth;
}

function renderList() {
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
      img.addEventListener("error", () => {
        img.src = FALLBACK_POSTER;
      }, { once: true });
      card.querySelector(".title").textContent = item.title;
      card.querySelector(".date").textContent = item.date ? `Date: ${item.date}` : "Date: N/A";

      card.addEventListener("click", () => {
        const route = `#/post/${encodeURIComponent(item.collection)}/${encodeURIComponent(item.id)}`;
        window.location.hash = route;
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

      return {
        title,
        url,
        label: label || "Vcloud",
        season: Number.isFinite(season) ? season : null,
      };
    })
    .filter((entry) => entry.url);
}

async function fetchItem(collection, id) {
  const cacheKey = `${collection}:${id}`;
  if (state.itemCache.has(cacheKey)) return state.itemCache.get(cacheKey);

  try {
    const data = await fetchJson(`/api/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
    const normalized = normalizeResponse(data, collection);
    return normalized[0] || null;
  } catch {
    return null;
  }
}

function renderDetailView(item, links, seasonSelected) {
  const groups = new Map();
  for (const link of links) {
    const key = link.season ?? 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(link);
  }

  let linksHtml = "";
  const hasSeasonGroups = Array.from(groups.keys()).some((k) => k > 0);

  if (hasSeasonGroups && !seasonSelected) {
    linksHtml = Array.from(groups.entries())
      .filter(([season]) => season > 0)
      .sort((a, b) => a[0] - b[0])
      .map(([season, rows]) => {
        const firstCollection = encodeURIComponent(item.collection);
        const firstId = encodeURIComponent(item.id);
        return `
          <div class="link-row">
            <p><strong>Season ${season}</strong></p>
            <p>${rows.length} links available</p>
            <a href="#/post/${firstCollection}/${firstId}/season/${season}">Open Season ${season}</a>
          </div>
        `;
      })
      .join("");
  } else {
    const activeLinks = seasonSelected ? groups.get(Number(seasonSelected)) || [] : links;
    linksHtml = activeLinks
      .map((row) => `
        <div class="link-row">
          <p>${safeText(row.title)}</p>
          <a href="${safeText(row.url)}" target="_blank" rel="noopener noreferrer">${safeText(row.label)}</a>
        </div>
      `)
      .join("") || "<p class=\"status warning\">No valid vcloud.zip links found.</p>";
  }

  app.innerHTML = `
    <section class="detail">
      <img class="poster" src="${safeText(item.featured_image || FALLBACK_POSTER)}" alt="${safeText(item.title)}" />
      <div class="panel">
        <h2>${safeText(item.title)}</h2>
        <p><strong>Date:</strong> ${safeText(item.date || "N/A")}</p>
        <p><strong>Content Type:</strong> ${safeText(item.contentType || "N/A")}</p>
        <p><strong>Collection:</strong> ${safeText(item.collection || "N/A")}</p>
        <div class="links">${linksHtml}</div>
      </div>
    </section>
  `;
}

async function renderRoute() {
  const hash = window.location.hash || "#";

  if (hash.startsWith("#/post/")) {
    paginationWrap.hidden = true;
    const parts = hash.split("/").map((p) => decodeURIComponent(p));
    const collection = parts[2] || "movies";
    const id = parts[3] || "";
    const seasonIndex = parts[4] === "season" ? parts[5] : null;

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
    renderDetailView(item, links, seasonIndex);
    return;
  }

  paginationWrap.hidden = false;
  app.innerHTML = '<p class="status">Loading content...</p>';

  try {
    await loadItems();
    syncFilterOptions();
    renderList();
  } catch (error) {
    app.innerHTML = '<p class="status warning">Unable to load content right now.</p>';
  }
}

function bindEvents() {
  document.getElementById("categoryNav").addEventListener("click", async (event) => {
    const btn = event.target.closest(".cat-btn");
    if (!btn) return;

    document.querySelectorAll(".cat-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.page = 1;

    if (window.location.hash.startsWith("#/post/")) {
      window.location.hash = "#";
      return;
    }

    await renderRoute();
  });

  document.getElementById("applyFilters").addEventListener("click", async () => {
    state.page = 1;

    if (window.location.hash.startsWith("#/post/")) {
      window.location.hash = "#";
      return;
    }

    await renderRoute();
  });

  document.getElementById("prevPage").addEventListener("click", () => {
    state.page -= 1;
    renderList();
  });

  document.getElementById("nextPage").addEventListener("click", () => {
    state.page += 1;
    renderList();
  });

  document.getElementById("goPage").addEventListener("click", () => {
    const inputVal = Number(document.getElementById("goPageInput").value);
    if (Number.isFinite(inputVal) && inputVal > 0) {
      state.page = inputVal;
      renderList();
    }
  });

  document.getElementById("backButton").addEventListener("click", () => {
    if (window.history.length > 1) window.history.back();
    else window.location.hash = "#";
  });

  window.addEventListener("hashchange", () => {
    renderRoute();
  });
}

bindEvents();
renderRoute();

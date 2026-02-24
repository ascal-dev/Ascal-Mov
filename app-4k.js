const app = document.getElementById("app4k");
const pager = document.getElementById("pager4k");
const pages = document.getElementById("pages4k");
const cardTemplate = document.getElementById("card4k");
const searchInput = document.getElementById("searchInput4k");
const tagFilter = document.getElementById("tagFilter4k");
const sidebar = document.getElementById("sidebar4k");

const state = {
  items: [],
  filtered: [],
  page: 1,
  pageSize: 24
};

const FALLBACK_POSTER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='600' viewBox='0 0 400 600'%3E%3Crect width='400' height='600' fill='%23121b24'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%239db0c8' font-size='24' font-family='Arial'%3ENo Poster%3C/text%3E%3C/svg%3E";

function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
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
      "X-Requested-With": "XMLHttpRequest"
    },
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!res.ok) throw new Error("Token failed");
  const data = await res.json();
  if (!data?.token) throw new Error("Token failed");
  return data.token;
}

async function fetchJson(path) {
  const token = await getProxyToken(path);
  const res = await fetch(path, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Proxy-Token": token
    },
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!res.ok) throw new Error("Request failed");
  return res.json();
}

function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "N/A";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function applyFilters() {
  const q = String(searchInput?.value || "").trim().toLowerCase();
  const tag = String(tagFilter?.value || "").trim().toLowerCase();

  state.filtered = state.items.filter((item) => {
    const title = String(item.title || "").toLowerCase();
    const tags = Array.isArray(item.categories) ? item.categories.map((x) => String(x).toLowerCase()) : [];
    if (q && !title.includes(q)) return false;
    if (tag && !tags.includes(tag)) return false;
    return true;
  });
}

function renderSidebar() {
  if (!sidebar) return;
  const top = state.filtered.slice(0, 14);
  if (!top.length) {
    sidebar.innerHTML = '<p class="status">No sidebar items.</p>';
    return;
  }
  sidebar.innerHTML = top.map((item) => `
    <article class="side-item" data-id="${safeText(item.id)}">
      <img src="${safeText(item.featured_image || FALLBACK_POSTER)}" alt="${safeText(item.title || "")}" loading="lazy" />
      <p>${safeText(item.title || "Untitled")}</p>
    </article>
  `).join("");

  sidebar.querySelectorAll(".side-item").forEach((el) => {
    el.addEventListener("click", () => {
      window.location.hash = `#/movie/${encodeURIComponent(el.dataset.id || "")}`;
    });
  });
}

function renderPagination() {
  if (!pages) return;
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;

  pages.innerHTML = "";
  const start = Math.max(1, state.page - 2);
  const end = Math.min(totalPages, start + 4);
  for (let i = start; i <= end; i += 1) {
    const b = document.createElement("button");
    b.className = `btn${i === state.page ? " active" : ""}`;
    b.textContent = String(i);
    b.addEventListener("click", () => {
      state.page = i;
      renderList();
    });
    pages.appendChild(b);
  }
}

function renderList() {
  if (!app || !cardTemplate) return;
  pager.hidden = false;
  applyFilters();
  renderSidebar();
  const start = (state.page - 1) * state.pageSize;
  const rows = state.filtered.slice(start, start + state.pageSize);

  if (!rows.length) {
    app.innerHTML = '<p class="status">No movies found.</p>';
    renderPagination();
    return;
  }

  const grid = document.createElement("section");
  grid.className = "grid";
  for (const item of rows) {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    const img = card.querySelector(".poster");
    img.src = item.featured_image || FALLBACK_POSTER;
    img.alt = item.title || "Poster";
    img.addEventListener("error", () => {
      img.src = FALLBACK_POSTER;
    }, { once: true });

    card.querySelector(".title").textContent = item.title || "Untitled";
    card.querySelector(".date").textContent = `Released: ${formatDate(item.date)}`;
    card.querySelector(".tags").textContent = (item.categories || []).join(" • ");
    card.addEventListener("click", () => {
      window.location.hash = `#/movie/${encodeURIComponent(item.id)}`;
    });
    grid.appendChild(card);
  }
  app.innerHTML = "";
  app.appendChild(grid);
  renderPagination();
}

function playerUrl(source, id) {
  if (source === "autoembed") return `https://player.autoembed.cc/embed/movie/${encodeURIComponent(id)}`;
  return `https://player.videasy.net/movie/${encodeURIComponent(id)}`;
}

function renderDetail(detail) {
  if (!app) return;
  pager.hidden = true;
  const id = detail?.id || "";
  const sourceDefault = "videasy";
  const tags = Array.isArray(detail.genres) ? detail.genres : [];
  const cast = Array.isArray(detail?.credits?.cast) ? detail.credits.cast.slice(0, 8).map((x) => x.name).filter(Boolean) : [];

  app.innerHTML = `
    <section class="detail">
      <div class="media">
        <img class="hero" src="${safeText(detail.backdrop_image || detail.featured_image || FALLBACK_POSTER)}" alt="${safeText(detail.title || "")}" />
        <div class="player-head">
          <h2>${safeText(detail.title || "Untitled")}</h2>
          <select id="embedSource">
            <option value="videasy">Videasy (Default)</option>
            <option value="autoembed">AutoEmbed</option>
          </select>
        </div>
        <iframe id="movieFrame" class="frame" src="${safeText(playerUrl(sourceDefault, id))}" allowfullscreen loading="lazy"></iframe>
      </div>
      <aside class="info">
        <p><strong>Release:</strong> ${safeText(formatDate(detail.date))}</p>
        <p><strong>Runtime:</strong> ${safeText(detail.runtime ? `${detail.runtime} min` : "N/A")}</p>
        <p><strong>Rating:</strong> ${safeText(detail.vote_average ? String(detail.vote_average) : "N/A")}</p>
        <p><strong>Genres:</strong> ${safeText(tags.join(", ") || "N/A")}</p>
        <p><strong>Cast:</strong> ${safeText(cast.join(", ") || "N/A")}</p>
        <p>${safeText(detail.overview || "No overview available.")}</p>
        <div class="links">
          <a href="${safeText(playerUrl("videasy", id))}" target="_blank" rel="noopener noreferrer">Watch on Videasy</a>
          <a href="${safeText(playerUrl("autoembed", id))}" target="_blank" rel="noopener noreferrer">Watch on AutoEmbed</a>
        </div>
      </aside>
    </section>
  `;

  const sourceSelect = document.getElementById("embedSource");
  const frame = document.getElementById("movieFrame");
  sourceSelect?.addEventListener("change", () => {
    const source = sourceSelect.value === "autoembed" ? "autoembed" : "videasy";
    frame.src = playerUrl(source, id);
  });
}

async function loadList() {
  const data = await fetchJson("/api/ext/tmdb-discover");
  const rows = Array.isArray(data) ? data : data?.results || [];
  state.items = rows.map((x) => ({
    id: String(x.id || x.tmdbId || ""),
    title: x.title || "Untitled",
    date: x.date || "",
    featured_image: x.featured_image || "",
    categories: Array.isArray(x.categories) ? x.categories : []
  })).filter((x) => x.id);
  state.page = 1;
  renderList();
}

async function route() {
  const hash = window.location.hash || "#";
  if (hash.startsWith("#/movie/")) {
    const id = decodeURIComponent(hash.split("/")[2] || "");
    if (!/^\d+$/.test(id)) {
      app.innerHTML = '<p class="status">Invalid movie id.</p>';
      return;
    }
    app.innerHTML = '<p class="status">Loading movie details...</p>';
    try {
      const detail = await fetchJson(`/api/ext/tmdb-movie/${encodeURIComponent(id)}?lang=en`);
      renderDetail(detail);
    } catch {
      app.innerHTML = '<p class="status">Unable to load movie details.</p>';
    }
    return;
  }
  app.innerHTML = '<p class="status">Loading 4kMovieArea...</p>';
  try {
    await loadList();
  } catch {
    app.innerHTML = '<p class="status">Unable to load 4k movies right now.</p>';
  }
}

document.getElementById("apply4k")?.addEventListener("click", () => {
  state.page = 1;
  if (window.location.hash.startsWith("#/movie/")) {
    window.location.hash = "#";
    return;
  }
  renderList();
});

document.getElementById("prev4k")?.addEventListener("click", () => {
  state.page -= 1;
  renderList();
});

document.getElementById("next4k")?.addEventListener("click", () => {
  state.page += 1;
  renderList();
});

window.addEventListener("hashchange", route);
route();

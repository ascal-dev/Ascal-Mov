const TOKEN_TTL_SECONDS = 20;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_API_REQ_PER_WINDOW = 120;
const MAX_TOKEN_REQ_PER_WINDOW = 24;
const MAX_PATH_LENGTH = 180;
const MAX_TOKEN_LENGTH = 1200;
const MAX_ID_LENGTH = 120;
const REQUIRED_XRW = "xmlhttprequest";

const EXT_SLIDER = "/ext/slider";
const EXT_HBLINKS_SEARCH = "/ext/hblinks-search";
const EXT_HBLINKS_POST_PREFIX = "/ext/hblinks-post/";

const ALLOWED = [
  /^\/health$/,
  /^\/stats$/,
  /^\/trending(?:\/(movies|series|anime|bolly_movies|bolly_series))?$/,
  /^\/recent(?:\/(movies|series|anime|bolly_movies|bolly_series))?$/,
  /^\/platform\/[A-Za-z0-9_-]+(?:\/(movies|series|anime|bolly_movies|bolly_series))?$/,
  /^\/search\/[A-Za-z0-9%._-]+$/,
  /^\/(movies|series|anime)$/,
  /^\/(movies|series|anime)\/[A-Za-z0-9._:-]+$/,
  /^\/ext\/slider$/,
  /^\/ext\/hblinks-search$/,
  /^\/ext\/hblinks-post\/[0-9]+$/
];

const rateStore = new Map();
const usedTokenStore = new Map();

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    ...extra
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...securityHeaders(extraHeaders)
    }
  });
}

function deny(status = 404) {
  return json({ error: "Request denied" }, status, {
    "Cache-Control": "no-store",
    Pragma: "no-cache"
  });
}

function normalizePath(pathValue) {
  return `/${String(pathValue || "").replace(/^\/+/, "")}`;
}

function isAllowedPath(path) {
  return ALLOWED.some((rule) => rule.test(path));
}

function pathShapeValid(path) {
  if (!path || path.length > MAX_PATH_LENGTH) return false;
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 2 && ["movies", "series", "anime"].includes(parts[0])) {
    return parts[1].length > 0 && parts[1].length <= MAX_ID_LENGTH;
  }
  return true;
}

function validUpstreamOrigin(rawOrigin) {
  try {
    const parsed = new URL(rawOrigin);
    return parsed.protocol === "https:" && parsed.hostname === "api.hicine.info" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function getClientIp(request) {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  const fwd = request.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || "0.0.0.0";
}

function parseAllowedOrigins(raw) {
  return String(raw || "")
    .split(",")
    .map((v) => normalizeOrigin(v))
    .filter(Boolean);
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return "";
  }
}

function originAllowed(request, allowedOrigins) {
  if (allowedOrigins.length === 0) return false;
  const origin = normalizeOrigin(request.headers.get("origin"));
  const referer = request.headers.get("referer");

  if (origin && allowedOrigins.includes(origin)) return true;

  if (referer) {
    try {
      const refOrigin = new URL(referer).origin.toLowerCase();
      if (allowedOrigins.includes(refOrigin)) return true;
    } catch {
      return false;
    }
  }

  // Some same-origin GET fetches may omit Origin/Referer; allow only when request host is explicitly allowlisted.
  try {
    const reqOrigin = new URL(request.url).origin.toLowerCase();
    if (allowedOrigins.includes(reqOrigin)) return true;
  } catch {
    // fall through
  }

  // Host header fallback for environments where Origin/Referer are trimmed.
  const reqHost = String(request.headers.get("host") || "").trim().toLowerCase();
  if (reqHost) {
    for (const allowed of allowedOrigins) {
      try {
        const allowedHost = new URL(allowed).host.toLowerCase();
        if (allowedHost && allowedHost === reqHost) return true;
      } catch {
        // ignore malformed entry
      }
    }
  }

  return false;
}

function checkRateLimit(type, ip, maxRequests) {
  const key = `${type}:${ip}`;
  const now = Date.now();
  const current = rateStore.get(key);

  if (!current || now >= current.resetAt) {
    rateStore.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, retryAfterMs: 0 };
  }

  if (current.count >= maxRequests) {
    return { ok: false, retryAfterMs: current.resetAt - now };
  }

  current.count += 1;
  rateStore.set(key, current);
  return { ok: true, retryAfterMs: 0 };
}

function cleanupUsedTokens() {
  const now = Date.now();
  for (const [key, expiresAt] of usedTokenStore.entries()) {
    if (expiresAt <= now) usedTokenStore.delete(key);
  }
}

function consumeTokenNonce(nonce, expUnix) {
  cleanupUsedTokens();
  if (!nonce) return false;
  if (usedTokenStore.has(nonce)) return false;
  const expMs = Number(expUnix || 0) * 1000;
  usedTokenStore.set(nonce, expMs > Date.now() ? expMs : Date.now() + 30000);
  return true;
}

function base64UrlEncode(input) {
  const str = typeof input === "string" ? input : JSON.stringify(input);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(normalized + pad);
}

async function importHmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signValue(value, secret) {
  const key = await importHmacKey(secret);
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  const bytes = new Uint8Array(sig);
  let raw = "";
  for (let i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i]);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function ipHash(ip, secret) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`${ip}:${secret}`));
  return Array.from(new Uint8Array(digest)).slice(0, 12).map((n) => n.toString(16).padStart(2, "0")).join("");
}

async function issueToken(path, method, origin, ip, secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    p: path,
    m: method,
    o: origin,
    ih: await ipHash(ip, secret),
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    n: crypto.randomUUID()
  };

  const header = { alg: "HS256", typ: "HICINE-PROXY" };
  const h = base64UrlEncode(header);
  const p = base64UrlEncode(payload);
  const data = `${h}.${p}`;
  const s = await signValue(data, secret);
  return `${data}.${s}`;
}

async function verifyToken(token, expectedPath, expectedMethod, origin, ip, secret) {
  if (!token || typeof token !== "string") return { ok: false };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false };

  const [h, p, sig] = parts;
  const data = `${h}.${p}`;
  const expectedSig = await signValue(data, secret);

  if (!constantTimeEqual(sig, expectedSig)) return { ok: false };

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(p));
  } catch {
    return { ok: false };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload?.exp || now > payload.exp) return { ok: false };
  if (payload.p !== expectedPath) return { ok: false };
  if (payload.m !== expectedMethod) return { ok: false };
  if (payload.o !== origin) return { ok: false };

  const expectedIpHash = await ipHash(ip, secret);
  if (payload.ih !== expectedIpHash) return { ok: false };

  return { ok: true, nonce: payload.n, exp: payload.exp };
}

function getRequestOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin) return origin;

  const referer = request.headers.get("referer");
  if (!referer) return "";

  try {
    return new URL(referer).origin;
  } catch {
    return "";
  }
}

function hasAcceptJson(request) {
  const accept = request.headers.get("accept") || "";
  return accept.includes("application/json") || accept.includes("*/*");
}

function validFetchSite(request) {
  const value = (request.headers.get("sec-fetch-site") || "").toLowerCase();
  return value === "" || value === "same-origin" || value === "same-site";
}

function validFetchContext(request) {
  const mode = (request.headers.get("sec-fetch-mode") || "").toLowerCase();
  const dest = (request.headers.get("sec-fetch-dest") || "").toLowerCase();
  if (!mode && !dest) return true;
  return (mode === "cors" || mode === "same-origin") && (dest === "empty" || dest === "");
}

function validRequestedWith(request) {
  const value = (request.headers.get("x-requested-with") || "").toLowerCase();
  return value === REQUIRED_XRW;
}

function isHblinksPostPath(path) {
  return path.startsWith(EXT_HBLINKS_POST_PREFIX);
}

async function proxyJsonFromUrl(targetUrl, cacheTtl = 120, userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36") {
  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent
      },
      cf: { cacheEverything: true, cacheTtl }
    });
  } catch {
    return deny(502);
  }

  const ctype = (upstream.headers.get("Content-Type") || "").toLowerCase();
  if (!upstream.ok) return deny(404);

  // Some upstreams return JSON with non-json content-type; keep strict but tolerant parsing.
  const text = await upstream.text();
  const trimmed = text.trim();
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!ctype.includes("application/json") && !looksLikeJson) return deny(404);

  const body = new TextEncoder().encode(text);
  return new Response(body, {
    status: 200,
    headers: {
      ...securityHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=120, stale-while-revalidate=300"
    }
  });
}

export async function onRequest(context) {
  const { request, params, env } = context;

  const apiOrigin = env.HICINE_API_ORIGIN;
  const hmacSecret = env.HICINE_HMAC_SECRET;
  const allowedOrigins = parseAllowedOrigins(env.HICINE_ALLOWED_ORIGINS);

  if (!apiOrigin || !hmacSecret || allowedOrigins.length === 0 || !validUpstreamOrigin(apiOrigin)) {
    return deny(503);
  }

  if (request.method !== "GET") return deny(404);

  const pathValue = Array.isArray(params.path) ? params.path.join("/") : params.path;
  const normalizedPath = normalizePath(pathValue);

  if (!normalizedPath || normalizedPath === "/" || !pathShapeValid(normalizedPath)) {
    return deny(404);
  }

  const isTokenPath = normalizedPath === "/token";
  const hasCommonSecurityContext =
    hasAcceptJson(request) &&
    validFetchSite(request) &&
    validFetchContext(request) &&
    originAllowed(request, allowedOrigins);

  // Token endpoint: robust checks for Pages/browser variability.
  if (isTokenPath) {
    if (!hasCommonSecurityContext) return deny(403);
  } else {
    // Data endpoints: strict browser-style requirement + token.
    if (!hasCommonSecurityContext || !validRequestedWith(request)) return deny(403);
  }

  const clientIp = getClientIp(request);

  if (isTokenPath) {
    const tokenLimit = checkRateLimit("token", clientIp, MAX_TOKEN_REQ_PER_WINDOW);
    if (!tokenLimit.ok) return deny(429);

    const url = new URL(request.url);
    const targetPath = normalizePath(url.searchParams.get("path") || "");
    if (!targetPath || !pathShapeValid(targetPath) || !isAllowedPath(targetPath)) return deny(404);

    const reqOrigin = getRequestOrigin(request);
    const token = await issueToken(targetPath, "GET", reqOrigin, clientIp, hmacSecret);

    return json({ token, expiresIn: TOKEN_TTL_SECONDS }, 200, {
      "Cache-Control": "no-store",
      Pragma: "no-cache"
    });
  }

  if (!isAllowedPath(normalizedPath)) return deny(404);

  const apiLimit = checkRateLimit("api", clientIp, MAX_API_REQ_PER_WINDOW);
  if (!apiLimit.ok) return deny(429);

  const providedToken = request.headers.get("x-proxy-token") || "";
  if (providedToken.length > MAX_TOKEN_LENGTH) return deny(401);

  const reqOrigin = getRequestOrigin(request);
  const tokenCheck = await verifyToken(providedToken, normalizedPath, "GET", reqOrigin, clientIp, hmacSecret);
  if (!tokenCheck.ok || !consumeTokenNonce(tokenCheck.nonce, tokenCheck.exp)) return deny(401);

  const reqUrl = new URL(request.url);

  if (normalizedPath === EXT_SLIDER) {
    return proxyJsonFromUrl("https://dns.pingora.fyi/v2/ping", 90);
  }

  if (normalizedPath === EXT_HBLINKS_SEARCH) {
    const keywordRaw = (reqUrl.searchParams.get("keyword") || "").trim();
    const keyword = keywordRaw.slice(0, 80);
    if (!keyword) return deny(404);
    const target = `https://hblinks.dad/wp-json/wp/v2/search?search=${encodeURIComponent(keyword)}`;
    return proxyJsonFromUrl(target, 120);
  }

  if (isHblinksPostPath(normalizedPath)) {
    const id = normalizedPath.slice(EXT_HBLINKS_POST_PREFIX.length);
    if (!/^\d+$/.test(id)) return deny(404);
    const target = `https://hblinks.dad/wp-json/wp/v2/posts/${id}`;
    return proxyJsonFromUrl(target, 180);
  }

  const upstreamPath = normalizedPath === "/health" ? "/health" : `/api${normalizedPath}`;
  const target = new URL(upstreamPath, apiOrigin);
  const upstreamHeaders = {
    Accept: "application/json",
    "User-Agent": "HicineSecureWorker/2.0"
  };

  if (env.HICINE_API_KEY) {
    upstreamHeaders.Authorization = `Bearer ${env.HICINE_API_KEY}`;
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers: upstreamHeaders,
      cf: { cacheEverything: true, cacheTtl: 120 }
    });
  } catch {
    return deny(502);
  }

  const ctype = (upstream.headers.get("Content-Type") || "").toLowerCase();
  if (!upstream.ok || !ctype.includes("application/json")) return deny(404);

  const body = await upstream.arrayBuffer();
  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=60, s-maxage=120, stale-while-revalidate=300");
  Object.entries(securityHeaders()).forEach(([key, value]) => headers.set(key, value));

  return new Response(body, {
    status: 200,
    headers
  });
}

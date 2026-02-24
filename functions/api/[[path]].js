const TOKEN_TTL_SECONDS = 45;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_API_REQ_PER_WINDOW = 180;
const MAX_TOKEN_REQ_PER_WINDOW = 50;
const MAX_PATH_LENGTH = 180;
const MAX_TOKEN_LENGTH = 1200;

const ALLOWED = [
  /^\/health$/,
  /^\/stats$/,
  /^\/trending(?:\/(movies|series|anime))?$/,
  /^\/recent(?:\/(movies|series|anime))?$/,
  /^\/platform\/[A-Za-z0-9_-]+(?:\/(movies|series|anime))?$/,
  /^\/search\/[A-Za-z0-9%._-]+$/,
  /^\/[A-Za-z0-9_-]+$/,
  /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/
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
  return `/${String(pathValue || "").replace(/^\/+/, "").slice(0, MAX_PATH_LENGTH)}`;
}

function isAllowedPath(path) {
  return ALLOWED.some((rule) => rule.test(path));
}

function validUpstreamOrigin(rawOrigin) {
  try {
    const parsed = new URL(rawOrigin);
    return parsed.protocol === "https:" && parsed.hostname === "api.hicine.info";
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
    .map((v) => v.trim())
    .filter(Boolean);
}

function originAllowed(request, allowedOrigins) {
  if (allowedOrigins.length === 0) return false;
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  if (origin && allowedOrigins.includes(origin)) return true;

  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (allowedOrigins.includes(refOrigin)) return true;
    } catch {
      return false;
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
  return value === "same-origin" || value === "same-site";
}

export async function onRequest(context) {
  const { request, params, env } = context;

  const apiOrigin = env.HICINE_API_ORIGIN;
  const hmacSecret = env.HICINE_HMAC_SECRET;
  const allowedOrigins = parseAllowedOrigins(env.HICINE_ALLOWED_ORIGINS);

  if (!apiOrigin || !hmacSecret || allowedOrigins.length === 0 || !validUpstreamOrigin(apiOrigin)) {
    return deny(503);
  }

  if (request.method !== "GET") {
    return deny(404);
  }

  if (!hasAcceptJson(request) || !validFetchSite(request) || !originAllowed(request, allowedOrigins)) {
    return deny(403);
  }

  const pathValue = Array.isArray(params.path) ? params.path.join("/") : params.path;
  const normalizedPath = normalizePath(pathValue);

  if (!normalizedPath || normalizedPath === "/") {
    return deny(404);
  }

  const clientIp = getClientIp(request);

  if (normalizedPath === "/token") {
    const tokenLimit = checkRateLimit("token", clientIp, MAX_TOKEN_REQ_PER_WINDOW);
    if (!tokenLimit.ok) {
      return deny(429);
    }

    const url = new URL(request.url);
    const targetPath = normalizePath(url.searchParams.get("path") || "");
    if (!targetPath || targetPath.length > MAX_PATH_LENGTH || !isAllowedPath(targetPath)) {
      return deny(404);
    }

    const reqOrigin = getRequestOrigin(request);
    const token = await issueToken(targetPath, "GET", reqOrigin, clientIp, hmacSecret);

    return json({ token, expiresIn: TOKEN_TTL_SECONDS }, 200, {
      "Cache-Control": "no-store",
      Pragma: "no-cache"
    });
  }

  if (!isAllowedPath(normalizedPath)) {
    return deny(404);
  }

  const apiLimit = checkRateLimit("api", clientIp, MAX_API_REQ_PER_WINDOW);
  if (!apiLimit.ok) {
    return deny(429);
  }

  const providedToken = request.headers.get("x-proxy-token") || "";
  if (providedToken.length > MAX_TOKEN_LENGTH) return deny(401);

  const reqOrigin = getRequestOrigin(request);
  const tokenCheck = await verifyToken(providedToken, normalizedPath, "GET", reqOrigin, clientIp, hmacSecret);

  if (!tokenCheck.ok || !consumeTokenNonce(tokenCheck.nonce, tokenCheck.exp)) {
    return deny(401);
  }

  const upstreamPath = normalizedPath === "/health" ? "/health" : `/api${normalizedPath}`;
  const target = new URL(upstreamPath, apiOrigin);
  const upstreamHeaders = {
    Accept: "application/json",
    "User-Agent": "HicineSecureWorker/1.1"
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

  if (!upstream.ok) {
    return deny(404);
  }

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

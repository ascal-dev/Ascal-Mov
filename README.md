# Hicine Explorer (Cloudflare Pages)

Responsive movie site with:
- Category headers (`All`, `Trending`, `Recent`, `Movies`, `Series`, `Anime`)
- Search and filters (`date`, `year`, `month`, `platform`)
- Pagination with `Previous`, `Next`, page numbers, page input + `Go`
- Detail pages with `featured_image`, `title`, `date`, `contentType`
- Link parser that converts wrapped links into real `https://vcloud.zip/...` links
- Season-aware handling: opens per-season pages when seasons exist

## Structure
- `index.html` - UI skeleton
- `styles.css` - responsive styling (supports small screens down to 300px)
- `app.js` - frontend logic, routing, filtering, pagination, link parsing
- `functions/api/[[path]].js` - Cloudflare Pages API gateway
- `_headers` - security + caching headers

## Deploy (Cloudflare Pages)
1. Create a Pages project and connect this folder/repo.
2. Build command: none
3. Build output directory: `/`
4. Enable Pages Functions (auto-detected from `functions/`).
5. Add env vars in Pages:
   - `HICINE_API_ORIGIN` (required): `https://api.hicine.info`
   - `HICINE_API_KEY` (optional): upstream bearer key (if needed by upstream)
   - `HICINE_HMAC_SECRET` (required): long random secret for short-lived token signing
   - `HICINE_ALLOWED_ORIGINS` (required): comma-separated allowed site origins
     example: `https://yourdomain.com,https://www.yourdomain.com`

## Cloudflare workflow to hide upstream API
1. Frontend calls only `/api/*` on your own domain.
2. Pages Function reads `HICINE_API_ORIGIN` from server env and forwards request server-side.
3. `api.hicine.info` is never exposed in frontend code or browser requests.
4. Short-lived HMAC token is required for each API path (`/api/token` then `/api/...` with `X-Proxy-Token`).
5. Token is bound to path + method + origin + IP + expiry.
6. Endpoint allowlist, origin allowlist, and per-IP rate limiting are enforced at edge.
5. Add Cloudflare WAF rules on `/api/*` and Bot Fight Mode for extra abuse protection.

## Cloudflare WAF setup (recommended)
Create these in Cloudflare Dashboard for your Pages domain:

1. Custom rule: block non-GET on API
   - Expression: `(http.request.uri.path starts_with "/api/") and (http.request.method ne "GET")`
   - Action: `Block`

2. Custom rule: managed challenge suspicious bots on API
   - Expression: `(http.request.uri.path starts_with "/api/") and (cf.bot_management.score lt 30) and (not cf.bot_management.verified_bot)`
   - Action: `Managed Challenge`

3. Custom rule: block high-threat countries (optional)
   - Expression: `(http.request.uri.path starts_with "/api/") and (ip.geoip.country in {"CN" "RU" "KP"})`
   - Action: `Block`
   - Adjust countries for your traffic profile.

4. Custom rule: block empty/unknown user agents on API
   - Expression: `(http.request.uri.path starts_with "/api/") and (len(http.user_agent) eq 0)`
   - Action: `Block`

5. Rate limiting rule: API abuse guard
   - Scope: path starts with `/api/`
   - Threshold: `120 requests / 1 minute` per IP
   - Action: `Managed Challenge` (or `Block` for stricter mode)
   - Mitigation timeout: `10 minutes`

6. Rate limiting rule: hard burst protection
   - Scope: path starts with `/api/`
   - Threshold: `300 requests / 1 minute` per IP
   - Action: `Block`
   - Mitigation timeout: `1 hour`

7. Enable managed protections
   - Turn on `WAF Managed Rules`.
   - Turn on `Bot Fight Mode` (or `Super Bot Fight Mode` if plan supports).
   - Keep `Security Level` at least `Medium`.

## Security notes
- Client still sees requests to your domain (`/api/*`) in DevTools/Burp. That cannot be hidden.
- Upstream host and optional auth key stay server-side only.
- Tokens are short-lived and cannot be reused on different paths/origins/IPs.

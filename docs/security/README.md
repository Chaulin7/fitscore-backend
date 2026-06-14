# CVsprings — Security hardening

Production security controls. All limits, sizes, origins, and flags come from
env, so the custom-domain switch only needs `CORS_ALLOWED_ORIGINS` and the CSP
origins updated — no code change.

## 1. Upload validation (authoritative, server-side)

The client's `accept=".pdf,.docx"`, filename extension, and sent MIME type are
all treated as untrusted UX hints. The server decides the real type from
content (`src/services/fileSecurity.js`):

- **PDF**: must start with `%PDF`.
- **DOCX**: must be a ZIP (`PK\x03\x04`) whose directory contains the OOXML
  members `[Content_Types].xml` **and** `word/document.xml` (entry names are
  stored uncompressed in a zip, so a `.zip`/`.exe` renamed `.docx` fails this).
- **Size**: `MAX_FILE_BYTES` per file (default 10 MB), enforced by multer
  (hard abort) and re-checked.
- **Batch**: `MAX_BATCH_FILES` (default 200) and an aggregate
  `MAX_TOTAL_BYTES` (default 200 MB) to prevent a 200×10 MB memory blowout.
- **Timeout**: each file's text extraction (and AV scan) is bounded by
  `PROCESS_TIMEOUT_MS` (default 30 s) so one malformed file can't hang a request.

Violations return `400 { code: 'INVALID_FILE', field: 'cv'|'cvs' }` (or
`FILE_REJECTED` / `PROCESSING_TIMEOUT`). In a batch, a bad file is reported as a
per-row error and the rest proceed.

## 2. Malware scanning (optional, feature-flagged)

Off by default. Enable with `ENABLE_AV_SCAN=true` and point `AV_SCAN_URL` at an
HTTP scanner that accepts the raw file body (`POST`, `application/octet-stream`)
and returns `{ "clean": true }` or `{ "infected": true }`. On detection the
request is rejected with `400 FILE_REJECTED` and the event is logged
(filename + org id only — never file contents). With the flag off or no scanner
configured, uploads proceed normally (never silently blocked). A clamd
integration can be dropped into `scanFile()`.

Test: with a scanner wired, an [EICAR test file](https://www.eicar.org/) must be
rejected; with the flag off, the same file uploads normally.

## 3. Rate limits (server-side)

In-memory store — correct for a **single instance**. A multi-instance deploy
needs a shared store (e.g. Redis) or these limits apply per-process.

| Scope | Limit (default) | Env | Key |
|---|---|---|---|
| Analyze (`/api/analyze[/batch]`) | 60 analyses-worth / 10 min (a batch costs its CV count) | `ANALYZE_RATE` | org |
| Mutating audit/template/org writes | 300 / 10 min (GET reads skipped) | `MUTATION_RATE` | org |
| Login | 10 / 15 min | — | IP |
| Signup | 5 / hr | — | IP |
| Password reset request | 3 / hr | — | email |

The analyze limit is an abuse/cost guard layered **on top of** the billing
quota. On a hit: `429 { code: 'RATE_LIMITED', retryAfter }` with a `Retry-After`
header; the frontend shows a calm "you're going a bit fast" toast.

## 4. CORS

`CORS_ALLOWED_ORIGINS` (comma-separated) is the allowlist. A literal `*` is
ignored when `NODE_ENV=production`. Requests with no `Origin` header
(server-to-server, curl, the **Stripe webhook**) are unaffected. Allowed
methods: GET/POST/PATCH/DELETE/OPTIONS; allowed headers: `Content-Type`,
`Authorization`. Browser downloads (report/CSV/export) use a `?dt=` token, not a
custom header, so no extra CORS header is needed. **Update this list when the
custom domain lands.**

## 5. Frontend XSS / injection

Table rows (batch, audit, role tabs, templates) no longer concatenate
user-controlled values (candidate/role/template names, ids) into inline
`onclick` handlers. Values live in HTML-escaped `data-` attributes and are read
by a single delegated listener per container. `escHtml()` still escapes all
dynamic text for display. A template/candidate/role named with quotes,
backslashes, `</script>`, or an `onclick` payload renders as inert text and its
row buttons still work.

## 6. Security headers

Set via helmet (`src/index.js`):

- **CSP**: `default-src 'self'`; scripts/styles allow `'unsafe-inline'`
  (required by the single-file app) plus the origins actually used
  (Plausible, Stripe.js, Google Fonts); `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
  > Tradeoff: the app is one HTML file with inline scripts, so a strict
  > nonce-based CSP isn't feasible without a build step. We keep
  > `'unsafe-inline'` for scripts/styles but lock down everything else.
- **X-Content-Type-Options**: `nosniff`
- **Referrer-Policy**: `strict-origin-when-cross-origin`
- **HSTS**: 180 days incl. subdomains — sent only over HTTPS (no-op on local
  HTTP; effective on Render/custom domain).

## 7. Error hygiene & tokens

- 5xx responses return a generic message; full detail (incl. stack) is logged
  server-side only. `/health` no longer echoes DB error text/paths.
- Download tokens (report/CSV/org-export) are single-use, 60 s, and bound to
  the issuing session's org — re-verified.

## Notes for the domain switch (task #5)

1. Set `CORS_ALLOWED_ORIGINS` to the production origin(s).
2. Update the CSP `connectSrc` (currently includes the Render API host) to the
   new domain in `src/index.js`.
3. HSTS is already on; confirm HTTPS at the domain.

# CVsprings — Public API Specification

> **DRAFT — planned API, subject to change; NOT YET AVAILABLE.**
> This documents the *intended* public API. It largely formalises endpoints
> that already exist internally (org-scoped, session-authenticated). The
> request/response schemas below mirror what the product returns today, so the
> spec is implementation-ready — but no public API, API keys, or webhooks are
> live yet. Last updated 18 June 2026.

---

## 1. Authentication (design only — not implemented)

- **Per-org API keys**, issued by an organization **owner** from the app
  (planned UI). A key belongs to exactly one organization and is **scoped to
  that org** — it can only read/write that org's data, identical to the
  session-based scoping the product enforces today.
- Passed as a bearer token:
  ```
  Authorization: Bearer cvs_live_<key>
  ```
- Keys are **revocable** and can be rotated; a revoked key immediately stops
  working. Keys are shown once at creation and stored only as a hash
  (same pattern as the product's session tokens).
- No key = `401 { "error": "Unauthorized", "code": "AUTH_REQUIRED" }`.

## 2. Versioning & stability

- **Base path:** `/v1` (e.g. `https://api.cvsprings.example/v1/analyze`). The
  host is finalised at launch.
- **Stability:** within `v1`, we add fields without notice but do not remove or
  repurpose existing ones; breaking changes ship under a new version prefix.
  Treat unknown JSON fields as forward-compatible (ignore what you don't use).

## 3. Conventions

- JSON request/response bodies (file uploads use `multipart/form-data`).
- **Error shape** (matches the live product exactly):
  ```json
  { "error": "Human-readable message", "code": "MACHINE_CODE", "field": "optional" }
  ```
- All endpoints are **org-scoped**; a key never sees another org's data, and
  cross-org id access returns `404` (existence is not leaked).
- Timestamps are ISO 8601 UTC strings.

---

## 4. Core endpoints

### 4.1 Submit analysis (single) — `POST /v1/analyze`
`multipart/form-data`:

| Field | Type | Notes |
|---|---|---|
| `cv` | file | PDF or DOCX (see §6 file constraints) |
| `jobDescription` | string | required, ≥ 50 chars |
| `weights` | JSON string | optional `{ "kw":40, "sk":30, "ex":20, "ed":10 }`; must sum to 100 |
| `anonymize` | boolean | optional; strips contact details/name lines before scoring |

**200** → the standard analysis result object (the same shape the app renders):
```json
{
  "candidateName": "Jane Doe",
  "anonymized": false,
  "modelId": "cvsprings-lexical-scorer@1.3.0",
  "analysisTimestamp": "2026-06-18T09:00:00.000Z",
  "overall": 72,
  "scores": { "keywords": 50, "skills": 82, "experience": 80, "education": 100 },
  "verdict": "Good Match",
  "found": ["node.js", "postgresql", "aws"],
  "missing": ["kubernetes"],
  "skills": [
    { "name": "node.js", "found": true, "category": "Backend" },
    { "name": "kubernetes", "found": false, "category": "DevOps" }
  ],
  "recommendations": [
    { "icon": "✅", "text": "Good overall fit. Consider a technical screening." }
  ]
}
```
- `found` / `missing` are the job description's keywords present/absent in the
  CV. `skills` lists each JD-required skill with a found flag. `scores` are the
  four sub-scores (0–100); `overall` is their weighted average.
- Counts as **one analysis** against the org's plan quota (§7).

### 4.2 Submit analysis (batch) — `POST /v1/analyze/batch`
`multipart/form-data`: repeated `cvs` file fields (up to the batch cap, §6),
plus `jobDescription`, `weights`, `anonymize` as above.

**200**:
```json
{
  "count": 3,
  "modelId": "cvsprings-lexical-scorer@1.3.0",
  "results": [ { "candidateName": "...", "fileName": "a.pdf", "...": "single-result fields" } ]
}
```
Results are ranked by `overall` (descending). A file that can't be parsed
appears as `{ "candidateName", "fileName", "error", "code" }` in place of a
result; the rest still process. Counts as **N analyses** (one per successfully
scored CV) against quota.

### 4.3 Audit records — `GET /v1/audit`
Returns the org's saved analysis records. Supports filters
(`role`, `decision`, `search`, `from`, `to`, `limit`, `offset`). Each record
includes provenance and **attribution**:
```json
{
  "id": "…", "candidateName": "Jane Doe", "fileName": "jane.pdf",
  "overall": 72, "scores": { "keywords": 50, "skills": 82, "experience": 80, "education": 100 },
  "weights": { "kw": 40, "sk": 30, "ex": 20, "ed": 10 },
  "verdict": "Good Match", "decision": "shortlist", "note": "Strong fit",
  "jdSnippet": "Backend engineer, Node.js…", "role": "Backend Engineer",
  "anonymized": false,
  "appVersion": "1.3.0", "modelId": "cvsprings-lexical-scorer@1.3.0",
  "analysisTimestamp": "2026-06-18T09:00:00.000Z",
  "reviewedBy": "recruiter@acme.com",
  "createdAt": "…", "updatedAt": "…"
}
```

### 4.4 Single record — `GET /v1/audit/{id}`
The record object above (plus `analysisDetail` with the keyword/skill/
recommendation breakdown when captured). `404` if not in the caller's org.

### 4.5 Change history — `GET /v1/audit/{id}/changes`
Append-only decision/note edit log, newest first, **with attribution**:
```json
[ { "field": "decision", "oldValue": "hold", "newValue": "shortlist",
    "changedAt": "…", "changedBy": "jane@acme.com" } ]
```
`changedBy` and `reviewedBy` are durable email snapshots (set server-side,
never client-supplied; "unknown" for pre-attribution rows).

### 4.6 Templates — `GET /v1/templates`, `GET /v1/templates/{id}`
List / fetch the org's saved JD + weight templates
(`{ id, name, role, jobDescription, weights, createdAt, updatedAt }`).

> **Mutating endpoints** (save audit record, update decision/note, manage
> templates) mirror the app's existing routes and will be documented at launch;
> they follow the same org-scoping and error conventions.

---

## 5. Webhooks (planned)

Register a callback URL; CVsprings POSTs a signed JSON event when work
completes (most useful for large batches).

- **Event types:** `analysis.completed`, `analysis.batch_completed`
  (additional types may be added).
- **Payload:** `{ "id", "type", "createdAt", "data": { … } }` where `data`
  carries the relevant id(s)/summary (fetch full results via §4).
- **Signature verification** (mirrors how the product verifies its Stripe
  webhook): each request carries a signature header computed as an
  **HMAC-SHA256 of the raw request body** using your endpoint's signing secret.
  Verify against the **raw bytes** before parsing JSON; reject on mismatch.
- **Idempotency & retries:** events may arrive more than once or out of order —
  treat them idempotently (key on event `id`). Failed deliveries (non-2xx) are
  retried with backoff; design your handler to be safe under repeats.

---

## 6. File constraints (match the live product)

- Accepted types: **PDF and DOCX only**, validated by content/magic bytes
  (a renamed file of another type is rejected, not just by extension).
- **Max 10 MB per file**, **max 200 files per batch**, **max 200 MB per
  request** (all server-configurable). Violations →
  `400 { "code": "INVALID_FILE", "field": "cv"|"cvs" }`.

## 7. Rate limits, quota & errors

- **Rate limits** (per org, the same limits the app enforces):
  analysis is limited to **60 analyses-worth per org per 10 minutes**
  (a batch costs its CV count); other mutating calls **300 per org per 10
  minutes**. Over the limit →
  `429 { "code": "RATE_LIMITED", "retryAfter": <seconds> }` with a `Retry-After`
  header.
- **Plan quota:** API calls count toward the org's plan **exactly like the UI**.
  Free orgs get a monthly analysis allowance (default 25/month); Pro/Team are
  unlimited. Exceeding it →
  `402 { "code": "QUOTA_EXCEEDED", "limit": 25, "used": 25, "plan": "free" }`.
- **Common error codes:** `AUTH_REQUIRED` (401), `VALIDATION_ERROR` (400, with
  `field`), `INVALID_FILE` (400), `QUOTA_EXCEEDED` (402), `RATE_LIMITED` (429),
  `NOT_FOUND` (404), `INTERNAL_ERROR` (500, generic message — no internals
  leaked).

## 8. Compliance

API usage is subject to the **same human-oversight principle** as the rest of
the product: the API returns **advisory scores only and never makes an
automated hiring decision**. Decisions remain the recruiter's, and the audit
trail attributes them to a named human. See the
[compliance documentation](/compliance.html) and `docs/compliance/`.

---

*Draft only. Endpoints, paths, field names, and limits may change before any
public release. Contact us (see the [roadmap](./roadmap.md)) to register
interest or request early access.*

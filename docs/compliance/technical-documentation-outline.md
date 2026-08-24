# CVsprings — Technical Documentation Outline (EU AI Act Annex IV)

*Internal working document toward conformity assessment. Version 1.3.0 — 2026-06-12.*
*Sections marked **TODO** are open work items; everything else describes the system as built.*

## 1. General description of the AI system

- **Name / version:** CVsprings, v1.3.0 (frontend `CVSPRINGS_VERSION` and backend package version aligned; scoring engine identified as `cvsprings-lexical-scorer@1.3.0` on every analysis).
- **Intended purpose:** advisory candidate-fit scoring for recruitment (see `instructions-for-use.md` §1).
- **Risk classification:** high-risk, Annex III point 4 (employment / workers management — CV screening).
- **Provider:** Joyaco BV (KvK 42135911, BTW NL005523705B04) / CVsprings. **TODO:** registered address for the declaration.
- **Deployment form:** web application (SaaS). Single-page frontend + REST backend.

## 2. System architecture

- **Frontend:** single static HTML/CSS/JS page (`public/index.html`), plus static pages for compliance (`/compliance.html`) and bias & monitoring (`/bias-report.html`). Session-token auth; no CV content retained client-side beyond the browser session.
- **Backend:** Node.js / Express REST API.
  - Routes: `/api/auth/*` (sessions), `/api/analyze` + `/api/analyze/batch` (scoring), `/api/audit/*` (record-keeping, reports, CSV export), `/api/templates`, `/api/stats/*` (incl. `score-distribution`), `/health`.
  - Storage: SQLite (better-sqlite3), WAL mode. Tables: `organizations`, `users`, `sessions`, `password_resets`, `audit_log`, `audit_changes` (append-only, trigger-guarded), `templates`.
  - Multi-tenancy: every data row carries `org_id`; all queries filter by the authenticated user's organization; cross-org access returns 404.
  - File handling: uploads (PDF/DOCX, max 10 MB, max 200/batch) go to a temp dir, are content-sniffed, text-extracted (`pdf-parse` / `mammoth`), then **deleted in a `finally` block**.
- **Authentication:** bcrypt (cost 12) password hashes; session tokens stored as SHA-256 hashes, 30-day expiry; login lockout (5 failures / 15 min) and per-IP rate limits.

## 3. Scoring pipeline (the "model")

Deterministic lexical engine, no trained ML component (`src/services/scorer.js`):

1. **Keyword sub-score** — top-40 frequency-ranked unigrams/bigrams from the JD (stop-word list applied); word-boundary regex lookup in CV; score = % found.
2. **Skills sub-score** — curated `SKILLS_DB` (168 entries, `src/data/skills.js`); skills present in the JD are looked up in the CV; score = % matched, neutral 50 when JD names none.
3. **Experience sub-score** — regex extraction of "N years (of) experience" variants (capped < 50) plus seniority keyword ranks (director/VP/head/principal/staff/architect=5 … entry/intern/graduate=1); heuristic combination, clamped 0–100.
4. **Education sub-score** — highest qualification keyword rank (PhD=4, Master=3, Bachelor=2, diploma/associate/certificate=1) compared CV vs JD; fixed mapping (e.g. JD silent → 70).
5. **Overall** — weighted average (recruiter weights, validated to sum to 100), rounded; verdict bands ≥85 / ≥70 / ≥50 / else.
6. **Recommendations** — fixed template strings keyed off sub-score thresholds (advisory text only).

**Anonymizer** (`anonymizeText`): regex removal of emails, phone numbers (8+ digit sequences), URLs, address-like lines (number + street word), standalone years 1940–2015, standalone 2–4-word capitalized name lines. Applied before scoring when the deployer enables Anonymize. Photos/images never enter the pipeline (text extraction only).

**Determinism statement:** identical (CV text, JD text, weights) inputs produce identical outputs; behaviour changes only with code releases, hence engine versioning by package version.

## 4. Record-keeping and logging design (Art. 12)

- Per saved analysis: scores, weights, verdict, decision, note, JD snippet (300 chars), role, anonymized flag, `app_version`, `model_id`, `analysis_timestamp`, `reviewed_by` (server-side from session; never client-supplied), `created_at`/`updated_at`, `org_id`, record id.
- Immutability: PATCH whitelist = `decision`, `note` (server-enforced); all other fields rejected/ignored. `audit_changes` is append-only (DB triggers block UPDATE/DELETE); deletions write a full-record snapshot entry.
- Export: org-scoped CSV including all provenance columns.
- HTTP logging: pino with redaction of authorization headers, passwords, CV and JD bodies.

## 5. Instructions for use

See `instructions-for-use.md` (deployer duties, correct operation, limitations).

## 6. Human oversight measures (Art. 14)

- No automated decision anywhere in code (verified: decision values originate only from user input elements).
- Oversight hints at each decision surface; "Above threshold" labelling for score-count summaries; per-record reviewer attribution.

## 7. Accuracy, robustness, cybersecurity (Art. 15)

- **Implemented:** deterministic engine (reproducibility by construction); input validation (file type sniffing, size caps, JD minimum length, weight-sum validation); per-org scoring-consistency monitoring endpoint; rate limiting; org isolation; hashed credentials/tokens.
- **TODO — accuracy metrics:** define and run a benchmark set (sample CVs × JDs with expected ranking) per release; publish summary metrics.
- **TODO — robustness test protocol:** adversarial/edge-case suite (very long CVs, multilingual CVs, keyword stuffing, near-duplicate CVs) with pass criteria.
- **TODO — regression gate:** wire both into CI so releases ship with a recorded test result.

## 8. Risk management system (Art. 9)

See `risk-management-log.md`. **TODO:** adopt a documented review workflow (owner, sign-off) rather than ad-hoc updates.

## 9. Quality management system (Art. 17)

**TODO:** reference or establish a QMS covering change management, release versioning policy, incident handling, and post-market monitoring plan. (Release versioning and append-only audit design exist; the surrounding documented process does not yet.)

## 10. Declaration of conformity & CE marking

**TODO:** to be produced after conformity assessment; no claim is made today. Target: ahead of 2 December 2027.

## 11. Post-market monitoring plan (Art. 72)

**TODO:** formalize. Existing inputs: per-org score-distribution monitoring, risk log review cadence, deployer feedback channel.

---

*Honesty note: this outline deliberately distinguishes what exists in the codebase
today from open conformity work. Do not cite TODO sections as implemented.*

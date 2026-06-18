# CVsprings — Integration & API Roadmap

*Client-facing. Last updated 18 June 2026. Every capability is tagged
**[Available now]**, **[Planned]**, or **[Exploring]** — nothing unbuilt is
described as available, and ATS platforms are named only as intended targets,
not existing partnerships.*

CVsprings is an advisory candidate-fit scoring tool. Its analysis engine is
already API-driven internally, but there is **no public API or ATS integration
today**. This document lays out how integration works now and the direction we
intend to take, with priority driven by client demand.

---

## 1. Today — what exists now **[Available now]**

Integration today means **manual upload and export**. Specifically:

- **Single & batch CV upload** — upload one CV or up to 200 at once (PDF/DOCX),
  paste a job description, and get fit scores (overall + keyword, skills,
  experience, education sub-scores) with a "why this score" breakdown.
- **CSV export** — export ranked batch results and the full audit log to CSV
  for use in spreadsheets or your own systems.
- **Branded candidate reports** — generate a print-to-PDF candidate report per
  saved record.
- **Role / JD templates** — save and reuse job descriptions and scoring weights.

There is no programmatic submission or automated push/pull with other systems
yet. Everything below is direction, not a live capability.

---

## 2. Integration approaches under consideration

### 2a. Public REST API **[Planned]**
**How it works:** a client's systems authenticate with a per-org API key and
call documented endpoints to submit CVs/JDs and retrieve scores, audit records,
and templates — the same analysis the web app produces, programmatically.
**Use case:** embed CVsprings scoring into your own recruiting tooling or
scripts. **Status:** designed; draft specification in
[`api-spec.md`](./api-spec.md). Not yet available.

### 2b. Webhooks (analysis-complete callbacks) **[Planned]**
**How it works:** you register a callback URL; when an analysis (especially a
large batch) finishes, CVsprings POSTs a signed event to your endpoint so your
system is notified rather than polling. **Use case:** trigger the next step in
your workflow as soon as results are ready. **Status:** designed alongside the
API spec; not yet available.

### 2c. Native ATS connectors **[Exploring]**
**How it works (generic pattern):** your Applicant Tracking System pushes a new
application (the CV) plus the job's description to CVsprings → CVsprings scores
it → the score and the recruiter's eventual decision are written back to the
ATS record. **Use case:** scoring appears inside the ATS your recruiters already
use, with no manual upload. **Status:** exploratory. Platforms we **intend to
support** (examples of common ATS targets, **not existing integrations**):
Greenhouse, Lever, Teamtailor, Recruitee, Personio, SmartRecruiters. We have no
partnership with any of these today; naming them indicates intended direction
only.

### 2d. Middleware (Zapier / Make) **[Exploring]**
**How it works:** once the public REST API exists, a Zapier/Make connector
could bridge CVsprings to hundreds of tools without a bespoke integration per
platform. **Use case:** a lower-effort path to broad tool coverage while native
connectors mature. **Status:** exploratory, dependent on the public API
shipping first.

---

## 3. Sequencing (phased tiers — priority follows client demand, not dates)

We deliberately commit to **phases, not calendar dates**. Order reflects
dependency and the value each unlocks; actual priority within "Exploring" is
driven by which integrations clients ask for.

- **Phase 1 — Public REST API + API keys.** Formalise the existing analysis and
  audit endpoints behind per-org API keys. *(Foundation for everything else.)*
- **Phase 2 — Webhooks.** Analysis-complete callbacks with signed payloads.
- **Phase 3 — First native ATS connector(s).** Built for the platform(s) the
  most clients request.
- **Phase 4 — Broader connector coverage** and/or Zapier/Make middleware.

We will not pre-announce a launch date for any phase we cannot commit to.

---

## 4. How to express interest

Integrations are prioritised by demand. If you want API access or a connector
for a specific ATS:

- Contact us at **{SUPPORT_EMAIL}** *(shown live on the
  [Integrations page](/integrations.html) and the in-app About panel).*
- **Tell us which ATS you use** — that directly informs which native connector
  we build first.

---

*This document describes CVsprings' intended direction and is not a commitment
to deliver any specific capability by any specific date. API usage, once
available, will be subject to the same human-oversight principle as the rest of
the product: scores are advisory and all hiring decisions remain with the
recruiter (see the [compliance documentation](/compliance.html)).*

# CVsprings — Records of Processing Activities (GDPR Art. 30(2), processor)

*v1.3.0 — 2026-06-12. Maintained by the operator (Joyaco BV) as processor.*

## Processor

- **Name / contact:** Joyaco BV (KvK 42135911, BTW NL005523705B04) [TODO: registered address].
- **Privacy contact:** value of `PRIVACY_CONTACT_EMAIL` [TODO: set in production
  environment and record here].
- **Representative / DPO:** [TODO: confirm whether either is required and
  designate if so].

## Processing activity 1 — Candidate-fit analysis (transient)

| Item | Detail |
|---|---|
| On behalf of | Each client organization (controller) using CVsprings |
| Categories of processing | Upload, text extraction, deterministic scoring of CVs against a job description; immediate deletion of files after analysis |
| Data subjects | Job applicants |
| Personal data | CV contents as provided by the candidate (may incidentally include special-category data the candidate volunteers; not requested or used as scoring features) |
| Retention | None — files deleted immediately after analysis; extracted text never persisted |
| Transfers | None to third parties (no LLM/AI provider). Processing occurs on the hosting platform — see transfers section |

## Processing activity 2 — Audit log (stored on the client's instruction)

| Item | Detail |
|---|---|
| On behalf of | Each client organization (controller) |
| Categories of processing | Storage, display, update (decision/note only), export, deletion of saved screening records; append-only change history |
| Data subjects | Job applicants; client recruiter users (reviewer attribution) |
| Personal data | Candidate name or anonymized label, file name, scores, weights, verdict, decision, recruiter notes, 300-char JD snippet, role tag, provenance metadata, reviewer email |
| Retention | Org-configurable: default 365 days, 30–1095 or keep-until-deleted; daily hard-delete job incl. change history; per-record and org-wide deletion on demand |
| Transfers | Stored on hosting platform — see transfers section |

## Processing activity 3 — Recruiter accounts and sessions

| Item | Detail |
|---|---|
| Role | Operator acts as processor for client-managed user accounts |
| Data subjects | Client recruiter users |
| Personal data | Email, bcrypt password hash, role, session metadata (hashed tokens, expiry, last login, failed-attempt counters), password-reset tokens (hashed, 30-min TTL) |
| Retention | While the account exists; sessions 30 days; reset tokens 30 minutes/single-use |
| Transfers | Hosting platform; if Resend is enabled, recruiter emails are processed by Resend, Inc. (US) for reset emails [TODO: confirm enabled + safeguard] |

## Categories of recipients

- Render, Inc. (hosting/subprocessor).
- Plausible Insights OÜ (aggregate, cookieless analytics — no personal data per
  its published policy; no candidate data sent).
- Resend, Inc. (optional, recruiter reset emails only) [TODO: enabled?].
- Google LLC (Google Fonts CDN: end-user browser IP exposure on page load; not
  a processor of candidate data).

## International transfers and safeguards (Art. 30(2)(c))

- Hosting region: [TODO: confirm Render service region. If EU/EEA: no transfer
  of stored data. If non-EU: document Render's safeguard — SCCs and/or EU–US
  Data Privacy Framework certification status].
- Plausible: EU hosting per its data policy — no transfer.
- Resend (if enabled): US — [TODO: safeguard].
- Google Fonts: visitor IP to Google (US) on page load.

## General description of security measures (Art. 30(2)(d))

Tenant isolation by organization ID enforced server-side; HTTPS in transit;
bcrypt password hashing; hashed session/reset tokens; login lockout and rate
limiting; CV files deleted post-analysis; query strings stripped from HTTP logs
and no bodies logged; immutable scoring data with append-only, attributed
change history; org-configurable retention with daily hard-delete; owner-only
export/delete controls with typed confirmation. [TODO: encryption at rest —
confirm hosting disk encryption.]

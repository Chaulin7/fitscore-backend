# CVsprings — Records of Processing Activities (GDPR Art. 30(2), processor)

*v1.3.0 — 2026-10-05. Maintained by the operator (Joyaco B.V.) as processor.*

## Processor

- **Name / contact:** Joyaco B.V. (KvK 42135911, BTW NL005523705B04) [TODO: registered address].
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
| Retention | Org-configurable: default 730 days, between 180 and 3,650 days; daily hard-delete job incl. change history; per-record and org-wide deletion on demand; everything deleted with the account (see "Account deletion on request") |
| Transfers | Stored on hosting platform — see transfers section |

## Processing activity 3 — Recruiter accounts and sessions

| Item | Detail |
|---|---|
| Role | Operator acts as processor for client-managed user accounts |
| Data subjects | Client recruiter users |
| Personal data | Email, bcrypt password hash, role, session metadata (hashed tokens, expiry, last login, failed-attempt counters), password-reset tokens (hashed, 30-min TTL) |
| Retention | While the account exists, then deleted with it (see "Account deletion on request"); sessions 30 days; reset tokens 30 minutes/single-use |
| Transfers | Hosting platform; Resend, Inc. sends the password-reset, team-invitation and trial emails to recruiter users (EU region, Ireland; SCCs in Resend's DPA — see below) |

## Processing activity 4 — Billing through Stripe (operator as controller, Art. 30(1))

<!-- TODO(i18n-legal): counsel review — added 5 October 2026. This document is the processor record (Art. 30(2)); billing is processing
     for which the operator is the controller and Stripe its processor. Kept here so the billing chain is recorded at all;
     counsel may prefer a separate controller record. Mirrors Privacy Policy section G and its Stripe row. -->

| Item | Detail |
|---|---|
| Role | Operator is the controller; Stripe Payments Europe, Limited (Ireland) is its processor for billing and payments |
| Purpose | Billing and invoicing customers for paid plans and trials |
| Data subjects | Customers' billing contacts (organization owners and whoever completes Stripe Checkout) |
| Personal data — held by Stripe | Billing name, email address, company, address, VAT ID, payment details (payment details are never received or stored by the operator) |
| Personal data — stored by the operator | On the organization record only: Stripe customer and subscription references; plan and whether it is complimentary; subscription status, when the plan last changed, current billing-period end, whether it ends then, when the account moved to the free plan; technical markers (last billing event applied, an uncompleted checkout's end, the reason a paused subscription could not be resumed) |
| Legal basis | Performance of the contract (Art. 6(1)(b) GDPR); legal obligation to keep tax records (Art. 6(1)(c) GDPR) |
| Recipients | Stripe Payments Europe, Limited (Ireland), and Stripe, LLC (US) — see transfers |
| Retention | Stripe keeps invoices and payment records under its own legal obligations. The operator keeps its billing references for as long as the account exists and deletes them with the account (see "Account deletion on request"). Joyaco B.V. keeps its own accounting records for 7 years as required by Dutch tax law |
| Transfers | Stripe may transfer data to Stripe, LLC in the US; any such transfer is covered by Stripe, LLC's certification under the EU-US Data Privacy Framework, with the European Commission's Standard Contractual Clauses in Stripe's Data Transfers Addendum as a fallback (Stripe DPA §6.1; Data Transfers Addendum clauses 2–3) |

## Account deletion on request

<!-- TODO(i18n-legal): counsel review — added 5 October 2026; same process as the Privacy Policy and DPA §4.8. -->

A customer can ask for their account to be deleted by emailing
jasper@cvsprings.com. The operator deletes the account and all associated
data within 30 days, after the subscription has ended, by running
`node scripts/delete-org.js <orgId>` in the Render shell. It shows what will be
deleted (counts per table, the organization name, the Stripe subscription on
record), refuses while the subscription has not ended, and deletes only after
the organization's name is typed to confirm. It removes the organization and
everything linked to it in one transaction — users, sessions, password-reset
tokens, invitations, audit records, change history, provenance, candidates,
screening runs, templates, usage counters, retention-run records, feature
requests, trial data (including offers and demo requests sent from its users'
addresses), branding and the uploaded logo — and logs counts only. Stripe is
not touched: invoices and payment records remain with Stripe, and Joyaco B.V.
keeps its own accounting records for 7 years as required by Dutch tax law.
Deleted data can persist in backups until they expire (see the retention
policy).

## Categories of recipients

- Render, Inc. (hosting/subprocessor).
- Plausible Insights OÜ (aggregate, cookieless analytics — no personal data per
  its published policy; no candidate data sent).
- Resend, Inc. — sends every email the app sends: password resets, team
  invitations and trial emails to recruiter users and trial recipients;
  confirmations to demo requesters; and contact-form messages, demo requests
  and feature requests to our own inbox. Never candidate data. The full list,
  with recipients and contents, is pinned in src/routes/emailInventory.test.js.
- Stripe Payments Europe, Limited (Ireland) — billing and payments for paid
  plans and trials (activity 4); the operator's processor. Never candidate
  data.

## International transfers and safeguards (Art. 30(2)(c))

- Hosting region: [TODO: confirm Render service region. If EU/EEA: no transfer
  of stored data. If non-EU: document Render's safeguard — SCCs and/or EU–US
  Data Privacy Framework certification status].
- Plausible: EU hosting per its data policy — no transfer.
- Resend: emails are sent from Resend's EU region (Ireland); any transfer to
  the US (Resend, Inc. is a US company) is covered by the Standard Contractual
  Clauses in Resend's DPA.
- Stripe: billing data is processed by Stripe Payments Europe, Limited
  (Ireland). Stripe may transfer data to Stripe, LLC in the US; any such
  transfer is covered by Stripe, LLC's certification under the EU-US Data
  Privacy Framework, with the European Commission's Standard Contractual
  Clauses in Stripe's Data Transfers Addendum as a fallback.
  Sources: https://stripe.com/legal/dpa §6.1 (updated 28 September 2026) and
  https://stripe.com/legal/dta clauses 2–3 (updated 18 November 2025).

## General description of security measures (Art. 30(2)(d))

Tenant isolation by organization ID enforced server-side; HTTPS in transit;
bcrypt password hashing; hashed session/reset tokens; login lockout and rate
limiting; CV files deleted post-analysis; query strings stripped from HTTP logs
and no bodies logged; immutable scoring data with append-only, attributed
change history; org-configurable retention with daily hard-delete; owner-only
export/delete controls with typed confirmation. [TODO: encryption at rest —
confirm hosting disk encryption.]

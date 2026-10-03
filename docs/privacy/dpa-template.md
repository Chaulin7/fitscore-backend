# Data Processing Agreement (DPA) — CVsprings

> **DRAFT — for legal review before signature.**
> Template v1.3.0, 2026-10-03. Square-bracketed items and TODO markers must be
> completed before use. This draft follows the structure of GDPR Article 28(3).

**Between:**

- **[Client legal name]** — the recruiter's organization, acting as data
  **Controller** ("Client"); and
- **Joyaco B.V. (KvK 42135911, BTW NL005523705B04), Leidsegracht 34, 1016 CM Amsterdam, Netherlands**,
  operator of CVsprings, acting as data **Processor** ("Processor").

## 1. Subject matter and duration

The Processor provides the CVsprings service: advisory candidate-fit scoring of
CVs against job descriptions by an automated, rules-based screening tool, with an
organization-scoped audit log.
This DPA applies for as long as the Client holds a CVsprings account and until
all personal data has been deleted or returned per clause 9.

## 2. Nature and purpose of processing

- Transient processing of CV files and extracted CV text for the purpose of
  computing advisory fit scores (files deleted immediately after analysis;
  scoring runs inside the Processor's backend; no CV content is sent to any
  third-party AI service).
- Storage of audit records the Client chooses to save (candidate name or
  anonymized label, file name, scores, weights, verdict, recruiter decision and
  notes, job-description snippet, provenance metadata, reviewer email),
  org-scoped to the Client.
- Account and session management for the Client's users.

## 3. Categories of data subjects and personal data

- **Data subjects:** job applicants whose CVs the Client submits; the Client's
  recruiter users.
- **Personal data:** CV contents as volunteered by the candidate — which may
  incidentally include **special-category data the candidate has chosen to
  include** (e.g. references to health, religion, union membership). The
  Processor does not request, extract, or use such data as scoring features;
  the Client should instruct candidates/recruiters accordingly. For recruiter
  users: email address, hashed password, session metadata.

## 4. Processor obligations

The Processor shall:

1. **Instructions only** — process personal data only on the Client's documented
   instructions (including this DPA and the Client's use of in-product controls),
   unless required by EU/Member State law, in which case the Processor informs
   the Client unless legally prohibited.
2. **Confidentiality** — ensure persons authorised to process the data are bound
   by confidentiality obligations.
3. **Security (Art. 32)** — implement the technical and organizational measures
   in Annex II.
4. **Subprocessors** — engage only the subprocessors listed in Annex I; inform
   the Client of intended additions/replacements in advance, giving the Client
   the opportunity to object. The Processor remains liable for subprocessor
   performance.
5. **Data-subject requests** — taking into account the nature of processing,
   assist the Client with appropriate technical measures to fulfil access,
   rectification, erasure, restriction, portability and objection requests
   (in-product: per-record search and deletion, org-wide JSON export, org-wide
   deletion, retention settings). Requests received directly from candidates
   are forwarded to the Client without undue delay.
6. **Breach notification** — notify the Client **without undue delay** after
   becoming aware of a personal data breach affecting the Client's data,
   providing the information reasonably required for the Client's own
   obligations under Arts. 33–34.
7. **Assistance** — assist the Client with DPIAs and prior consultations
   (Arts. 35–36) insofar as they concern the service.
8. **Deletion/return on termination** — on termination of the service, at the
   Client's choice, delete or return all personal data (in-product: org-wide
   JSON export, then org-wide deletion), and delete remaining copies unless
   EU/Member State law requires storage. [TODO: confirm backup deletion window
   — see retention-policy.md backup section.]
9. **Audit rights** — make available information necessary to demonstrate
   compliance with Art. 28 and allow for and contribute to audits/inspections
   conducted by the Client or its mandated auditor, on reasonable notice.

## 5. International transfers

Personal data is processed in the hosting region listed in Annex I.

## 6. Liability, term, governing law

[TODO: legal review — liability allocation, term/termination alignment with the
main service agreement, governing law and jurisdiction.]

---

## Annex I — Authorised subprocessors

*Only the subprocessors that process the Client's personal data. Each row is word for
word the CVsprings Privacy Policy's row for that subprocessor (first four columns) and
its International transfers entry (last column). Change them together.*

| Subprocessor | Purpose | Location / region | Terms | International transfers |
|---|---|---|---|---|
| Render | Hosting of the CVsprings backend and database (incl. stored audit records). | Render, Inc. (US company). Service region: Frankfurt, Germany (EU). Because Render, Inc. is a US company, any transfer of data to the US is covered by Render’s certification under the EU-US Data Privacy Framework, with the European Commission’s Standard Contractual Clauses in Render’s Data Processing Agreement as a fallback. | [Render DPA](https://render.com/dpa) | the CVsprings backend and its database (including stored audit records) run in Render’s Frankfurt (EU Central) region, so candidate data at rest does not leave the EU/EEA. Because Render, Inc. is a US company, any transfer of data to the US is covered by Render’s certification under the EU-US Data Privacy Framework, with the European Commission’s Standard Contractual Clauses in Render’s Data Processing Agreement as a fallback. |
| Resend | Sends our emails: password resets and trial notices to recruiter accounts (trial notices go to the organization’s owner, or to the address the trial was offered to); invitations to invited team members; confirmations to demo requesters; and contact-form messages, demo requests and feature requests to our own inbox. Processes the recipients’ email addresses and what these emails contain (such as names, organization names and the text people send us); never candidate data. | Resend, Inc. (US). | [Resend DPA](https://resend.com/legal/dpa) | Resend is US-based and processes the emails described in the Resend row above: to recruiter accounts, invited team members and demo requesters, and the contact-form messages, demo requests and feature requests sent to our inbox. Emails are sent from Resend’s EU region (Ireland). Because Resend, Inc. is a US company, any transfer of this data to the US is covered by the European Commission’s Standard Contractual Clauses included in Resend’s Data Processing Agreement. |

*Not a subprocessor:* no AI/LLM provider — scoring runs inside the Processor's
backend.

## Annex II — Technical and organizational measures

- **Tenant isolation:** every stored record carries an organization ID; all
  queries are scoped server-side; cross-organization access returns "not found".
- **Encryption in transit:** all traffic over HTTPS/TLS (hosting platform).
- **Credential protection:** passwords hashed with bcrypt (cost 12); session
  and reset tokens stored only as SHA-256 hashes; login lockout and per-IP
  rate limiting.
- **Data minimisation:** CV files deleted immediately after analysis; extracted
  CV text never persisted; audit records store summary data only; HTTP logs
  strip query strings and never contain request bodies, CV text, or candidate
  names.
- **Retention controls:** org-configurable retention (default 365 days,
  30–1095 or keep-until-deleted) enforced by a daily hard-delete job including
  change history; per-record deletion; org-wide export and deletion (owner-only,
  typed confirmation).
- **Record integrity:** scoring data immutable after creation; append-only
  change history with reviewer attribution.
<!-- Source: https://render.com/docs/disks — "All disks are encrypted at rest, and so are their automatic daily snapshots." -->
- **Encryption at rest:** Data at rest, including backups, is stored on encrypted disks
  provided by Render; data in transit is protected with TLS.
- **Organisational measures:** Access to production systems is limited to the founder;
  two-factor authentication is enforced on all service accounts (hosting, email,
  billing, DNS, code repository); credentials are stored in a password manager; work
  devices use full-disk encryption.

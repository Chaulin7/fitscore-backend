# CVsprings — Data Retention Policy (internal)

*v1.3.0 — 2026-10-05. One-pager: what is stored where, for how long, and how it is deleted.*

## What is stored where

| Data | Where | Created when | Contents |
|---|---|---|---|
| CV files | `uploads/` temp dir on the app server | On upload | Raw PDF/DOCX. **Deleted in a `finally` block immediately after text extraction/scoring** (both single and batch). Never persisted. |
| Extracted CV text | Process memory only | During analysis | Never written to disk, DB, or logs. Not sent to any third party (no LLM). |
| Audit records | SQLite `audit_log` (Render persistent disk via `DB_PATH`) | When a recruiter saves a result / autosave | Candidate name or anonymized label, file name, scores, weights, verdict, decision, notes, 300-char JD snippet, role, anonymized flag, app/engine versions, analysis timestamp, reviewer email, org ID. |
| Change history | SQLite `audit_changes` (append-only, trigger-guarded) | On every decision/note change or record deletion | Field-level old/new values; deletion snapshots contain the full record JSON. |
| Templates | SQLite `templates` | When saved by a user | JD text, role, weights, org ID. |
| Accounts/sessions | SQLite `users`, `sessions`, `password_resets` | Signup/login/reset | Email, bcrypt password hash, hashed tokens, login metadata. |
| HTTP logs | Hosting platform log stream (Render) | Per request | Method + path only (query strings stripped — they can contain candidate-name searches); no bodies; auth headers redacted. Reset links (user email + token URL) are logged **only** when no email provider is configured (dev fallback). |
| Analytics | Plausible (EU per its policy) | Page events | Aggregate, cookieless event counts; no candidate data is sent. |

## Retention defaults and configuration

- **Audit records + change history:** default **730 days** per organization.
  Org owners can set **between 180 and 3,650 days**
  (Settings → Data Retention; stored on the organization record server-side).
  The 180-day floor is enforced at the API and again inside the purge job.
- **Templates, accounts, sessions:** kept while the account exists; sessions
  expire after 30 days; password-reset tokens after 30 minutes (single-use).
- **CV files / extracted text:** zero retention (see table).

## Deletion mechanisms

1. **Daily retention purge** (`purgeExpiredAudits`, scheduled in the server,
   also runs at boot): hard-deletes audit records older than the org's setting,
   their change-history rows, and any change rows (incl. deletion snapshots)
   older than the cutoff. Logs **counts only**, never contents.
2. **Per-record deletion** (recruiter UI): removes the record; a deletion
   snapshot is written to the change history for audit integrity and then ages
   out under the same retention clock. This is the mechanism for candidate
   erasure requests (search by name → delete).
3. **Org-wide deletion** (owner-only, typed-name confirmation):
   `DELETE /api/org/audit-data` hard-deletes all org audit records + change
   history immediately.
4. **Org export** (owner-only): `GET /api/org/export` produces a full JSON of
   audit records (incl. change history) and templates — used for portability
   and offboarding before deletion.

## Backups

Production data is backed up through automatic daily snapshots of the encrypted
disk, managed by Render and retained for at least seven days.
Manual backups taken before maintenance are stored on the same encrypted disk
and deleted within 30 days.

- **Render snapshots:** automatic, daily, of the encrypted persistent disk;
  Render keeps them for at least seven days. Deleted data can persist in them
  for that long — state this alongside the live deletion when answering an
  erasure request.
- **Manual backups** (before a deploy, a migration or go-live): taken with
  SQLite's `.backup` onto the same disk (README, "Backing up the production
  database"), and deleted within 30 days — so deleted data can also persist
  in one for up to 30 days. `node scripts/list-backups.js`
  lists every backup file on the disk, read-only, and flags any older than
  30 days.

## Review

Owner: operator (Joyaco B.V.). Review this policy when the data model, hosting, or
retention features change, and at least every 12 months. Next review:
**2027-06-12** or on change, whichever is first.

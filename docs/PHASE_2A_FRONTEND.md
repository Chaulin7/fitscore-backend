# Phase 2A: Frontend wire-up

Wires the CVsprings frontend (`public/landing.html` + `public/index.html`) to the v1.1 backend's structured error envelope, PATCH endpoints, server-side audit pagination, server-stored templates, and `/health`. Adds a Pro/Team waitlist intent flow, status badge, and Plausible analytics. No auth, no plans, no billing — the backend doesn't expose those yet.

## What landed

### PR #2 (`feat/frontend-backend-wireup-2026`)
- **Section 1** — Single `api()` helper at `API_BASE = localStorage.getItem('cvsprings_api_url') || 'https://cvsprings7.onrender.com'`. `handleApiError()` routes `VALIDATION_ERROR` → field flash + toast, 503 / network → "Server is waking up" + auto-retry on safe paths.
- **Section 2** — Audit log: single `PATCH` for decision/note (was DELETE+POST), per-row change-history modal (⧉), server-side debounced filter + pagination with legacy-array fallback, filter-aware empty state with "Clear filters".
- **Section 4 (partial)** — `highlightField()`, 503 auto-retry on safe paths, skeleton loader.

### PR #3 (`feat/frontend-backend-wireup-2026-pt2`)
- **Section 3** — Templates moved to `GET/POST/PATCH/DELETE /api/templates` with localStorage offline fallback and a one-time migration banner.
- **Section 4.4** — Landing status badge polling `/health` with 60s sessionStorage cache (states: ok/warn/err/unknown).
- **Section 5** — Pro/Team landing CTAs intercept default navigation, save `cvsprings_waitlist` intent, and redirect to `/index.html?intent=waitlist&plan=X`. The in-app banner reads this and shows a dismissible confirmation; URL params are stripped via `history.replaceState`.
- **Section 6** — Plausible analytics on both pages, 5 events: `landing_cta_clicked`, `waitlist_signup`, `analyze_completed`, `audit_saved`, `template_saved`.
- **Section 8** — This document.
- **Bonus** — Fixed the literal "undefined" prefix bug at the top of `landing.html` introduced by the S0 setup commit.

## Config & localStorage keys

| Key | Set by | Read by | Purpose |
|---|---|---|---|
| `cvsprings_api_url` | manual / app settings | `api()` everywhere | Override backend base URL |
| `cvsprings_api` | app settings | DOMContentLoaded init | Legacy alias for `apiUrl` form field |
| `cvsprings_templates` | legacy localStorage templates | migration banner | Pre-S3 storage; read once for migration |
| `cvsprings_templates_migrated_v1` | migration banner Upload/Dismiss | banner gate | Prevents banner re-show |
| `cvsprings_templates_offline_cache` | `refreshTemplatesCache()` | offline fallback | Last-known server list |
| `cvsprings_price_period` | landing monthly/yearly toggle | landing CTA capture | Persists pricing toggle + sent with waitlist intent |
| `cvsprings_waitlist` | landing Pro/Team CTA + in-app URL arrival | in-app banner | Intent: `{plan, period, source, ts}` |
| `cvsprings_waitlist_dismissed_v1` | in-app banner Dismiss | banner gate | Suppresses banner on future visits |
| `cvsprings_health_cache_v1` (sessionStorage) | status badge ping | status badge load | Caches `{state, copy, ts}` for 60s |

## Plausible setup

The script tag is added to both pages with `data-domain="cvsprings.onrender.com"` as a placeholder. To finish:

1. Register the production domain in your Plausible account.
2. Swap `data-domain="cvsprings.onrender.com"` to your real domain in both `public/landing.html` and `public/index.html` (each in `<head>`).
3. Optional: add custom-event goals in Plausible for the 5 events listed below to track conversion in the dashboard.

Events fired:

| Event | Props | Fired from |
|---|---|---|
| `landing_cta_clicked` | `plan`, `source`, `period` | Every CTA click on landing |
| `waitlist_signup` | `plan`, `period`, `source` | Pro/Team CTA click + in-app arrival via `?intent=waitlist` |
| `analyze_completed` | `mode` (single/batch), `role`, `count` | Single + batch analyze success |
| `audit_saved` | `mode` (single/batch_row), `role` | `saveCurrent()` + `saveSingleBatch()` |
| `template_saved` | `name`, `role` | `saveTemplate()` success |

## Manual test plan

### Fetch layer + errors
1. **Cold backend wake-up** — with backend asleep, click Analyze. Expect "Server is waking up" toast + automatic retry; analyze should succeed on retry.
2. **Validation error highlights field** — submit analyze with empty Job Description. Expect field flash + error toast (not raw `alert()`).

### Audit log
3. **PATCH decision** — change a decision on an existing audit row. Expect single PATCH request (DevTools), success toast.
4. **Change history** — click ⧉ on any row. Expect modal with timeline from `GET /api/audit/:id/changes`. Esc closes.
5. **Debounced search** — type in the audit search box. Expect one request ~300ms after typing stops (not per-keystroke).
6. **Filter empty state** — set decision filter to a value with no matches. Expect "No records match these filters" + Clear filters button. Click clears + reloads.
7. **Pagination** — with >50 audit records, expect pager appears, Next fetches with `offset=50`.
8. **Skeleton loader** — first audit-tab open shows skeleton rows before real data renders.

### Templates
9. **Save template** — fill form, click Save Template, name it. Expect POST to `/api/templates`, "Template saved" toast.
10. **Load template** — click a chip in the templates panel. Form fields populate.
11. **Update template** — save again with the same name. Expect PATCH (not POST), no duplicate.
12. **Delete template** — click × on a chip. Confirm. Expect DELETE, removed from panel.
13. **Migration banner** — with pre-existing `cvsprings_templates` localStorage entries (e.g. seed via DevTools), reload. Expect banner "You have N templates saved locally". Click Upload, expect bulk POST + success toast + `cvsprings_templates_migrated_v1=1`.
14. **Offline templates** — block requests to `/api/templates` in DevTools, reload. Expect "Templates offline" warn toast + last-known cache shown.

### Landing + waitlist
15. **Status badge** — load landing.html. Expect dot turns green ("online") within a few seconds. Hover for tooltip.
16. **Status badge cache** — refresh landing.html within 60s of first load. Expect no new `/health` request (badge state read from sessionStorage).
17. **Pro CTA waitlist** — click "Start 14-day trial" on Pro card. Expect redirect to `/index.html?intent=waitlist&plan=pro`, then top banner "Thanks — we'll let you know when Pro launches", URL cleaned to `/index.html`.
18. **Team CTA waitlist** — same as #17 but plan=team.
19. **Dismiss banner** — click Dismiss on the waitlist banner. Reload — banner does not reappear.
20. **Starter CTA** — click "Start free". Should navigate normally (no banner).

### Analytics
21. **Open DevTools → Network → filter `plausible.io`** before each of the above 20 flows where applicable. Expect one event per success.

### Mobile (375px)
22. Resize to iPhone SE width. Verify: header nav doesn't overflow, status badge fits, audit table is scrollable, modal is full-width, waitlist banner wraps.

## Backward compatibility

- `buildAuditQuery()` only emits `limit`/`offset` when filters are active, so bare `GET /api/audit` still returns the legacy array.
- `renderAuditTable()` detects array vs `{records,total,limit,offset}` and renders both.
- `getTemplates()` retained as a thin wrapper over the new `_tplCache`, so existing callers (`renderTplChips`, `loadTemplate`) work unchanged.
- All new toasts have fallback to no-op if `toast()` is undefined (defensive).
- All localStorage reads/writes are try/catch-wrapped (private mode safe).

## Known limitations (Phase 2A scope)

- **No auth** — templates are stored with `owner_id=NULL` and visible to all users on the deployment. The brief calls this out as Phase 2B work.
- **No real billing** — "14-day trial" copy on Pro/Team is now a waitlist signup, not a checkout. Real billing waits for backend + Stripe in a future phase.
- **Plausible domain** — placeholder `cvsprings.onrender.com` needs to be swapped once you register the real Plausible site.
- **Mobile pass** — flow #22 was not exercised by the automation; needs a human run before un-drafting PR #3.

## Pre-existing notes

`public/index.html` line 15 has UTF-8 mojibake (`Ã` sequences) that predates this work. It's inside CSS comment / decoration whitespace and doesn't affect rendering. Identical on `main`.

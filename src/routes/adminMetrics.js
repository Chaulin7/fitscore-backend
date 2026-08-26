'use strict';

/**
 * src/routes/adminMetrics.js — GET /admin/metrics, the internal operator
 * dashboard.
 *
 * This is the one route in the application that reads across tenants. Every
 * other route derives req.orgId from the session and scopes every query to it;
 * this one deliberately does not, which is why the guard in front of it is
 * stricter than anything else here and why it is mounted OUTSIDE /api.
 *
 * NOT DISCOVERABLE. Every rejection — no credential, expired session, a valid
 * session belonging to somebody else, a non-owner member — returns the same
 * 404 JSON body the application's catch-all 404 returns, so the route is
 * indistinguishable from a path that does not exist. In particular it does not
 * 401: a 401 on /admin/metrics next to a 404 on /admin/metricz tells a prober
 * exactly which of the two is real.
 *
 * NO USER DATA LEAVES THE SERVER. The page is server-rendered with no external
 * scripts, no fonts, no analytics and no third-party dependency of any kind
 * (the only outbound call in the whole feature is to Stripe, about our own
 * account, and only when ?reconcile=1 asks for it).
 */

const express = require('express');
const crypto = require('crypto');

const authService = require('../services/authService');
const metrics = require('../services/metrics');
const stripeReconcile = require('../services/stripeReconcile');
const { getDb } = require('../services/db');
const { BRANDMARK_SVG } = require('../services/brandmark');
const { CURRENCY } = require('../config/plans');
// The owner rule lives in config/platformOwner so this guard and the
// isPlatformOwner flag on the session payload cannot drift apart. See the
// header there for why a second copy would fail quietly.
const { ownerEmail, isPlatformOwner } = require('../config/platformOwner');

const router = express.Router();

const ROUTE_PATH = '/admin/metrics';

function notFound(res) {
  // Byte-identical to the application's catch-all in src/index.js.
  return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', path: ROUTE_PATH });
}

/**
 * Resolve the caller, or null.
 *
 * Two credentials, both existing mechanisms, no new one invented:
 *
 *   Authorization: Bearer …  the normal session token, same lookup
 *                            middleware/auth.requireSession does.
 *   ?dt=…                    a single-use 60s download token from
 *                            POST /api/auth/download-token. This page is opened
 *                            in a browser tab, and a browser tab cannot send an
 *                            Authorization header — the same constraint that
 *                            put ?dt= on the HTML report and the CSV export.
 *
 * A session token is never accepted from the query string. It is long-lived,
 * and a URL lands in browser history, in a Referer, and in any log that does
 * not strip query strings. The download token is minted for one navigation and
 * is dead by the time the page has rendered.
 */
function resolveCaller(req) {
  const header = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) {
    const found = authService.findSessionByToken(bearer[1].trim());
    if (found && found.user) return { user: found.user, authMethod: 'session' };
  }

  const dt = req.query && req.query.dt;
  if (dt && req.method === 'GET') {
    const grant = authService.consumeDownloadToken(String(dt));
    if (grant && grant.userId) {
      const user = authService.findUserById(grant.userId);
      if (user) return { user, authMethod: 'download_token' };
    }
  }

  return null;
}

/**
 * Owner-only guard. 404 on every failure path.
 *
 * The ownership rule itself is config/platformOwner.isPlatformOwner — email AND
 * role 'owner', compared timing-safely. This function's job is the 404, not the
 * rule: routes/auth publishes the same predicate to the SPA so the menu item and
 * this gate agree by construction rather than by both being kept up to date.
 *
 * Re-derived from the session on every request. The client's isPlatformOwner
 * flag is a rendering hint and is never consulted here.
 */
function isOwner(req, res, next) {
  const caller = resolveCaller(req);
  if (!caller) return notFound(res);
  if (!isPlatformOwner(caller.user)) return notFound(res);

  req.adminUser = caller.user;
  req.adminAuthMethod = caller.authMethod;
  return next();
}

/**
 * One row per access, written before the page is rendered.
 *
 * SERVER-ATTESTED, the rule routes/audit.js applies to a save: every value
 * below is produced by this process or read off the resolved session row. The
 * request contributes exactly one bit — whether ?reconcile=1 was present — and
 * it is coerced to 0/1 here, so it can express nothing but itself. No header,
 * query string, body or user agent is stored verbatim, and req.query is never
 * read again after this line.
 *
 * It writes to admin_access_log, NOT to audit_log. audit_log is the EU AI Act
 * Art. 12 record of candidate assessments: it requires a candidate_name, the
 * bias report aggregates over every row in it, and the retention purge deletes
 * from it on the org's schedule. An operator page view is none of those things,
 * and putting one there would put operator telemetry inside a regulatory record
 * and let a retention purge quietly erase the access trail.
 *
 * A logging failure must not deny the operator their dashboard, but it must not
 * pass unnoticed either — it is logged loudly and the page still renders.
 */
function writeAccessLog(req, reconcileRequested) {
  try {
    getDb().prepare(`
      INSERT INTO admin_access_log (id, user_id, email, org_id, route, auth_method, reconcile, created_at)
      VALUES (@id, @userId, @email, @orgId, @route, @authMethod, @reconcile, @createdAt)
    `).run({
      id: crypto.randomUUID(),
      userId: req.adminUser.id,
      email: req.adminUser.email,
      orgId: req.adminUser.org_id,
      route: ROUTE_PATH,
      authMethod: req.adminAuthMethod,
      reconcile: reconcileRequested ? 1 : 0,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[admin] access log write failed — page still served:', err && err.message);
  }
}

// --- rendering --------------------------------------------------------------

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(amount) {
  return `${CURRENCY.symbol}${Number(amount || 0).toLocaleString('en-IE')}`;
}

function pct(value) {
  return value == null ? '—' : `${value}%`;
}

function shortDate(iso) {
  return iso ? String(iso).slice(0, 10) : '—';
}

/**
 * The 90-day signups chart, as inline SVG.
 *
 * Hand-built rather than pulled from a chart library on purpose: no third-party
 * analytics or charting dependency is being added, and a CDN <script> would be
 * blocked by the CSP anyway. It is one polyline over a fixed viewBox, scaled by
 * plain arithmetic, and it needs no JavaScript to render at all.
 */
function renderChart(series) {
  if (!series || series.length < 2) {
    return '<p class="empty">Not enough snapshot history yet — the chart fills in as the daily job runs.</p>';
  }

  const W = 900;
  const H = 220;
  const PAD = { top: 16, right: 16, bottom: 28, left: 40 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const values = series.map((p) => p.signups);
  // Never scale to a zero maximum: a flat all-zero series would divide by zero
  // and every point would land on NaN, producing an empty <polyline> that looks
  // like a rendering bug rather than like a quiet week.
  const maxY = Math.max(1, ...values);
  const stepX = series.length > 1 ? plotW / (series.length - 1) : 0;

  const x = (i) => PAD.left + i * stepX;
  const y = (v) => PAD.top + plotH - (v / maxY) * plotH;

  const points = series.map((p, i) => `${x(i).toFixed(1)},${y(p.signups).toFixed(1)}`).join(' ');
  const area = `${PAD.left},${PAD.top + plotH} ${points} ${(PAD.left + (series.length - 1) * stepX).toFixed(1)},${PAD.top + plotH}`;

  // Four horizontal gridlines with integer labels — signups are whole numbers,
  // so a "2.5 signups" axis tick would be nonsense.
  const ticks = [];
  const tickCount = Math.min(4, maxY);
  for (let i = 0; i <= tickCount; i++) {
    const v = Math.round((maxY / tickCount) * i);
    const gy = y(v);
    ticks.push(
      `<line x1="${PAD.left}" y1="${gy.toFixed(1)}" x2="${W - PAD.right}" y2="${gy.toFixed(1)}" class="grid"/>`
      + `<text x="${PAD.left - 8}" y="${(gy + 4).toFixed(1)}" class="axis" text-anchor="end">${v}</text>`,
    );
  }

  const first = series[0].date;
  const last = series[series.length - 1].date;
  const mid = series[Math.floor(series.length / 2)].date;
  const total = values.reduce((s, v) => s + v, 0);

  return '<figure class="chart">'
    + `<svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="none" `
    + `aria-label="Signups per day over the last ${series.length} days, ${total} in total">`
    + ticks.join('')
    + `<polygon class="area" points="${area}"/>`
    + `<polyline class="line" points="${points}"/>`
    + `<text x="${PAD.left}" y="${H - 8}" class="axis">${esc(first)}</text>`
    + `<text x="${(W / 2).toFixed(0)}" y="${H - 8}" class="axis" text-anchor="middle">${esc(mid)}</text>`
    + `<text x="${W - PAD.right}" y="${H - 8}" class="axis" text-anchor="end">${esc(last)}</text>`
    + '</svg>'
    + `<figcaption>${total} signup${total === 1 ? '' : 's'} across ${series.length} days · peak ${maxY}/day</figcaption>`
    + '</figure>';
}

/**
 * Revenue that is still arriving and has already been cancelled.
 *
 * Rendered next to the past_due "at risk" figure because the two are the only
 * ways money in the headline MRR is not money that stays — but they are not the
 * same failure, and the table says which is which: past_due may still be paid,
 * this will definitely stop, on a date.
 */
function renderChurning(churning) {
  if (!churning.count) {
    return '<div class="section"><h2>Cancelling at period end</h2>'
      + '<p class="ok">No active subscription is set to cancel.</p></div>';
  }

  let html = '<div class="section"><h2>Cancelling at period end</h2>'
    + `<p class="muted"><strong>${esc(money(churning.mrrEur))}</strong> across `
    + `${churning.count} account${churning.count === 1 ? '' : 's'} — still active, still billing, `
    + 'set to stop at the end of the current period.</p>'
    + '<table><thead><tr><th>Account</th><th>Owner</th><th>Plan</th>'
    + '<th>Ends</th><th class="num">MRR</th></tr></thead><tbody>';

  for (const a of churning.accounts) {
    html += '<tr class="row-warn">'
      + `<td>${esc(a.name)}${a.comped ? ' <span class="tag">comped</span>' : ''}</td>`
      + `<td class="mono">${esc(a.ownerEmail || '—')}</td>`
      + `<td>${esc(a.plan || '—')}</td>`
      // The date is the point: it says WHEN, not just how much.
      + `<td>${esc(shortDate(a.currentPeriodEnd) || 'unknown')}</td>`
      + `<td class="num">${esc(money(a.mrrEur))}</td></tr>`;
  }
  return `${html}</tbody></table></div>`;
}

/**
 * The passive drift indicator.
 *
 * Read from metrics_daily, written by the nightly job in
 * services/metricsSchedule. Rendering this costs NO Stripe call — that is the
 * whole reason it is stored rather than computed here.
 *
 * A stale figure is shown WITH its age rather than hidden or refreshed: "4
 * disagreements, last checked 3 days ago" is actionable, and a blank is not.
 */
function renderDriftBanner(drift, now) {
  if (drift.count == null && !drift.error) {
    return '<p class="muted">Drift has not been checked yet — the nightly job records it on its first run.</p>';
  }

  let html = '';
  if (drift.count != null) {
    const ageMs = Date.parse(now) - Date.parse(drift.checkedAt);
    const ageHours = Math.max(0, Math.round(ageMs / 3600000));
    const age = ageHours < 48 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)} days ago`;
    const cls = drift.count > 0 ? 'warn' : 'ok';
    html += `<p class="${cls}"><strong>${drift.count}</strong> account`
      + `${drift.count === 1 ? '' : 's'} disagreed with Stripe at the last nightly check `
      + `(${esc(age)}, ${esc(shortDate(drift.checkedAt))}). No API call was made to render this.</p>`;
  }
  if (drift.error) {
    // Said out loud, next to the stale number it explains. Silence here would
    // let a permanently-failing check masquerade as a permanently-clean one.
    html += `<p class="warn">Last drift check did not complete (${esc(drift.errorDate)}): `
      + `${esc(drift.error)} — the count above, if any, is from before that.</p>`;
  }
  return html;
}

function renderReconcile(reconcile) {
  if (!reconcile) {
    return '<div class="section">'
      + '<h2>Stripe reconciliation</h2>'
      + '<p class="muted">Not run. Reconciliation calls the Stripe API once per linked account, so it is off by default and the page stays fast.</p>'
      // data-action, never onclick: script-src-attr is 'none' (src/index.js),
      // which does not discourage an inline handler, it BLOCKS it — the button
      // would render and do nothing.
      + '<button type="button" class="btn" data-action="runReconcile">Run reconciliation</button>'
      + '</div>';
  }

  if (!reconcile.configured) {
    return '<div class="section"><h2>Stripe reconciliation</h2>'
      + `<p class="warn">${esc(reconcile.error)}</p></div>`;
  }

  const real = reconcile.findings.filter((f) => !f.informational);
  const info = reconcile.findings.filter((f) => f.informational);

  let html = '<div class="section"><h2>Stripe reconciliation</h2>'
    + `<p class="muted">${reconcile.checked} account${reconcile.checked === 1 ? '' : 's'} checked against Stripe`
    + (reconcile.capped ? ` (capped at ${stripeReconcile.MAX_ORGS_TO_CHECK}, newest first)` : '')
    + `. ${real.length} disagreement${real.length === 1 ? '' : 's'}.</p>`
    + (reconcile.cancelFlagsWritten
      ? `<p class="muted">Backfilled <strong>${reconcile.cancelFlagsWritten}</strong> pending-cancellation `
        + 'flag(s) from Stripe. Only cancel_at_period_end is written here — plan and status '
        + 'remain the webhook\'s to set.</p>'
      : '');

  if (!reconcile.findings.length) {
    html += '<p class="ok">Every linked account agrees with Stripe.</p></div>';
    return html;
  }

  html += '<table><thead><tr><th>Account</th><th>Owner</th><th>Local</th><th>Stripe</th><th>Finding</th></tr></thead><tbody>';
  for (const f of [...real, ...info]) {
    html += `<tr class="${f.informational ? 'row-info' : 'row-warn'}">`
      + `<td>${esc(f.orgName)}${f.comped ? ' <span class="tag">comped</span>' : ''}</td>`
      + `<td class="mono">${esc(f.ownerEmail || '—')}</td>`
      + `<td>${esc(f.localPlan || '—')} / ${esc(f.localStatus || 'none')}</td>`
      + `<td>${esc(f.stripePlan || '—')} / ${esc(f.stripeStatus || 'none')}</td>`
      + `<td><span class="code">${esc(f.code)}</span> ${esc(f.note)}</td>`
      + '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function renderPage(data, reconcile, nonce) {
  const { plans, statuses, activation } = data;
  const planRows = [
    ['free', 'Free'], ['pro', 'Pro'], ['team', 'Team'], ['unknown', 'Unknown / unset'],
  ].map(([id, label]) => ({
    label,
    count: plans.counts[id],
    price: metrics.monthlyPriceFor(id),
    mrr: plans.mrrByPlan[id],
  }));

  // The MRR headline is money collected this month; two different things can
  // make it not money that stays, and the card says which apply rather than
  // picking one. Both silent means the figure is clean.
  const mrrSubline = (p, churning) => {
    const parts = [];
    if (p.atRiskMrrEur) parts.push(`${money(p.atRiskMrrEur)} past due`);
    if (churning.mrrEur) parts.push(`${money(churning.mrrEur)} cancelling`);
    return parts.length ? parts.join(' · ') : 'collected, ex-VAT';
  };

  const card = (label, value, sub) =>
    `<div class="card"><div class="card-label">${esc(label)}</div>`
    + `<div class="card-value">${esc(value)}</div>`
    + (sub ? `<div class="card-sub">${esc(sub)}</div>` : '') + '</div>';

  const statusRow = (key) =>
    `<tr><td>${esc(key.replace('_', ' '))}</td><td class="num">${statuses[key]}</td></tr>`;

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex, nofollow">'
    + '<title>CVsprings — internal metrics</title>'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:"Segoe UI",system-ui,Arial,sans-serif;background:#f0f2f5;color:#1a202c;font-size:14px;line-height:1.5}'
    + '.page{max-width:1000px;margin:24px auto 64px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.08)}'
    + '.header{background:#0f2847;color:#fff;padding:24px 32px;border-radius:8px 8px 0 0}'
    + '.brandrow{display:flex;align-items:center;gap:9px;margin-bottom:12px}'
    + '.brandrow .mark,.brandrow .mark svg{width:26px;height:26px;display:block}'
    + '.brandrow .wordmark{font-size:13px;font-weight:700;letter-spacing:-.2px}'
    + '.header h1{font-size:21px;font-weight:700}'
    + '.header .meta{font-size:12px;opacity:.75;margin-top:6px}'
    + '.body{padding:24px 32px}'
    + '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:28px}'
    + '.card{background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;padding:14px 16px}'
    + '.card-label{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#6b7280}'
    + '.card-value{font-size:26px;font-weight:700;margin-top:6px;color:#0f2847}'
    + '.card-sub{font-size:12px;color:#6b7280;margin-top:2px}'
    + '.section{margin-bottom:32px}'
    + '.section h2{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;'
      + 'border-bottom:1px solid #e5e7eb;padding-bottom:6px;margin-bottom:12px}'
    + 'table{width:100%;border-collapse:collapse;font-size:13px}'
    + 'th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#6b7280;'
      + 'border-bottom:1px solid #e5e7eb;padding:6px 8px}'
    + 'td{padding:7px 8px;border-bottom:1px solid #f1f3f5;vertical-align:top}'
    + 'td.num,th.num{text-align:right}'
    + '.mono,.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}'
    + '.code{background:#f1f3f5;border-radius:3px;padding:1px 5px;color:#7c2d12}'
    + '.muted{color:#6b7280;font-size:13px;margin-bottom:10px}'
    + '.empty{color:#9ca3af;font-size:13px;font-style:italic}'
    + '.ok{color:#1d7a4d;font-size:13px}'
    + '.warn{color:#a32d2d;font-size:13px}'
    + '.tag{background:#eef2ff;color:#3a5bc7;border-radius:3px;padding:1px 5px;font-size:11px;font-weight:600}'
    + '.row-warn td{background:#fbeded}.row-info td{background:#f8fafc;color:#6b7280}'
    + '.btn{background:#0f2847;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:13px;'
      + 'font-weight:600;cursor:pointer}'
    + '.btn:hover{background:#1a3a63}.btn[disabled]{opacity:.6;cursor:progress}'
    + '.chart{margin:0}'
    + '.chart svg{width:100%;height:220px;display:block}'
    + '.chart .grid{stroke:#e5e7eb;stroke-width:1}'
    + '.chart .axis{fill:#9ca3af;font-size:11px;font-family:inherit}'
    + '.chart .line{fill:none;stroke:#3a5bc7;stroke-width:2;stroke-linejoin:round}'
    + '.chart .area{fill:rgba(58,91,199,.12);stroke:none}'
    + '.chart figcaption{font-size:12px;color:#6b7280;margin-top:6px}'
    + '.footnote{font-size:11px;color:#9ca3af;line-height:1.6;margin-top:8px}'
    + '</style></head><body><div class="page">'

    + '<div class="header">'
    // The CVsprings brandmark, inlined from services/brandmark.js — the same
    // constant the PDF report and the bias report use, so this page cannot
    // drift onto a different mark. Inline SVG rather than <img src=…> so it
    // needs no second request and no img-src allowance.
    + '<div class="brandrow"><span class="mark" aria-hidden="true">'
    + BRANDMARK_SVG.replace(/#000(?=["'])/g, '#ffffff') + '</span>'
    + '<span class="wordmark">CVsprings</span></div>'
    + '<h1>Internal metrics</h1>'
    + `<div class="meta">All figures UTC · generated ${esc(data.generatedAt)}</div>`
    + '</div>'

    + '<div class="body">'

    + '<div class="cards">'
    + card('Accounts', data.totalAccounts, `${data.totalUsers} user${data.totalUsers === 1 ? '' : 's'} across them`)
    + card('MRR', money(plans.mrrEur), mrrSubline(plans, data.churning))
    + card('Active subs', statuses.active, plans.compedPaidPlans ? `+${plans.compedPaidPlans} comped` : 'paying via Stripe')
    + card('Activation', pct(activation.activationRate), `${activation.activated} of ${activation.total} have screened`)
    + '</div>'

    + '<div class="cards">'
    + card('Signups · 7d', data.signups[7], '')
    + card('Signups · 30d', data.signups[30], '')
    + card('Signups · 90d', data.signups[90], '')
    + card('Dormant · 30d', data.dormant.length, 'no login or screening')
    + '</div>'

    + '<div class="section"><h2>Plan breakdown</h2>'
    + '<table><thead><tr><th>Plan</th><th class="num">Accounts</th><th class="num">Price</th><th class="num">MRR</th></tr></thead><tbody>'
    + planRows.map((r) =>
      `<tr><td>${esc(r.label)}</td><td class="num">${r.count}</td>`
      + `<td class="num">${r.price ? money(r.price) : '—'}</td>`
      + `<td class="num">${money(r.mrr)}</td></tr>`).join('')
    + `<tr><td><strong>Total</strong></td><td class="num"><strong>${data.totalAccounts}</strong></td>`
    + `<td class="num"></td><td class="num"><strong>${money(plans.mrrEur)}</strong></td></tr>`
    + '</tbody></table>'
    + '<p class="footnote">MRR counts only accounts on a paid plan with a Stripe status of '
    + '<code>active</code> and no comped flag. Trialing accounts have not paid yet; past_due invoices '
    + `have not cleared (${money(plans.atRiskMrrEur)} at risk); comped accounts pay nothing by design. `
    + 'Prices are ex-VAT, matching src/config/plans.js.</p></div>'

    + '<div class="section"><h2>Subscription status</h2>'
    + '<table><thead><tr><th>Status</th><th class="num">Accounts</th></tr></thead><tbody>'
    + metrics.REPORTED_STATUSES.map(statusRow).join('')
    + '</tbody></table>'
    + `<p class="footnote">${data.canceledButInPeriod} canceled subscription`
    + `${data.canceledButInPeriod === 1 ? ' is' : 's are'} still inside a paid period and remain entitled `
    + 'until current_period_end. '
    + `<code>churned</code> combines <code>canceled</code> (${statuses.raw.canceled || 0}, voluntary) `
    + `and <code>unpaid</code> (${statuses.raw.unpaid || 0}, dunning exhausted — recoverable by `
    + 'card-update outreach). <code>none</code> is never subscribed, which includes '
    + `<code>incomplete_expired</code> (${statuses.raw.incomplete_expired || 0}): a first payment that `
    + 'never cleared means the account was never a customer, so it is not churn. '
    + 'NOTE: rows written before this distinction existed rest at NULL and are counted as '
    + '<code>none</code> — the table mixes pre- and post-fix data until they are backfilled.</p></div>'

    + '<div class="section"><h2>Signups per day — last 90 days</h2>'
    + renderChart(data.series) + '</div>'

    + '<div class="section"><h2>Recent signups</h2>'
    + '<table><thead><tr><th>Owner email</th><th>Signed up</th><th>Plan</th><th class="num">Screenings</th></tr></thead><tbody>'
    + (data.recentSignups.length
      ? data.recentSignups.map((r) =>
        `<tr><td class="mono">${esc(r.ownerEmail || '(no owner user)')}</td>`
        + `<td>${esc(shortDate(r.createdAt))}</td>`
        + `<td>${esc(r.plan || 'unset')}${r.comped ? ' <span class="tag">comped</span>' : ''}`
        + `${r.subscriptionStatus ? ` <span class="muted">${esc(r.subscriptionStatus)}</span>` : ''}</td>`
        + `<td class="num">${r.screeningCount}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">No accounts yet.</td></tr>')
    + '</tbody></table></div>'

    + renderChurning(data.churning)

    + '<div class="section"><h2>Stripe drift (passive)</h2>'
    + renderDriftBanner(data.drift, data.generatedAt) + '</div>'

    + renderReconcile(reconcile)

    + '</div></div>'

    // Delegated listener, matching the pattern the static pages use
    // (public/compliance.html). One click handler on document, a data-action
    // lookup, no inline handler anywhere — script-src-attr is 'none'.
    //
    // Reconciliation needs a NEW download token because the one that opened
    // this page was consumed rendering it, so the button mints one over the
    // existing POST /api/auth/download-token. It cannot use the current URL's
    // ?dt= — that token is already dead.
    + `<script nonce="${esc(nonce)}">`
    + '(function(){'
    + 'var actions={runReconcile:function(btn){'
    + 'btn.disabled=true;btn.textContent="Contacting Stripe…";'
    // The SPA's session token, under the key public/app.html writes it to
    // (SESSION_KEY = 'cvsprings_session_token'). Same origin, so it is
    // readable here. If it is absent the button still works: navigating with
    // ?reconcile=1 alone re-runs the guard, which will 404 without a
    // credential rather than render anything.
    + 'var t="";try{t=window.localStorage.getItem("cvsprings_session_token")||"";}catch(_){}'
    + 'if(!t){window.location.search="?reconcile=1";return;}'
    + 'fetch("/api/auth/download-token",{method:"POST",headers:{Authorization:"Bearer "+t}})'
    + '.then(function(r){return r.json();})'
    + '.then(function(d){window.location.search="?reconcile=1&dt="+encodeURIComponent(d.token);})'
    + '.catch(function(){window.location.search="?reconcile=1";});'
    + '}};'
    + 'document.addEventListener("click",function(e){'
    + 'var el=e.target.closest("[data-action]");if(!el)return;'
    + 'var fn=actions[el.getAttribute("data-action")];if(fn)fn(el);'
    + '});'
    + '}());'
    + '</script>'
    + '</body></html>';
}

// --- route ------------------------------------------------------------------

router.get('/metrics', isOwner, async (req, res, next) => {
  try {
    // Read once, here. Everything downstream takes the boolean, so no handler
    // below re-reads req.query and no other query parameter can reach the page.
    const reconcileRequested = req.query && req.query.reconcile === '1';

    writeAccessLog(req, reconcileRequested);

    const data = metrics.collectMetrics();
    const reconcile = reconcileRequested ? await stripeReconcile.reconcile() : null;

    res.set('Content-Type', 'text/html; charset=utf-8');
    // no-store on all three counts: the page carries cross-tenant figures, the
    // nonce in the inline <script> must match the CSP header of THIS response,
    // and a cached copy would show yesterday's MRR as today's.
    res.set('Cache-Control', 'no-store, private');
    res.set('Referrer-Policy', 'no-referrer');
    res.send(renderPage(data, reconcile, res.locals.cspNonce || ''));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.isOwner = isOwner;
module.exports.ownerEmail = ownerEmail;
module.exports.renderChart = renderChart;
module.exports.renderDriftBanner = renderDriftBanner;
module.exports.renderChurning = renderChurning;

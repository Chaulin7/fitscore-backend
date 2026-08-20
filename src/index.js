'use strict';

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { requireSession, requireSessionOrDownloadToken } = require('./middleware/auth');
const analyzeRouter = require('./routes/analyze');
const auditRouter = require('./routes/audit');
const statsRouter = require('./routes/stats');
const templatesRouter = require('./routes/templates');
const authRouter = require('./routes/auth');
const orgRouter = require('./routes/org');
const billingRouter = require('./routes/billing');
const teamRouter = require('./routes/team');
const demoRouter = require('./routes/demo');
const featureRequestsRouter = require('./routes/featureRequests');
const plansRouter = require('./routes/plans');
const { productJsonLd } = require('./config/plans');
const { configuredBaseUrl, warnDeprecatedAliases } = require('./config/appUrl');
const { migrateLegacyData } = require('./services/authService');
const { getDb, startRetentionSchedule, startWalCheckpointing, registerGracefulShutdown } = require('./services/db');
const { startProvenanceSweep } = require('./services/provenanceCache');
const { mutationLimiter } = require('./middleware/rateLimits');

// Optional pino logger (graceful fallback if not installed yet)
let pinoHttp = null;
let pino = null;
try {
  pino = require('pino');
  pinoHttp = require('pino-http');
} catch (_) { /* logging falls back to console */ }

const logger = pino
  ? pino({ level: process.env.LOG_LEVEL || 'info', redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', '*.cv', '*.jobDescription'], censor: '[REDACTED]' } })
  : null;

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render runs behind a proxy

// --- Per-request CSP nonce ---------------------------------------------------
// Generated BEFORE helmet so the CSP header and the <script nonce> attributes
// substituted into the served HTML carry the same value. Must be per-request:
// a nonce computed once at startup would be guessable and the CSP theater.
const crypto = require('crypto');
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

// --- Security headers ------------------------------------------------------
// CSP lists exactly the origins the app loads. Inline <script> blocks are
// allowed via a per-request nonce (no 'unsafe-inline' for scripts); styles
// still need 'unsafe-inline' (inline styles are a separate cleanup). We lock
// everything else down (object-src none, frame-ancestors none) and allow only
// the fonts/analytics/Stripe origins actually used. HSTS is enabled only once
// served over HTTPS (Render/custom domain).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // No 'unsafe-inline': each inline <script> carries a per-request nonce
      // substituted into the HTML by the template routes below. External
      // scripts load via src= from the allowlisted hosts (Plausible; Stripe.js
      // kept defensively — checkout currently uses a full-page redirect).
      scriptSrc: [
        "'self'",
        (req, res) => `'nonce-${res.locals.cspNonce}'`,
        'https://plausible.io',
        'https://js.stripe.com',
      ],
      // Inline event-handler attributes were removed from the frontend (handlers
      // are wired via data-action + delegated listeners), so attribute handlers
      // are blocked by design.
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      // XHR/fetch targets: same-origin, the API host, and Plausible.
      connectSrc: ["'self'", 'https://plausible.io', 'https://cvsprings7.onrender.com'],
      frameSrc: ['https://js.stripe.com', 'https://hooks.stripe.com'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // helmet sets X-Content-Type-Options: nosniff by default. HSTS is sent only
  // on HTTPS responses, so it's a no-op on plain-HTTP local dev.
  hsts: { maxAge: 15552000, includeSubDomains: true },
}));

if (pinoHttp && logger) {
  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/health' },
    // Privacy: never log query strings — audit search params can contain
    // candidate names (e.g. /api/audit?search=...). Bodies are never logged.
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: String(req.url || '').split('?')[0] };
      },
    },
  }));
}

// --- CORS lockdown ---------------------------------------------------------
// Allowlist from env (CORS_ALLOWED_ORIGINS, comma-separated). This list is the
// only thing that changes when the custom domain lands (task #5) — no code
// change. ALLOWED_ORIGINS is accepted as a legacy alias.
const corsAllowlist = (process.env.CORS_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const isProd = process.env.NODE_ENV === 'production';

function isAllowedOrigin(origin) {
  // Non-browser / same-origin requests (no Origin header) are allowed; the
  // Stripe webhook and curl fall here and are unaffected by CORS.
  if (!origin) return true;
  if (corsAllowlist.includes('*')) return !isProd; // wildcard only outside production
  if (corsAllowlist.includes(origin)) return true;
  // Convenience for local dev only (never in production).
  if (!isProd && /^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

app.use(cors({
  origin: (origin, cb) => isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('CORS: origin not allowed')),
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 600,
}));

// Stripe webhook MUST receive the raw body for signature verification, so it
// is mounted before the JSON parser and is exempt from session auth (Stripe
// sends no session token). Verification uses STRIPE_WEBHOOK_SECRET.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingRouter.handleWebhook);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// --- Rate limiting ---------------------------------------------------------
const analyzeLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many analyze requests. Please slow down.', code: 'RATE_LIMITED' } });
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.', code: 'RATE_LIMITED' } });

// Static frontend
const path = require('path');
const fs = require('fs');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// EU AI Act checklist: public marketing asset at a clean URL, opened inline
// in the browser tab. Cached for a day — the URL carries no content hash, so
// a longer max-age would pin stale copies after the file is revised. The file
// ships in assets/; if absent (dev), this 404s and routes/demo.js logs a
// warning at boot.
const CHECKLIST_PDF_PATH = path.join(__dirname, '..', 'assets', 'CVsprings-EU-AI-Act-checklist.pdf');
app.get('/eu-ai-act-checklist.pdf', (req, res) => {
  res.sendFile(CHECKLIST_PDF_PATH, {
    maxAge: '1d',
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="CVsprings-EU-AI-Act-checklist.pdf"',
    },
  }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });
});

// HTML entry points are templates: their inline <script> tags carry a
// __CSP_NONCE__ placeholder that must be replaced with the per-request nonce
// so the tag matches the CSP header of the same response. Read once at
// startup (they're static templates — no per-request disk I/O) and served
// with Cache-Control: no-store, because a cached page would hold a stale
// nonce that no longer matches the fresh CSP header. These routes are
// registered BEFORE express.static, and static gets index:false, so the raw
// placeholder files are never reachable (neither via / nor /index.html).
const HTML_PAGES = ['index.html', 'app.html', 'compliance.html', 'integrations.html', 'terms.html', 'privacy.html', 'bias-report.html'];
// Pricing structured data is substituted ONCE at startup, not per request: the
// tier table is static per deploy (same reasoning as the cached PAYLOAD in
// routes/plans.js). It is built from src/config/plans.js, so the prices a
// crawler reads are the prices the cards render — the cards themselves are
// client-rendered from /api/plans and are therefore invisible without JS.
// `<` is escaped so no string inside the JSON can close the script element.
// Offer URLs need an absolute origin and there is no request to derive one
// from, so an unconfigured deployment publishes offers without `url` (see
// warnDeprecatedAliases below, which says so at boot).
const pricingJsonLd = JSON.stringify(productJsonLd(configuredBaseUrl()))
  .replaceAll('<', '\\u003c');
const htmlTemplates = {};
for (const page of HTML_PAGES) {
  htmlTemplates[page] = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8')
    .replaceAll('__PRICING_JSONLD__', pricingJsonLd);
}
function serveNoncedHtml(page) {
  return (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(htmlTemplates[page].replaceAll('__CSP_NONCE__', res.locals.cspNonce));
  };
}
// Routing: "/" is the marketing landing page (index.html); the product app
// serves app.html at three paths, because the SPA decides its own mode from the
// session and the URL is only a statement of intent:
//   /login, /signup  — arriving to authenticate (bootAuth opens the matching
//                      form; an existing valid session skips straight past it)
//   /dashboard       — arriving at the product itself
//
// /dashboard exists so code that means "send this signed-in user to the app"
// can say so. It used to have to send them to /login and rely on bootAuth
// silently swapping the auth screen for the dashboard — correct behaviour
// reached by a misleading URL, and one that flashes a login route at a user who
// is already logged in.
app.get('/', serveNoncedHtml('index.html'));
app.get('/login', serveNoncedHtml('app.html'));
app.get('/signup', serveNoncedHtml('app.html'));
app.get('/dashboard', serveNoncedHtml('app.html'));
for (const page of HTML_PAGES) {
  app.get('/' + page, serveNoncedHtml(page));
}
app.use(express.static(PUBLIC_DIR, { index: false }));

// --- Routes ---------------------------------------------------------------
// Session auth (Authorization: Bearer {sessionToken}) protects every /api/*
// route except /health and the public /api/auth endpoints (signup, login,
// request-reset, reset-password — the auth router guards its private ones).
// The middleware sets req.userId + req.orgId; all data access is org-scoped.
// /api/audit uses requireSessionOrDownloadToken so the browser-opened HTML
// report and CSV export can authenticate via a single-use ?dt= token.
app.use('/api/auth', generalLimiter, authRouter);
// org routes do their own per-route auth (export uses a download token), so the
// mutation limiter sits at the mount and keys by IP until orgId is set.
app.use('/api/org', generalLimiter, mutationLimiter, orgRouter);
app.use('/api/billing', generalLimiter, billingRouter);
// Team routes do their own per-route auth (accept is public, like signup).
app.use('/api/team', generalLimiter, teamRouter);
// Demo requests from the landing page: public (no session), with its own
// stricter per-IP limiter inside the router (5/hour).
app.use('/api/demo-request', generalLimiter, demoRouter);
// Tier table for the pricing page and in-product Settings. Public and
// cacheable — it is the same copy a logged-out visitor sees on /.
app.use('/api/plans', generalLimiter, plansRouter);

// Public, non-personal metadata for static pages (contact + company details
// from env so the operator sets real values without code edits).
app.get('/api/meta', generalLimiter, (req, res) => {
  res.json({
    privacyContact: process.env.PRIVACY_CONTACT_EMAIL || null,
    supportEmail: process.env.SUPPORT_EMAIL || null,
    company: {
      legalName: process.env.COMPANY_LEGAL_NAME || null,
      address: process.env.COMPANY_ADDRESS || null,
      country: process.env.COMPANY_COUNTRY || null,
    },
  });
});
app.use('/api/analyze', analyzeLimiter, requireSession, analyzeRouter);
app.use('/api/audit', generalLimiter, requireSessionOrDownloadToken, mutationLimiter, auditRouter);
app.use('/api/stats', generalLimiter, requireSession, statsRouter);
app.use('/api/templates', generalLimiter, requireSession, mutationLimiter, templatesRouter);
// requireSession BEFORE mutationLimiter is load-bearing: mutationLimiter keys on
// req.orgId, which requireSession sets. Reversed, every org silently falls back
// to IP-keying. These two are burst guards; the 5-per-rolling-24h business quota
// is enforced in SQL inside the route.
app.use('/api/feature-requests', generalLimiter, requireSession, mutationLimiter, featureRequestsRouter);

// --- /health (DB ping) ----------------------------------------------------
app.get('/health', async (req, res) => {
  const out = { status: 'ok', uptime: Math.round(process.uptime()), version: require('../package.json').version, timestamp: new Date().toISOString() };
  try {
    const { getAllAudits } = require('./services/db');
    getAllAudits({ limit: 1 });
    out.db = 'ok';
  } catch (err) {
    out.status = 'degraded';
    out.db = 'error'; // detail is logged server-side, not exposed
    if (logger) logger.error({ err: err.message }, 'health DB check failed');
    return res.status(503).json(out);
  }
  res.json(out);
});

// 404 fallthrough
app.use((req, res) => { res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', path: req.path }); });

// Final error handler. Full detail is logged server-side; the client gets a
// generic message on 5xx (no stack traces, internal paths, or messages leak).
app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  if (logger) { logger.error({ path: req.path, err: err.message, stack: err.stack }, 'unhandled error'); }
  else { console.error('[error]', status, req.path, err.message, err.stack); }
  // CORS rejections surface as errors here — return a clean 403.
  if (err && /^CORS:/.test(err.message || '')) {
    return res.status(403).json({ error: 'Origin not allowed.', code: 'CORS_DENIED' });
  }
  const clientMessage = status >= 500 ? 'Something went wrong. Please try again.' : (err.message || 'Request failed');
  const body = { error: clientMessage, code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST') };
  if (err.field && status < 500) body.field = err.field;
  res.status(status).json(body);
});

// Open the database and ensure the FULL schema exists before the server
// accepts traffic — on a fresh persistent disk (first boot after mounting)
// no tables exist yet, and any request racing schema creation would 500.
// better-sqlite3 is synchronous, so this completes before app.listen below.
// (Also logs the resolved DB path for boot verification in Render logs.)
getDb();

// One-time legacy data migration: assigns pre-auth records to the
// "Chaulin (legacy)" organization and creates the owner user from
// OWNER_EMAIL + OWNER_PASSWORD. Idempotent on every boot.
migrateLegacyData(logger ? logger.info.bind(logger) : console.log)
  .catch((err) => {
    if (logger) logger.error({ err: err.message }, 'legacy data migration failed');
    else console.error('[error] legacy data migration failed:', err.message);
  });

// --- Retention purge (EU AI Act Art. 19 floor + GDPR storage limitation) ----
// The batched daily job lives in services/db.js: per-org and floor-enforced, it
// writes one purge_runs record per org per run and an append-only purge audit
// event, then WAL-checkpoints. The schedule self-gates to ~daily and survives
// frequent restarts; its timer is .unref()'d and cleared by the graceful
// shutdown path (closeDb).
startRetentionSchedule();

// Keep the WAL from growing without bound while the process is up (folds it
// back into the main DB every 5 minutes; the timer is .unref()'d).
startWalCheckpointing();

// Expire analysis-provenance bindings past their 24h TTL. Separate from the
// retention schedule on purpose: this evicts the server's own short-lived
// records, so it must not inherit RETENTION_PURGE_MODE, which exists to keep
// candidate data from being deleted by accident. Timer is .unref()'d.
startProvenanceSweep();

// Say once, at boot, which variable supplied the public origin — or that none
// did. A wrong origin does not throw: it produces working-looking links that
// point at the proxy host, and offer URLs that quietly vanish from the pricing
// structured data. That is only findable if the process says so out loud.
warnDeprecatedAliases(logger
  ? { warn: (m) => logger.warn(m) }
  : console);

const server = app.listen(PORT, () => {
  const log = logger ? logger.info.bind(logger) : console.log;
  log('CVsprings API listening on http://localhost:' + PORT);
  log(' Public origin: ' + (configuredBaseUrl() || '(unset — links will use the request host)'));
  log(' POST /api/auth/signup        - Create an organization + owner account');
  log(' POST /api/auth/login         - Email + password login (returns session token)');
  log(' POST /api/auth/logout        - Invalidate the current session');
  log(' GET  /api/auth/me            - Current user + organization');
  log(' POST /api/auth/change-password - Change password (invalidates other sessions)');
  log(' POST /api/auth/request-reset - Request a password reset link');
  log(' POST /api/auth/reset-password - Set a new password via reset token');
  log(' POST /api/auth/download-token - Single-use token for report/CSV downloads');
  log(' POST /api/analyze            - Score a CV against a job description');
  log(' POST /api/analyze/batch      - Batch analyze up to 200 CVs');
  log(' POST /api/audit              - Save an audit record (auth required)');
  log(' GET  /api/audit              - List audit records (auth required)');
  log(' PATCH /api/audit/:id         - Update {decision,note,role,candidateName} (auth required)');
  log(' DELETE /api/audit/:id        - Remove a record (auth required)');
  log(' GET  /api/audit/:id/changes  - Append-only change log (auth required)');
  log(' GET  /api/audit/roles        - Distinct roles with counts (auth required)');
  log(' GET  /api/audit/bias-report  - Bias monitoring report JSON (auth required)');
  log(' GET  /api/audit/bias-report/pdf - Bias monitoring report HTML/print (auth required)');
  log(' GET  /api/audit/export/csv   - CSV export (auth required)');
  log(' GET  /api/audit/report/:id   - HTML candidate report (auth required)');
  log(' GET  /api/stats/overview     - Dashboard summary metrics (auth required)');
  log(' GET  /api/templates          - Templates CRUD (auth required)');
  log(' POST /api/feature-requests   - Submit a feature request (Pro/Team, auth required)');
  log(' GET  /health                 - Health check');
});

// Close the HTTP server and the DB cleanly on deploy/shutdown so better-sqlite3
// checkpoints the WAL back into fitscore.db instead of leaving the dataset
// stranded in the -wal sidecar.
registerGracefulShutdown(server);

module.exports = app;

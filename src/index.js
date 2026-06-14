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
const { migrateLegacyData } = require('./services/authService');
const { purgeExpiredAudits } = require('./services/db');
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

// --- Security headers ------------------------------------------------------
// CSP lists exactly the origins the app loads. The single HTML file relies on
// inline scripts/styles, so 'unsafe-inline' is required for script/style; we
// still lock everything else down (object-src none, frame-ancestors none) and
// allow only the fonts/analytics/Stripe origins actually used. HSTS is enabled
// only once served over HTTPS (Render/custom domain).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // Inline handlers/scripts in the single-file app require 'unsafe-inline'.
      // Stripe.js is loaded only if Checkout redirects in-page; allow its host.
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://plausible.io', 'https://js.stripe.com'],
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
app.use(express.static(path.join(__dirname, '..', 'public')));

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

// One-time legacy data migration: assigns pre-auth records to the
// "Chaulin (legacy)" organization and creates the owner user from
// OWNER_EMAIL + OWNER_PASSWORD. Idempotent on every boot.
migrateLegacyData(logger ? logger.info.bind(logger) : console.log)
  .catch((err) => {
    if (logger) logger.error({ err: err.message }, 'legacy data migration failed');
    else console.error('[error] legacy data migration failed:', err.message);
  });

// --- Retention purge (GDPR storage limitation) ------------------------------
// Daily job: hard-deletes audit records (and change history) older than each
// org's retention setting. Logs counts only — never record contents.
function runRetentionPurge() {
  const log = logger ? logger.info.bind(logger) : console.log;
  try {
    const { recordsDeleted, changesDeleted, orgsChecked } = purgeExpiredAudits();
    if (recordsDeleted || changesDeleted) {
      log(`[retention] Purged ${recordsDeleted} audit record(s) and ${changesDeleted} change row(s) across ${orgsChecked} org(s)`);
    }
  } catch (err) {
    if (logger) logger.error({ err: err.message }, 'retention purge failed');
    else console.error('[error] retention purge failed:', err.message);
  }
}
runRetentionPurge();
setInterval(runRetentionPurge, 24 * 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  const log = logger ? logger.info.bind(logger) : console.log;
  log('CVsprings API listening on http://localhost:' + PORT);
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
  log(' GET  /health                 - Health check');
});

module.exports = app;

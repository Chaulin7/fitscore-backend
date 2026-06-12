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
const { migrateLegacyData } = require('./services/authService');

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

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

if (pinoHttp && logger) {
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
}

// --- CORS lockdown ---------------------------------------------------------
const allowedOriginsRaw = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const allowedOrigins = allowedOriginsRaw;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes('*')) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin) && allowedOrigins.some((o) => o.startsWith('http://localhost'))) return true;
  return false;
}

app.use(cors({
  origin: (origin, cb) => isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('CORS: origin not allowed')),
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
  credentials: true,
}));

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
app.use('/api/analyze', analyzeLimiter, requireSession, analyzeRouter);
app.use('/api/audit', generalLimiter, requireSessionOrDownloadToken, auditRouter);
app.use('/api/stats', generalLimiter, requireSession, statsRouter);
app.use('/api/templates', generalLimiter, requireSession, templatesRouter);

// --- /health (DB ping) ----------------------------------------------------
app.get('/health', async (req, res) => {
  const out = { status: 'ok', uptime: Math.round(process.uptime()), version: require('../package.json').version, timestamp: new Date().toISOString() };
  try {
    const { getAllAudits } = require('./services/db');
    getAllAudits({ limit: 1 });
    out.db = 'ok';
  } catch (err) {
    out.status = 'degraded';
    out.dbError = err.message;
    return res.status(503).json(out);
  }
  res.json(out);
});

// 404 fallthrough
app.use((req, res) => { res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', path: req.path }); });

// Final error handler
app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  if (logger) { logger.error({ path: req.path }, 'unhandled error'); }
  else { console.error('[error]', status, req.path, err.message); }
  const body = { error: err.message || 'Internal server error', code: err.code || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST') };
  if (err.field) body.field = err.field;
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

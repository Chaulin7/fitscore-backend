'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const analyzeRouter   = require('./routes/analyze');
const auditRouter     = require('./routes/audit');
const statsRouter     = require('./routes/stats');
const templatesRouter = require('./routes/templates');

// Optional pino logger (graceful fallback if not installed yet)
let pinoHttp = null;
let pino = null;
try {
  pino = require('pino');
  pinoHttp = require('pino-http');
} catch (_) { /* logging falls back to console */ }

const logger = pino
  ? pino({
      level: process.env.LOG_LEVEL || 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', '*.cv', '*.jobDescription'],
        censor: '[REDACTED]'
      }
    })
  : null;

const app  = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render runs behind a proxy; needed for accurate req.ip

app.use(helmet({
  contentSecurityPolicy: false, // SPA index.html sets its own meta CSP
  crossOriginEmbedderPolicy: false
}));

if (pinoHttp && logger) {
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
}

// --- CORS lockdown ---------------------------------------------------------
// Defaults to a permissive '*' only when ALLOWED_ORIGINS is unset (dev).
const allowedOriginsRaw = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim()).filter(Boolean);
const allowedOrigins = allowedOriginsRaw;

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser clients
  if (allowedOrigins.includes('*')) return true;
  if (allowedOrigins.includes(origin)) return true;
  // Allow http://localhost:* in dev
  if (/^http:\/\/localhost(:\d+)?$/.test(origin) && allowedOrigins.some(o => o.startsWith('http://localhost'))) return true;
  return false;
}

app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) cb(null, true);
    else cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// --- Rate limiting ---------------------------------------------------------
const analyzeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analyze requests. Please slow down.', code: 'RATE_LIMITED' }
});

const generalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.', code: 'RATE_LIMITED' }
});

// Static frontend (existing public/index.html and any landing.html added later)
app.use(express.static(require('path').join(__dirname, '..', 'public')));

// --- Routes ---------------------------------------------------------------
app.use('/api/analyze',  analyzeLimiter, analyzeRouter);
app.use('/api/audit',    generalLimiter, auditRouter);
app.use('/api/stats',    generalLimiter, statsRouter);
app.use('/api/templates', generalLimiter, templatesRouter);

// --- /health (DB ping) ----------------------------------------------------
app.get('/health', (req, res) => {
  const out = {
    status: 'ok',
    uptime: Math.round(process.uptime()),
    version: require('../package.json').version,
    timestamp: new Date().toISOString(),
    db: 'unknown'
  };
  try {
    const { getAllAudits } = require('./services/db');
    // Cheap sanity check — pulls 0 rows (limit=1 not supported in legacy signature; this is a quick prepared statement)
    getAllAudits({ limit: 1 });
    out.db = 'ok';
    res.json(out);
  } catch (err) {
    out.status = 'degraded';
    out.db = 'error';
    out.dbError = err.message;
    res.status(503).json(out);
  }
});

// 404 fallthrough
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', path: req.path });
});

// Final error handler — never leaks stack traces
app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  if (logger) logger.error({ err, status, path: req.path }, 'unhandled error');
  else console.error('[error]', status, req.path, err.message);
  const body = {
    error: err.message || 'Internal server error',
    code: err.code || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST')
  };
  if (err.field) body.field = err.field;
  res.status(status).json(body);
});

app.listen(PORT, () => {
  const log = logger ? (m) => logger.info(m) : console.log;
  log('CVsprings API listening on http://localhost:' + PORT);
  log('  POST   /api/analyze              - Score a CV against a job description');
  log('  POST   /api/analyze/batch        - Batch analyze up to 200 CVs');
  log('  POST   /api/audit                - Save an audit record');
  log('  GET    /api/audit                - List audit records (?role&decision&search&from&to&limit&offset)');
  log('  PATCH  /api/audit/:id            - Update {decision,note,role,candidateName}');
  log('  DELETE /api/audit/:id            - Remove a record');
  log('  GET    /api/audit/:id/changes    - Append-only change log for a record');
  log('  GET    /api/audit/roles          - Distinct roles with counts');
  log('  GET    /api/audit/roles/:role/history');
  log('  GET    /api/audit/export/csv     - CSV export');
  log('  GET    /api/audit/report/:id     - HTML candidate report');
  log('  GET    /api/stats/overview       - Dashboard summary metrics');
  log('  GET    /api/templates            - List templates');
  log('  POST   /api/templates            - Create template');
  log('  GET    /api/templates/:id        - Read template');
  log('  PATCH  /api/templates/:id        - Update template');
  log('  DELETE /api/templates/:id        - Delete template');
  log('  GET    /health                   - Health check (includes db status)');
});

module.exports = app;

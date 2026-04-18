'use strict';

require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');

const analyzeRouter = require('./routes/analyze');
const auditRouter   = require('./routes/audit');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/api/analyze', analyzeRouter);
app.use('/api/audit',   auditRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log('FitScore API running on http://localhost:' + PORT);
  console.log('  POST /api/analyze       - Score a CV against a job description');
  console.log('  POST /api/audit         - Save an audit record');
  console.log('  GET  /api/audit         - List audit records');
  console.log('  GET  /api/audit/export/csv - Download CSV export');
  console.log('  DELETE /api/audit/:id   - Remove an audit record');
  console.log('  GET  /health            - Health check');
});

module.exports = app;

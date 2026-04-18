# FitScore Backend

REST API backend for the **CV Job Fit Analyzer** tool. Accepts CV uploads (PDF/DOCX) and a job description, returns structured fit scores using a keyword-matching and skills-based scoring engine.

## Features

- PDF and DOCX text extraction (`pdf-parse` + `mammoth`)
- Keyword extraction from job descriptions (top 40 with bigram support)
- 200+ skill matching across 10 categories
- Experience and education level scoring
- Configurable score weights (keywords, skills, experience, education)
- SQLite audit log with CSV export (`better-sqlite3`)
- Security headers via `helmet`, CORS configuration, dotenv

## Prerequisites

- Node.js 18 or newer
- npm 8+

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/Chaulin7/fitscore-backend.git
cd fitscore-backend

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env if needed (default port: 3000)

# 4. Start the server
npm start
```

The API will be available at `http://localhost:3000`.

## API Endpoints

### POST /api/analyze

Analyze a CV against a job description.

**Request** — `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cv` | File | Yes | PDF or DOCX CV file |
| `jobDescription` | string | Yes | Full job description text |
| `weights` | JSON string | No | Score weights (must sum to 100) |

Default weights: `{"kw":40,"sk":30,"ex":20,"ed":10}`

**Example:**

```bash
curl -X POST http://localhost:3000/api/analyze \
  -F "cv=@/path/to/resume.pdf" \
  -F "jobDescription=We are looking for a senior Python developer with 5+ years experience in machine learning and AWS." \
  -F 'weights={"kw":40,"sk":30,"ex":20,"ed":10}'
```

**Response:**

```json
{
  "candidateName": "resume",
  "overall": 74,
  "scores": { "keywords": 82, "skills": 70, "experience": 65, "education": 80 },
  "verdict": "Good Match",
  "found": ["python", "machine learning", "aws"],
  "missing": ["kubernetes", "terraform"],
  "skills": [{ "name": "python", "found": true, "category": "Programming" }],
  "recommendations": [{ "icon": "✅", "text": "Good overall fit..." }]
}
```

### POST /api/audit

Save an audit record.

```bash
curl -X POST http://localhost:3000/api/audit \
  -H 'Content-Type: application/json' \
  -d '{"candidateName":"Jane Doe","fileName":"jane_doe.pdf","overall":74,"verdict":"Good Match","decision":"Advance","note":"Strong Python background"}'
```

### GET /api/audit

List all audit records. Optional query params: `?decision=Advance&limit=50`

```bash
curl http://localhost:3000/api/audit
curl 'http://localhost:3000/api/audit?decision=Advance&limit=10'
```

### DELETE /api/audit/:id

Delete a record by UUID.

```bash
curl -X DELETE http://localhost:3000/api/audit/550e8400-e29b-41d4-a716-446655440000
```

### GET /api/audit/export/csv

Download all audit records as a CSV file.

```bash
curl http://localhost:3000/api/audit/export/csv -o audit-log.csv
```

### GET /health

Health check endpoint.

```bash
curl http://localhost:3000/health
```

## Connecting to the HTML Frontend

If you have the existing HTML frontend tool, update the fetch URL to point to this backend:

```javascript
// In your frontend HTML/JS, change the fetch URL from:
const response = await fetch('/api/analyze', { ... });

// To:
const response = await fetch('http://localhost:3000/api/analyze', { ... });
// Or in production:
const response = await fetch('https://your-deployed-url.com/api/analyze', { ... });
```

Make sure `ALLOWED_ORIGINS` in your `.env` includes your frontend's origin:

```
ALLOWED_ORIGINS=http://localhost:8080,https://yourfrontend.com
```

## Deployment

### Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/fitscore-backend)

1. Click the button above or go to [railway.app](https://railway.app)
2. Connect your GitHub repo
3. Set environment variables: `PORT`, `ALLOWED_ORIGINS`
4. Deploy — Railway auto-detects Node.js

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Go to [render.com](https://render.com) and create a new **Web Service**
2. Connect your GitHub repo
3. Set **Build Command**: `npm install`
4. Set **Start Command**: `npm start`
5. Add environment variables: `PORT=3000`, `ALLOWED_ORIGINS=*`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `ALLOWED_ORIGINS` | `*` | Comma-separated allowed CORS origins |

## Project Structure

```
fitscore-backend/
├── src/
│   ├── index.js          # Express app entry point
│   ├── routes/
│   │   ├── analyze.js    # POST /api/analyze
│   │   └── audit.js      # GET/POST /api/audit, DELETE /api/audit/:id
│   ├── services/
│   │   ├── parser.js     # PDF + DOCX text extraction
│   │   ├── scorer.js     # Scoring engine
│   │   └── db.js         # SQLite audit log helpers
│   └── data/
│       └── skills.js     # Skills database (200+ skills, 10 categories)
├── uploads/              # Temp upload directory (gitignored)
├── audit.db              # SQLite file (gitignored, auto-created)
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## License

MIT

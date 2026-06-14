'use strict';

/**
 * src/data/sample.js
 *
 * Canonical built-in sample used by GET /api/analyze/sample for first-run
 * onboarding. Fixed and server-defined — a user can never substitute their
 * own input into the sample path. Bump SAMPLE_VERSION whenever the CV/JD/
 * weights change so the cached result is recomputed.
 */

const SAMPLE_VERSION = '1';

const SAMPLE_ROLE = 'Backend Software Engineer';

const SAMPLE_WEIGHTS = { kw: 40, sk: 30, ex: 20, ed: 10 };

const SAMPLE_CV = `Alex Morgan
Software Engineer

Summary
Mid-level backend engineer with 5 years of experience building REST APIs and
data services. Comfortable across the stack with a focus on Node.js and
PostgreSQL. Bachelor of Science in Computer Science.

Experience
Senior Software Engineer, Northwind Labs (2021-present)
- Designed and built REST APIs in Node.js and Express serving 2M requests/day.
- Migrated a monolith to containerized services on Docker and AWS.
- Added automated testing (Jest) and CI pipelines, cutting regressions.

Software Engineer, Bright Data Co. (2019-2021)
- Built PostgreSQL-backed data services and internal tooling in JavaScript.
- Implemented authentication, caching with Redis, and API rate limiting.

Skills
JavaScript, Node.js, Express, PostgreSQL, Redis, Docker, AWS, REST, Git, Jest

Education
BSc Computer Science, State University (2019)`;

const SAMPLE_JD = `We are hiring a Backend Software Engineer to design and maintain our REST
APIs and data services. You will work primarily in Node.js and Express, with
PostgreSQL as our main datastore, and help operate our services on Docker and
AWS.

Requirements:
- 4+ years of experience in backend software engineering
- Strong JavaScript and Node.js skills
- Experience designing REST APIs
- Solid SQL / PostgreSQL knowledge
- Familiarity with Docker and cloud deployment (AWS)
- Bachelor's degree in Computer Science or equivalent experience

Nice to have: Redis, automated testing (Jest), CI/CD pipelines.`;

module.exports = { SAMPLE_VERSION, SAMPLE_ROLE, SAMPLE_WEIGHTS, SAMPLE_CV, SAMPLE_JD };

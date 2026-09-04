// Entirely synthetic: fabricated names and @example.com addresses. No real
// candidate, client, or company data appears anywhere in this project.
export type CandidateScores = {
  keywords: number;
  skills: number;
  experience: number;
  education: number;
};

export type Candidate = {
  id: string;
  name: string;
  email: string;
  fileName: string;
  overall: number;
  scores: CandidateScores;
  found: string[];
  missing: string[];
  skills: {name: string; found: boolean}[];
};

export const ROLE = 'Senior Backend Engineer';

export const CANDIDATES: Candidate[] = [
  {
    id: 'c1',
    name: 'Priya Nakamura',
    email: 'priya.nakamura@example.com',
    fileName: 'priya_nakamura_cv.pdf',
    overall: 91,
    scores: {keywords: 88, skills: 95, experience: 92, education: 90},
    found: ['Node.js', 'PostgreSQL', 'distributed systems', 'API design', 'Kubernetes'],
    missing: ['GraphQL'],
    skills: [
      {name: 'Node.js', found: true},
      {name: 'PostgreSQL', found: true},
      {name: 'Kubernetes', found: true},
      {name: 'System design', found: true},
      {name: 'GraphQL', found: false},
      {name: 'Terraform', found: true},
    ],
  },
  {
    id: 'c2',
    name: 'Marcus Oyelaran',
    email: 'marcus.oyelaran@example.com',
    fileName: 'marcus_oyelaran_cv.pdf',
    overall: 84,
    scores: {keywords: 80, skills: 86, experience: 88, education: 82},
    found: ['Node.js', 'microservices', 'API design', 'CI/CD'],
    missing: ['Kubernetes', 'GraphQL'],
    skills: [
      {name: 'Node.js', found: true},
      {name: 'PostgreSQL', found: true},
      {name: 'Kubernetes', found: false},
      {name: 'System design', found: true},
      {name: 'GraphQL', found: false},
      {name: 'Terraform', found: false},
    ],
  },
  {
    id: 'c3',
    name: 'Elena Vasquez-Thorn',
    email: 'elena.vasquezthorn@example.com',
    fileName: 'elena_vasquezthorn_cv.pdf',
    overall: 77,
    scores: {keywords: 74, skills: 79, experience: 76, education: 80},
    found: ['PostgreSQL', 'API design', 'distributed systems'],
    missing: ['Kubernetes', 'GraphQL', 'CI/CD'],
    skills: [
      {name: 'Node.js', found: true},
      {name: 'PostgreSQL', found: true},
      {name: 'Kubernetes', found: false},
      {name: 'System design', found: true},
      {name: 'GraphQL', found: false},
      {name: 'Terraform', found: false},
    ],
  },
  {
    id: 'c4',
    name: 'Tobias Lindqvist',
    email: 'tobias.lindqvist@example.com',
    fileName: 'tobias_lindqvist_cv.pdf',
    overall: 68,
    scores: {keywords: 62, skills: 70, experience: 71, education: 68},
    found: ['Node.js', 'CI/CD'],
    missing: ['Kubernetes', 'GraphQL', 'PostgreSQL'],
    skills: [
      {name: 'Node.js', found: true},
      {name: 'PostgreSQL', found: false},
      {name: 'Kubernetes', found: false},
      {name: 'System design', found: false},
      {name: 'GraphQL', found: false},
      {name: 'Terraform', found: false},
    ],
  },
  {
    id: 'c5',
    name: 'Amara Chukwu',
    email: 'amara.chukwu@example.com',
    fileName: 'amara_chukwu_cv.pdf',
    overall: 55,
    scores: {keywords: 50, skills: 58, experience: 54, education: 60},
    found: ['API design'],
    missing: ['Node.js', 'Kubernetes', 'GraphQL', 'PostgreSQL'],
    skills: [
      {name: 'Node.js', found: false},
      {name: 'PostgreSQL', found: false},
      {name: 'Kubernetes', found: false},
      {name: 'System design', found: true},
      {name: 'GraphQL', found: false},
      {name: 'Terraform', found: false},
    ],
  },
];

export const HERO_CANDIDATE = CANDIDATES[0];

export const SAMPLE_FILE_NAMES = [
  'priya_nakamura_cv.pdf',
  'marcus_oyelaran_cv.pdf',
  'elena_vasquezthorn_cv.pdf',
  'tobias_lindqvist_cv.pdf',
  'amara_chukwu_cv.pdf',
  'devon_ashworth_cv.pdf',
  'noor_al_farsi_cv.pdf',
  'james_okonkwo_cv.docx',
  'lucia_ferreira_santos_cv.pdf',
  'kenji_takahashi_cv.pdf',
];

export const TOTAL_CV_COUNT = 40;

export type RankedCandidate = {
  id: string;
  name: string;
  overall: number;
  scores: CandidateScores;
};

// The top of the 40-CV batch. The real batch table is a scrollable list, so
// the video shows the rows that fit; the five detailed candidates above sit
// at their ranked positions.
export const RANKED: RankedCandidate[] = [
  CANDIDATES[0], // Priya, 91
  {id: 'r2', name: 'Ingrid Solberg', overall: 87, scores: {keywords: 84, skills: 90, experience: 88, education: 85}},
  CANDIDATES[1], // Marcus, 84
  {id: 'r4', name: 'Devon Ashworth', overall: 82, scores: {keywords: 80, skills: 84, experience: 83, education: 80}},
  {id: 'r5', name: 'Noor Al-Farsi', overall: 79, scores: {keywords: 76, skills: 81, experience: 80, education: 78}},
  CANDIDATES[2], // Elena, 77
  {id: 'r7', name: 'Rafael Mendoza', overall: 75, scores: {keywords: 72, skills: 77, experience: 76, education: 74}},
  {id: 'r8', name: 'Lucia Ferreira Santos', overall: 73, scores: {keywords: 70, skills: 75, experience: 74, education: 72}},
  {id: 'r9', name: 'Kenji Takahashi', overall: 71, scores: {keywords: 68, skills: 73, experience: 72, education: 70}},
  CANDIDATES[3], // Tobias, 68
  {id: 'r11', name: 'James Okonkwo', overall: 64, scores: {keywords: 60, skills: 66, experience: 67, education: 62}},
  CANDIDATES[4], // Amara, 55
];

// Mean across all 40 CVs in the batch, including the 28 below the fold.
export const BATCH_AVG_SCORE = 54;

export type AuditRecord = {
  date: string;
  name: string;
  role: string;
  overall: number;
  decision: 'Shortlist' | 'Hold' | 'Reject';
  note: string;
  reviewer: string;
};

// Newest first, like the real Audit Log default. Spans roles and weeks so it
// reads as an accumulating log rather than a replay of the batch just scored.
export const AUDIT_RECORDS: AuditRecord[] = [
  {date: '2026-08-11 09:44', name: 'Priya Nakamura', role: ROLE, overall: 91, decision: 'Shortlist', note: 'Strong systems background', reviewer: 'r.velasquez@example.com'},
  {date: '2026-08-11 09:42', name: 'Marcus Oyelaran', role: ROLE, overall: 84, decision: 'Shortlist', note: 'Good fit, schedule call', reviewer: 'r.velasquez@example.com'},
  {date: '2026-08-07 14:03', name: 'Chioma Adeyemi', role: 'Data Engineer', overall: 79, decision: 'Hold', note: 'Revisit after round 1', reviewer: 'd.okafor@example.com'},
  {date: '2026-08-05 11:20', name: 'Sana Qureshi', role: 'Product Designer', overall: 72, decision: 'Shortlist', note: '', reviewer: 'd.okafor@example.com'},
  {date: '2026-08-01 16:48', name: 'Henrik Vasiliou', role: 'Data Engineer', overall: 61, decision: 'Reject', note: 'Below threshold', reviewer: 'd.okafor@example.com'},
  {date: '2026-07-29 10:15', name: 'Mateo Lindgren', role: ROLE, overall: 58, decision: 'Reject', note: 'No Kubernetes exposure', reviewer: 'r.velasquez@example.com'},
];

// Org-wide monitoring figures for the bias panel. Every rate carries its
// sample size — the real biasAudit engine insists on that.
export const ORG_STATS = {
  records: 46,
  mean: 61,
  median: 63,
  histogram: [
    {label: '0–49', count: 11},
    {label: '50–69', count: 17},
    {label: '70–84', count: 12},
    {label: '85–100', count: 6},
  ],
  shortlistRate: [
    {label: '0–49', rate: 0, shortlisted: 0, total: 11},
    {label: '50–69', rate: 12, shortlisted: 2, total: 17},
    {label: '70–84', rate: 58, shortlisted: 7, total: 12},
    {label: '85–100', rate: 100, shortlisted: 6, total: 6},
  ],
};

'use strict';

const { SKILLS_DB } = require('../data/skills');

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'need',
  'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very',
  'just', 'that', 'this', 'these', 'those', 'we', 'our', 'you', 'your',
  'they', 'their', 'it', 'its', 'he', 'she', 'his', 'her', 'who', 'which',
  'what', 'when', 'where', 'how', 'why', 'all', 'any', 'only', 'also',
  'into', 'about', 'up', 'out', 'if', 'work', 'team', 'new', 'strong',
  'good', 'well', 'must', 'ability', 'skills', 'experience', 'knowledge',
  'excellent', 'great', 'including', 'within', 'across', 'role', 'position'
]);

const SENIORITY = {
  director: 5, vp: 5, 'vice president': 5, head: 5, principal: 5, staff: 5, architect: 5,
  lead: 4, senior: 4, sr: 4,
  mid: 3, 'mid-level': 3,
  junior: 2, jr: 2, associate: 2,
  entry: 1, intern: 1, graduate: 1
};

const EDU_RANKS = {
  phd: 4, doctorate: 4,
  master: 3, masters: 3, msc: 3, mba: 3,
  bachelor: 2, bachelors: 2, bsc: 2, beng: 2, undergraduate: 2,
  diploma: 1, associate: 1, certificate: 1
};

function scoreCV(cvText, jobDescription, weights) {
  const W = weights || { kw: 40, sk: 30, ex: 20, ed: 10 };
  const totalWeight = W.kw + W.sk + W.ex + W.ed;
  const cvLower = cvText.toLowerCase();
  const jdLower = jobDescription.toLowerCase();

  const { keywords: jdKeywords, score: kwScore, found: kwFound, missing: kwMissing } =
    scoreKeywords(cvLower, jdLower);
  const { score: skScore, skillResults } = scoreSkills(cvLower, jdLower);
  const exScore = scoreExperience(cvLower, jdLower);
  const edScore = scoreEducation(cvLower, jdLower);

  const overall = Math.round(
    (kwScore * W.kw + skScore * W.sk + exScore * W.ex + edScore * W.ed) / totalWeight
  );

  return {
    overall,
    scores: { keywords: kwScore, skills: skScore, experience: exScore, education: edScore },
    verdict: getVerdict(overall),
    found: kwFound,
    missing: kwMissing,
    skills: skillResults,
    recommendations: generateRecommendations({ kwScore, skScore, exScore, edScore, kwMissing, skillResults, overall })
  };
}

function scoreKeywords(cvLower, jdLower) {
  const keywords = extractTopKeywords(jdLower, 40);
  const found = [], missing = [];
  for (const kw of keywords) {
    const regex = new RegExp('\\b' + escapeRegex(kw) + '\\b', 'i');
    if (regex.test(cvLower)) found.push(kw);
    else missing.push(kw);
  }
  const score = keywords.length > 0 ? Math.round((found.length / keywords.length) * 100) : 0;
  return { keywords, score, found, missing };
}

function extractTopKeywords(text, limit) {
  const words = text.match(/[a-z0-9][a-z0-9+#.\/-]*/g) || [];
  const freq = {};
  for (const w of words) {
    if (w.length > 2 && !STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
  }
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (!STOP_WORDS.has(a) && !STOP_WORDS.has(b) && a.length > 2 && b.length > 2) {
      const bigram = a + ' ' + b;
      freq[bigram] = (freq[bigram] || 0) + 1;
    }
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([kw]) => kw);
}

function scoreSkills(cvLower, jdLower) {
  const jdSkills = [];
  const skillResults = [];
  for (const skill of SKILLS_DB) {
    const regex = new RegExp('\\b' + escapeRegex(skill.name) + '\\b', 'i');
    const inJD = regex.test(jdLower);
    const inCV = regex.test(cvLower);
    if (inJD) jdSkills.push({ ...skill, found: inCV });
    skillResults.push({ name: skill.name, found: inCV, category: skill.category });
  }
  const score = jdSkills.length > 0
    ? Math.round((jdSkills.filter(s => s.found).length / jdSkills.length) * 100)
    : 50;
  return { score, skillResults };
}

function scoreExperience(cvLower, jdLower) {
  const cvYears = extractYears(cvLower);
  const jdYears = extractYears(jdLower);
  const cvSenior = detectSeniority(cvLower);
  const jdSenior = detectSeniority(jdLower);
  let score = 50;
  if (jdYears > 0 && cvYears >= jdYears) score += 30;
  else if (jdYears > 0 && cvYears > 0) score += Math.round((cvYears / jdYears) * 30);
  else if (cvYears > 0) score += 20;
  if (jdSenior > 0) {
    if (cvSenior >= jdSenior) score += 20;
    else score += Math.round((cvSenior / jdSenior) * 10);
  }
  return Math.min(100, Math.max(0, score));
}

function extractYears(text) {
  const patterns = [
    /(\d+)\+?\s*years?\s+(?:of\s+)?experience/gi,
    /experience[^\d]*(\d+)\+?\s*years?/gi,
    /(\d+)\+?\s*yr[s]?\s+(?:of\s+)?experience/gi
  ];
  let maxYears = 0;
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const y = parseInt(m[1], 10);
      if (y > maxYears && y < 50) maxYears = y;
    }
  }
  return maxYears;
}

function detectSeniority(text) {
  let maxLevel = 0;
  for (const [kw, level] of Object.entries(SENIORITY)) {
    const regex = new RegExp('\\b' + escapeRegex(kw) + '\\b', 'i');
    if (regex.test(text) && level > maxLevel) maxLevel = level;
  }
  return maxLevel;
}

function scoreEducation(cvLower, jdLower) {
  const cvEdu = detectEducation(cvLower);
  const jdEdu = detectEducation(jdLower);
  if (jdEdu === 0) return 70;
  if (cvEdu >= jdEdu) return 100;
  if (cvEdu === 0) return 20;
  return Math.round((cvEdu / jdEdu) * 80);
}

function detectEducation(text) {
  let maxRank = 0;
  for (const [kw, rank] of Object.entries(EDU_RANKS)) {
    const regex = new RegExp('\\b' + escapeRegex(kw) + '\\b', 'i');
    if (regex.test(text) && rank > maxRank) maxRank = rank;
  }
  return maxRank;
}

function getVerdict(overall) {
  if (overall >= 85) return 'Excellent Match';
  if (overall >= 70) return 'Good Match';
  if (overall >= 50) return 'Partial Match';
  return 'Poor Match';
}

function generateRecommendations({ kwScore, skScore, exScore, edScore, kwMissing, skillResults, overall }) {
  const recs = [];
  if (overall >= 85) {
    recs.push({ icon: '\u{1F31F}', text: 'Excellent profile match — strongly recommend advancing to interview.' });
  } else if (overall >= 70) {
    recs.push({ icon: '\u2705', text: 'Good overall fit. Consider scheduling a technical screening.' });
  } else if (overall >= 50) {
    recs.push({ icon: '\u26A0\uFE0F', text: 'Partial match. Evaluate whether gaps are trainable or critical.' });
  } else {
    recs.push({ icon: '\u274C', text: 'Low match score. Role requirements significantly exceed candidate profile.' });
  }
  if (kwScore < 50 && kwMissing.length > 0) {
    const top = kwMissing.slice(0, 3).join(', ');
    recs.push({ icon: '\u{1F511}', text: 'Key missing keywords: ' + top + '. Candidate may not have the required domain vocabulary.' });
  }
  const missingSkills = skillResults.filter(s => !s.found).slice(0, 3).map(s => s.name);
  if (skScore < 60 && missingSkills.length > 0) {
    recs.push({ icon: '\u{1F6E0}\uFE0F', text: 'Missing technical skills: ' + missingSkills.join(', ') + '. Consider assessment before decision.' });
  }
  if (exScore < 50) {
    recs.push({ icon: '\u{1F4C5}', text: 'Experience level appears below requirements. Verify actual tenure during interview.' });
  }
  if (edScore < 50) {
    recs.push({ icon: '\u{1F393}', text: 'Educational background may not meet stated requirements. Consider equivalent experience.' });
  }
  if (recs.length < 3) {
    recs.push({ icon: '\u{1F4A1}', text: 'Request work samples or portfolio to supplement automated scoring.' });
  }
  return recs.slice(0, 5);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { scoreCV };

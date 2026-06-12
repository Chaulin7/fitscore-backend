# CVsprings — Instructions for Use

*Deployer-facing instructions per EU AI Act Article 13. Version 1.3.0 — last updated 2026-06-12.*

> CVsprings is an AI system used for recruitment / candidate filtering and is therefore
> classified as **high-risk** under Annex III, point 4 of the EU AI Act. Provider
> obligations apply from **2 December 2027**. This document tells you, the deployer,
> what the system is for, how to operate it correctly, and what duties remain yours.

## 1. Intended purpose

CVsprings produces an **advisory candidate-fit score** (0–100, with four sub-scores)
by comparing the text of a CV against the text of a job description. It is intended to
help recruiters prioritise their review of applications.

It is **not** intended to:

- make, recommend with binding effect, or execute any hiring decision;
- rank candidates across *different* job descriptions or weight configurations;
- evaluate personality, demographics, or anything other than CV-text similarity
  to the job description;
- process scanned/image-only CVs (these are rejected, not scored).

## 2. Intended users

Recruiters and hiring teams inside the deployer's organization, signed in with
named accounts. Each saved record is attributed to the signed-in reviewer's email.

## 3. How the system works (summary)

The scoring engine is a **deterministic, rule-based lexical matcher** — not a
machine-learning model. Identical inputs always produce identical scores.

1. Plain text is extracted from the uploaded PDF/DOCX. Images, including photos,
   are never extracted or processed.
2. Four sub-scores are computed:
   - **Keywords** — % of the job description's 40 most frequent meaningful
     words/word pairs found in the CV.
   - **Skills** — % of the skills (from a curated list of 168) mentioned in the
     job description that also appear in the CV (neutral 50 if the JD mentions none).
   - **Experience** — heuristic comparison of "N years experience" patterns and
     seniority keywords between CV and JD.
   - **Education** — comparison of the highest qualification keyword detected
     (PhD > Master > Bachelor > diploma/certificate).
3. The overall score is the weighted average using your configured weights
   (default 40/30/20/10). Uploaded files are deleted from the server immediately
   after text extraction.

## 4. Correct operation

- **Always paste a complete job description** (minimum 50 characters enforced).
  Scores are only comparable between candidates assessed against the same JD and
  the same weights.
- **Set weights before analysing** a batch; weights are stored with each saved
  record for reconstruction.
- **Use the Anonymize toggle** when you want contact details, URLs, address lines,
  early year numbers and standalone name lines stripped before scoring. Note its
  limitations (section 6).
- **Record your decision** (shortlist / hold / reject) and any notes in the product
  so the audit log is complete. Decisions are yours; the system never sets one.

## 5. Human oversight requirement (Art. 14)

CVsprings is designed so that **no score is ever converted into a decision
automatically**. To deploy it lawfully and responsibly you must:

- keep a human reviewer in the loop for every decision;
- treat scores as one input among others — review the underlying CV before acting;
- not configure any downstream process of your own that auto-rejects or auto-advances
  candidates based on the score (this would defeat the system's design and create
  obligations the product cannot meet for you).

## 6. Known limitations

- **Vocabulary sensitivity.** The engine matches words, not meaning. Candidates who
  describe relevant experience in different words than the JD score lower; non-native
  phrasing or unconventional CV styles can be penalized.
- **JD-wording dependence.** Rephrasing the job description changes the extracted
  keyword set and therefore the scores. Only compare candidates within one JD + weights.
- **Anonymization is partial.** It removes emails, phone numbers, URLs, address-like
  lines, standalone years 1940–2015, and standalone name lines. It does **not** remove
  university names, employer names, club memberships, languages, employment gaps,
  or names mentioned mid-sentence — all potential proxies for protected characteristics.
- **Anonymize can remove legitimate dates** in the 1940–2015 range (e.g. older
  graduation years), slightly changing the experience signal.
- **Heuristic detection.** Unusual formats for years-of-experience or qualifications
  can be missed; verify both in interviews.
- **No demographic measurement.** CVsprings collects no demographic data and cannot
  detect demographic disparities in your outcomes.

## 7. What you (the deployer) must do

- **Inform candidates** that an AI-based tool supports screening. A ready-to-use
  notice (EN + NL) is provided in `candidate-notice.md` and on the in-app
  compliance page.
- **Keep humans in the loop** for all decisions (section 5).
- **Review outcomes periodically** against your own equality-monitoring data and
  processes; CVsprings' monitoring page shows scoring consistency but not
  demographic impact.
- **Honour candidate requests** for information about the process or for a
  human-only review.
- Assign named accounts to reviewers (decisions are attributed per user).

## 8. Logging the system performs

Each saved audit record stores: candidate name (or anonymized label), file name,
overall + four sub-scores, the weights used, verdict text, recruiter decision and
note, a job-description snippet (first 300 characters), role tag, anonymization
flag, **frontend app version, scoring-engine version (`modelId`), analysis
timestamp, and the reviewer's email**. Scoring data is immutable after creation:
only the decision and note can be changed, and every change (and deletion) is
recorded in an append-only change history. Records are scoped to your organization
and exportable as CSV.

---

*This document describes actual product behaviour as of version 1.3.0 and is not
legal advice.*

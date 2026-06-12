# CVsprings — EU AI Act Compliance Pack

*Client-facing summary. Version 1.3.0 — 2026-06-12. Suitable for export to branded PDF/DOCX.*

## What CVsprings is

CVsprings is an AI-powered candidate-fit analyzer. Recruiters upload CVs (PDF/DOCX)
and a job description; the system produces an advisory fit score (0–100) with four
transparent sub-scores (keywords, skills, experience, education). Scoring is
performed by a deterministic, rule-based engine — identical rules for every CV,
identical results for identical inputs. **All hiring decisions are made by human
recruiters; the system never decides.**

## Risk classification and timeline

- AI systems for recruitment and candidate filtering are **high-risk** under the
  EU AI Act, **Annex III, point 4**.
- Provider obligations (Articles 9–15) apply from **2 December 2027** (per the
  2026 Digital Omnibus amendment).
- CVsprings is building toward full conformity ahead of that date. Formal
  conformity assessment is **in progress**; no certification or completed
  conformity is claimed today.

## How product features map to obligations

| Obligation | What CVsprings does today |
|---|---|
| Risk management (Art. 9) | Documented risk log with mitigations and review dates; anonymization option; human-decision-only design. |
| Data governance (Art. 10) | No permanent CV storage (files deleted after text extraction); PII stripping when Anonymize is enabled; no demographic data collected. |
| Record-keeping (Art. 12) | Immutable audit log per analysis: scores, weights, scoring-engine version, app version, analysis timestamp, reviewer identity, and an append-only change history. |
| Transparency (Art. 13) | Instructions for use; in-app "Why this score?" explanations; published scoring methodology; candidate notice template (EN + NL). |
| Human oversight (Art. 14) | No automated decisions; explicit recruiter decision step; per-record reviewer attribution; persistent UI reminders that scores are a decision aid. |
| Accuracy & robustness (Art. 15) | Published deterministic scoring methodology; configurable weights stored per record; per-organization scoring-consistency monitoring. |

## Documents in this pack

1. **Instructions for use** (`instructions-for-use.md`) — intended purpose, correct
   operation, oversight requirement, limitations, deployer duties.
2. **Risk management log** (`risk-management-log.md`) — identified risks,
   mitigations, residual risks, review dates.
3. **Technical documentation outline** (`technical-documentation-outline.md`) —
   Annex IV working document: architecture, scoring pipeline, logging design;
   open items explicitly marked TODO.
4. **Candidate notice** (`candidate-notice.md`) — ready-to-paste applicant
   transparency text, English and Dutch.
5. **This cover document.**

## Honest-by-design

Everything in this pack describes implemented product behaviour. Where work
remains (formal test protocols, accuracy metrics, quality management system,
conformity assessment), the documents say so explicitly and label it as roadmap.
We believe demonstrable, verifiable claims are worth more to your compliance
file than broad ones.

---

*This document is provided for information and is not legal advice. Your
organization remains responsible for its own deployer obligations (candidate
information, human-in-the-loop decision processes, and periodic outcome review).*

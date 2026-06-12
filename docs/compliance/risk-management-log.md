# CVsprings — Risk Management Log (EU AI Act Art. 9)

*Living document. Owner: product/engineering. Version 1.3.0 — established 2026-06-12.*

Review cadence: every identified risk is re-reviewed at least every 6 months, or
immediately when the scoring engine, anonymizer, or data model changes.

| # | Risk | Mitigation (implemented) | Residual risk | Status | Date reviewed | Next review |
|---|------|--------------------------|---------------|--------|---------------|-------------|
| R1 | Scoring bias via lexical matching: candidates whose CVs use different vocabulary than the JD (incl. non-native speakers, career changers) score systematically lower. | Deterministic identical rules for every CV in a batch; published methodology; UI labels scores as a decision aid; human decision requirement; limitations documented in instructions for use and on the bias page. | Vocabulary correlation with protected characteristics cannot be ruled out; deployers must review outcomes. | Mitigated, monitored | 2026-06-12 | 2026-12-12 |
| R2 | Anonymization gives false confidence: proxies (university names, employer names, employment gaps, mid-sentence names) survive the text filter. | Exact removal list published; limitations stated prominently wherever anonymization is described; anonymization flag stored per record so its effect can be analysed later. | Proxy signals remain in scored text. | Mitigated (partially), documented | 2026-06-12 | 2026-12-12 |
| R3 | Over-reliance on scores / automation bias: recruiters treating the score as a verdict. | No auto-decision anywhere; explicit recruiter decision step; "Decisions are made by you, not by the AI" hints at every decision point; "AI-generated assessment — review before acting" under the score row; batch summary counts labelled "Above threshold" (not "Shortlisted"). | Deployer-side processes could still misuse scores; instructions for use prohibit auto-reject pipelines. | Mitigated | 2026-06-12 | 2026-12-12 |
| R4 | Data leakage across client organizations. | All audit, template, role, stats and export queries are org-scoped server-side; cross-org access returns 404; sessions are per-user with hashed tokens; reports/CSV use single-use 60-second download tokens. | Standard residual risk of operational security incidents. | Mitigated | 2026-06-12 | 2026-12-12 |
| R5 | Retention of applicant data beyond need. | Uploaded CV files are deleted from the server immediately after text extraction; no CV body text is persisted — only scores, a 300-char JD snippet, and recruiter inputs in the audit log. | Candidate name and file name persist in audit records the deployer chooses to save; deployer retention policy applies. | Mitigated, deployer-shared | 2026-06-12 | 2026-12-12 |
| R6 | Score instability across JD phrasings: rephrasing the JD changes keyword extraction and shifts all scores. | Documented limitation; instructions require comparing candidates only within one JD + weights; weights and JD snippet stored per record. | Inherent to frequency-based keyword extraction. | Monitored | 2026-06-12 | 2026-12-12 |
| R7 | Anonymize strips legitimate years (1940–2015 filter), perturbing the experience signal for affected CVs. | Documented limitation in instructions for use and bias page. | Small score shifts possible for anonymized CVs with older dates. | Monitored — candidate fix on roadmap (smarter date heuristic) | 2026-06-12 | 2026-12-12 |
| R8 | Record tampering / unverifiable history. | Scoring data immutable after creation (PATCH whitelist: decision + note only, enforced server-side); append-only change table guarded by DB triggers; deletions logged with full record snapshot; provenance fields (app version, engine version, timestamp, reviewer email) on every record. | DB-admin-level access could still alter data; operational control. | Mitigated | 2026-06-12 | 2026-12-12 |
| R9 | Image-based / unparseable CVs silently skipped in batches could disadvantage those candidates. | Per-file error entries are returned in batch results (not silently dropped); single analysis returns an explicit error. | Recruiter must notice and handle errored files manually. | Monitored | 2026-06-12 | 2026-12-12 |

## Adding entries

New risks are appended with the next R-number; closed risks are kept with status
"Closed (date)" — rows are never deleted.

## Roadmap items referenced

- Smarter anonymizer date heuristic (R7).
- Formal accuracy/robustness test protocol (see `technical-documentation-outline.md`, TODO items) — will feed new rows here.

---

*This log records actual identified risks and implemented mitigations as of
version 1.3.0. It is maintained as part of work toward Art. 9 conformity; it is
not a completed conformity assessment.*

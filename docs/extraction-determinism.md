# CV Text Extraction: Determinism & Provenance

*Last updated 11 July 2026. Covers the extraction engine migration
(`feat/pdfjs-extraction`), the determinism guarantees CVsprings makes for CV
text extraction, and the incident record for the defect the migration
methodology surfaced in the previous engine.*

---

## 1. The pipeline

**Engine:** `pdfjs-dist@5.4.624` (Mozilla pdf.js, Apache-2.0), **exact-pinned**
— no `^`/`~` range. The pinned version is audit provenance: a version bump is
a deliberate re-baselining event, never an accident of `npm install`.

**Assembly layer** (`src/services/pdfExtractor.js`, `assemblerVersion 1.0.0`
— bumped on any algorithm change):

1. **Guards, before any parsing:** > 15 MB rejected; > 30 pages rejected
   after load; both deterministic — the same file fails the same way on every
   run.
2. **Serial page processing** — pages are awaited one at a time; no parallel
   fan-out anywhere in the parse path.
3. **Two-column detection** — a threshold-driven integer scan for a vertical
   gutter (≥ 18 pt wide, between 25–75 % of page width, clear over ≥ 60 % of
   the text height, ≥ 20 % of items on each side). If found, the left column
   is emitted in full before the right, so evidence snippets never interleave
   a skills sidebar with the main experience column. Common in Benelux/DACH
   CV layouts.
4. **Line banding** — items share a line when their y differs by
   ≤ max(2 pt, 0.4 × median item height); every sort ends in an explicit
   tie-breaker on original item index (never relies on sort stability).
5. **Intra-line joining** — horizontal gaps ≤ 1 pt concatenate *without* a
   space (pdf.js splits items mid-word; wrong spaces would break Dutch/German
   compounds like *projectmanagementvaardigheden*).
6. **Normalization, in order:** tabs → space; Unicode space variants
   (NBSP, thin/narrow spaces) → U+0020; soft hyphens (U+00AD) and control
   characters stripped; whitespace runs collapsed; lines joined with `\n`,
   pages with a blank line; 3+ newlines collapsed to 2; trimmed; **NFC**
   (composed vs decomposed diacritics — *coördinatie*, *Müller* — compare
   equal). Ligatures are expanded by the engine (fi → f+i). Case is
   preserved; lowercasing belongs to the matcher.
7. **SHA-256** over the UTF-8 bytes of the canonical text — text only, never
   timestamps.

**Determinism constraints held by the code:** no randomness, no time, no
locale APIs in the text-production path; the extractor is a pure function of
the input bytes plus the pinned engine.

**Liveness breaker:** a single 60-second timeout wraps each extraction as a
DoS backstop. Measured headroom: the 25-CV validation set averages ~22 ms per
file (max ~409 ms including one-time engine warmup); a dense 30-page
synthetic PDF extracts in ~300 ms — >100× under the limit. The breaker fires
only for pathological input or a broken environment, logs loudly
(`[pdfExtractor] liveness breaker fired…`), and the determinism guarantee is
conditional on it never firing for legitimate input.

**Failure taxonomy** (all deterministic, HTTP 422/400): `INVALID_FILE` (size/
page guards), `PDF_ENCRYPTED` (password-protected), `UNPROCESSABLE_FILE`
(malformed), `IMAGE_ONLY_PDF` (scanned, no text layer — surfaced to the
recruiter with OCR guidance), `PROCESSING_TIMEOUT` (breaker).

## 2. Provenance in the audit record

Every analysis response carries an `extraction` block:
`{ engine, engineVersion, assemblerVersion, textSha256, pageCount, charCount }`.
The hash covers the canonical extracted text, computed **before** any
anonymization.

When an assessment is saved to the audit log, provenance is **server-bound**:
`/api/analyze` records each summary it issues in a server-side cache keyed by
`(orgId, textSha256)`; the save endpoint resolves the client's echoed sha
against that cache and persists the **server-held copy**. A sha the server
never issued stores `null` provenance — the client cannot fabricate or alter
engine versions, hashes, or counts. (In-memory cache: saves made > 24 h after
analysis or across a server restart store `null` rather than trusting the
client.)

**Reproducibility claim:** same CV bytes + same JD + same weights + same
engine/assembler versions ⇒ same canonical text (verifiable by hash), same
scores, same report.

## 3. Regression gates

- `npm run extraction:verify` — runs every PDF in the validation set 10
  times, each run in a different seeded-shuffle order, and compares against
  the committed manifest `test/golden/extraction-baseline.json`. Any drift or
  any run-to-run instability fails the command. Order-shuffling is the point:
  it proves no cross-file state leakage.
- **Post-deploy step:** run `extraction:verify` once on the Render instance
  (`CV_DATASET_DIR` pointing at the validation set) and compare against the
  committed manifest — that converts "deterministic on the dev laptop" into
  "deterministic across environments", which is the claim that matters.
- **Re-baselining procedure** (engine or assembler upgrade): bump the pin /
  `EXTRACTOR_VERSION`, run `npm run extraction:baseline`, review the manifest
  diff file-by-file, re-run the A/B diff if warranted, commit the new
  baseline in the same PR as the upgrade. Hash changes are expected and
  documented; silent drift is the failure mode being prevented.

## 4. Incident record: cross-document text leakage in the previous engine

**This section documents a defect our determinism methodology caught in our
own stack, and how we handled it.**

- **Prior engine:** `pdf-parse@1.1.4`, bundling a 2017 build of pdf.js
  (v1.10.100). In production since the project's start; from 1 July 2026 it
  ran behind a 3-attempt retry loop added to paper over intermittent
  `bad XRef entry` failures.
- **Observed defect(s):** outcomes depended on hidden in-process state, not
  on the input bytes. Reproduced and committed in `scripts/repro-leak.js`:
  (a) the *first* parse in a fresh process throws on files that parse fine
  warm; (b) in one warm process, the same bytes parse via one Buffer object
  but throw when re-read fresh from disk; (c) some failures escape
  `try/catch` via internal timer callbacks. Worst: **cross-document
  leakage** — in the full-dataset A/B run (reproduced 3/3 times,
  `EXTRACTION_DIFF.md`), pdf-parse returned **cv_14's text when asked for
  cv_15's bytes** (token match to cv_14: Jaccard 1.000), while cv_15 alone
  throws 5/5. A batch containing a corrupt-xref CV could therefore silently
  score one candidate against another candidate's document. The harness was
  audited to exclude an artifact (per-file locals, sequential await, distinct
  reads per file).
- **Production exposure:** the API server is a long-lived process, i.e.
  permanently in the "warm state" regime where the substitution lives, and
  the 1 July retry loop reused one buffer per file. Exposure cannot be
  excluded for batches processed before the migration.
- **Forensic scan:** `scripts/scan-leak-fingerprint.js` (strictly read-only)
  scans stored audit records for the leak's fingerprint — identical analysis
  detail + scores under different candidate/file names within the same batch
  proxy (`org_id` + JD snippet; records carry no batch id). Validated against
  a synthetic dataset. **Status: production run pending** — execute on the
  Render instance: `DB_PATH=<disk>/audit.db node
  scripts/scan-leak-fingerprint.js`, then record the result here. Flagged
  pairs are review signals, not proof (genuinely duplicate CVs also match);
  no record is modified by the scan.
- **The cv_15 correction:** in the A/B diff, cv_15's old score (38) had been
  computed on cv_14's leaked text; its new score (40) is the first score ever
  computed on cv_15's actual content. Acknowledged as a correction, not a
  regression. All 24 other files: token-identical text, identical scores.
- **How it was caught:** not by a failing test — every individual parse
  looked plausible. It surfaced because the migration required (1) a golden
  harness that re-runs the corpus in shuffled orders and demands identical
  outcomes, and (2) an A/B diff that attributes any heavy divergence against
  the rest of the corpus. A conventional test suite (fixed order, fixed
  fixtures, "did it parse?") would have kept passing.
- **Remediation:** engine replaced by exact-pinned `pdfjs-dist@5.4.624`
  behind an owned, pure assembly layer; retries removed (a deterministic
  engine fails the same way every time); per-analysis SHA-256 provenance
  recorded server-side so any future substitution would be provable from the
  audit record itself; golden manifest committed as a permanent regression
  gate.

## 5. Known limitations

- **No OCR.** Scanned/image PDFs are rejected as `IMAGE_ONLY_PDF` and the
  recruiter is told to upload a text-based or OCR-processed version.
- **No de-hyphenation across line breaks.** Naive de-hyphenation corrupts
  legitimate hyphens (*E-Mail*, *front-end*); conservative and deterministic
  beats clever. May be revisited with a dictionary-gated approach.
- **Two columns maximum.** Three-plus-column layouts fall back to
  single-flow assembly.
- **cMaps/standard fonts** are configured from the pinned package's own
  files (no system-font dependence). Latin-script EU CVs rely on embedded
  ToUnicode maps; exotic encodings without them may degrade (deterministically).

## Appendix: leak-fingerprint query

Conceptually: group audit records by `(org_id, jd_snippet)` — the batch
proxy — and flag any pair within a group where
`sha256(found ∥ missing ∥ skills ∥ matches ∥ scores)` is identical while
`candidate_name`/`file_name` differ. Implementation:
`scripts/scan-leak-fingerprint.js` (read-only; output
`scripts/output/leak-scan.json`, gitignored).

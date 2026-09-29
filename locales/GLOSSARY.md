# CVsprings UI glossary (en / nl / de)

Use these terms in every string in `locales/*.json`, so the product reads as one voice
in each language. When a term is missing, add it here with the key(s) that use it.

## Tone

| | Dutch (`nl`) | German (`de`) |
|---|---|---|
| Address | **je / jij / jouw**, app and marketing alike | **Sie / Ihr** (formal), everywhere |
| Register | Professional B2B, plain and direct. No English words where a common Dutch one exists. | Professional B2B. Established anglicisms from HR tech are fine (Score, Shortlist, Recruiter, Dashboard). |
| Quotation marks | “…” | „…“ |
| People nouns | not gendered in Dutch (kandidaat, collega, eigenaar) | **generic masculine** — the current convention: Kandidat, Nutzer, Inhaber, Kollege (e.g. „Senden Sie diesen Link an Ihren Kollegen.“). No pair forms („Kollegin oder Kollege“), gender star or colon, so every string reads the same way; if this changes, it changes for all of `de.json` at once. |
| Dashes | spaced em dash (—) as in the English copy | spaced en dash (–) in running text; the page's own em-dash layout marks (e.g. `CL. 01 — …`) stay |

## Product terms

| English | Dutch | German | Notes |
|---|---|---|---|
| CVsprings | CVsprings | CVsprings | Never translated or split. |
| FitScore / score | FitScore / score | FitScore / Score | Product name; lower-case *score* in running text (nl). |
| CV | cv (pl. cv's) | Lebenslauf (pl. Lebensläufe); **CV-** in product compounds (CV-Screening, CV-Analysen) | Dutch spelling per Woordenlijst: lower-case *cv*. |
| CV screening | cv-screening | CV-Screening | |
| candidate | kandidaat | Kandidat (pl. Kandidaten) | German uses the generic masculine (see Tone → People nouns). |
| vacancy | vacature | Stelle | |
| role / position | functie | Stelle | “Role” in the app means the vacancy being screened for. |
| job description (JD) | functieomschrijving | Stellenbeschreibung | No abbreviation in nl/de. |
| job profile | functieprofiel | Stellenprofil | |
| job spec | functie-eisen | Anforderungsprofil | |
| recruiter | recruiter | Recruiter | |
| (recruitment) agency | (recruitment)bureau | Agentur / Personalvermittlung | |
| audit log | auditlog | Audit-Log | |
| audit trail | audittrail | Prüfpfad | |
| audit record | auditrecord | Audit-Datensatz | |
| shortlist (noun) | shortlist | Shortlist | |
| decision: shortlist / hold / reject | shortlist / aanhouden / afwijzen | Shortlist / Zurückstellen / Absage | Display only — stored as the codes `shortlist` / `hold` / `reject`. |
| Keywords / Skills / Experience / Education | Trefwoorden / Vaardigheden / Ervaring / Opleiding | Schlüsselwörter / Kompetenzen / Berufserfahrung / Ausbildung | The four sub-scores. |
| sub-score / overall score | deelscore / totaalscore | Teilscore / Gesamtscore | |
| weights | gewichten | Gewichtungen | |
| Anonymize (the toggle) | Anonimiseren | Anonymisieren | |
| bias monitoring | biasmonitoring | Bias-Monitoring | |
| deterministic | deterministisch | deterministisch | |
| rules engine / rules-based | regelengine / regelgebaseerd | Regel-Engine / regelbasiert | |
| human oversight | menselijk toezicht | menschliche Aufsicht | EU AI Act term. |
| deployer (AI Act) | organisatie die de tool inzet | Betreiber | Official AI Act terms: nl *gebruiksverantwoordelijke*, de *Betreiber*. |
| EU AI Act | EU AI Act | EU AI Act | Kept as the proper name (official: nl *AI-verordening*, de *KI-Verordnung*). |
| GDPR | AVG | DSGVO | |
| VAT / excl. VAT | btw / excl. btw | MwSt. / zzgl. MwSt. | |
| plan (subscription tier) | abonnement | Tarif | |
| Free / Pro / Team | Gratis / Pro / Team | Kostenlos / Pro / Team | Pro and Team are names, not translated. |
| trial | proefperiode | Testphase | |
| Settings | Instellingen | Einstellungen | |
| Plan & Billing | Abonnement & facturatie | Tarif & Abrechnung | |
| Sign in / Log in | Inloggen | Anmelden | |
| Sign up | Registreren | Registrieren | |
| organization / owner | organisatie / eigenaar | Organisation / Inhaber | |
| demo | demo | Demo | |
| KW / SK / EX / ED (sub-score column heads) | TW / VH / ER / OP | SW / KO / BE / AB | Initials of the four sub-scores in each language; the full name is the column's tooltip (`<abbr title>`). |
| template (role/JD template) | sjabloon | Vorlage | |
| retention (period) | bewaartermijn | Aufbewahrungsfrist | |
| purge (retention job) | opschoning / opschoonrun | Löschlauf | |
| dry run | proefdraaien | Probelauf | |
| feature request | functieverzoek | Funktionswunsch | |
| read-only (paused account) | alleen-lezen | schreibgeschützt | |
| batch | batch | Batch | |
| Analyzer (tab) | Analyse | Analyse | |
| Role History (tab) | Functiehistorie | Stellenverlauf | |
| Strong / Possible / Weak Fit (app score bands) | sterke / mogelijke / zwakke match | starke / mögliche / geringe Eignung | The app's own bands in the info modal — not the scorer's verdict bands, which stay English. |

## Things that stay English on purpose

- **What the engine literally matches.** The scoring engine matches English words, so
  examples of what it detects stay English inside translated sentences: “7 years of
  experience”, director / principal / lead / senior / junior, PhD / Master / Bachelor /
  diploma / certificate.
- **Scorer output**, for now: the verdict bands (“Excellent / Good / Partial / Poor Match”),
  and the content of “Recommendations” and “Why this score?” are produced by the scoring
  pipeline. Phase 3 translates them at display time only; the scorer keeps emitting stable
  codes. In the app the two headings are translated and carry an “(in English)” /
  “(in het Engels)” / „(auf Englisch)“ note, and the blocks are marked `lang="en"`.
- **Data exports**: the batch CSV and audit CSV headers and decision codes (Phase 3).
- **Server diagnostics** shown verbatim: a Stripe card-decline message, a purge run's
  error text, the engine version string.
- **Language names** in the switcher are always native: English, Nederlands, Deutsch.
- **Legal text**: Terms, Privacy Policy and the body of the EU AI Act page.

## Conventions for keys and markup

- Keys are namespaced and flat: `landing.hero.title`, `auth.login.submit`,
  `errors.<API code>[.<field or reason>]`, `plans.*` for the server's tier table.
- `{name}` placeholders must appear in every translation of a key (i18n:check enforces it).
  Numbers passed as values are formatted for the language (1.234 vs 1,234).
- Plurals: `key.one` / `key.other` (optional `key.zero`), chosen with `Intl.PluralRules`.
- Inline markup only in keys ending in `_html`, only `<strong> <em> <b> <i> <code> <kbd>
  <sup> <sub> <br>`, and links as `<a0>…</a0>`, `<a1>…</a1>` (the link's target comes from
  the page, never from the dictionary). A translation must use exactly the English tags.

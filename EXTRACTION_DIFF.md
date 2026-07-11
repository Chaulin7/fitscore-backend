# EXTRACTION_DIFF — pdf-parse 1.1.4 → pdfjs-dist 5.4.624

Dataset: 25 PDFs. Old engine given 3 attempts/file (mirrors the removed retry loop). Scores computed with the production scorer against the built-in sample JD, default weights {"kw":40,"sk":30,"ex":20,"ed":10} — a synthetic but stable comparison basis.

## Old-engine instability, observed directly

Each file was run through pdf-parse 5x on identical bytes (no retries). More than one distinct outcome = the rotating-failure bug:

None observed in this run (instability is probabilistic; see recon history).

The new engine's golden harness (10 shuffled runs) shows one outcome per file, every run.

## Known rotating-failure files (the original bug)

- **cv_01.pdf** — old: OK (1431 chars) · new: OK (1431 chars)
- **cv_11.pdf** — old: OK (726 chars) · new: OK (726 chars)
- **cv_15.pdf** — old: OK (881 chars) · new: OK (725 chars)
- **cv_24.pdf** — old: OK (723 chars) · new: OK (723 chars)

## Per-file comparison

| file | old outcome | new outcome | Jaccard | score old→new |
|---|---|---|---|---|
| cv_01.pdf | OK (1431 chars) | OK (1431 chars) | 1.000 | 51 → 51 |
| cv_02.pdf | OK (1191 chars) | OK (1191 chars) | 1.000 | 50 → 50 |
| cv_03.pdf | OK (915 chars) | OK (915 chars) | 1.000 | 52 → 52 |
| cv_04.pdf | OK (951 chars) | OK (951 chars) | 1.000 | 54 → 54 |
| cv_05.pdf | OK (922 chars) | OK (922 chars) | 1.000 | 43 → 43 |
| cv_06.pdf | OK (1085 chars) | OK (1085 chars) | 1.000 | 53 → 53 |
| cv_07.pdf | OK (974 chars) | OK (974 chars) | 1.000 | 41 → 41 |
| cv_08.pdf | OK (1000 chars) | OK (1000 chars) | 1.000 | 51 → 51 |
| cv_09.pdf | OK (916 chars) | OK (916 chars) | 1.000 | 50 → 50 |
| cv_10.pdf | OK (799 chars) | OK (799 chars) | 1.000 | 39 → 39 |
| cv_11.pdf | OK (726 chars) | OK (726 chars) | 1.000 | 52 → 52 |
| cv_12.pdf | OK (815 chars) | OK (815 chars) | 1.000 | 49 → 49 |
| cv_13.pdf | OK (786 chars) | OK (786 chars) | 1.000 | 47 → 47 |
| cv_14.pdf | OK (881 chars) | OK (881 chars) | 1.000 | 38 → 38 |
| cv_15.pdf | OK (881 chars) | OK (725 chars) | 0.215 | 38 → 40 ⚠ |
| cv_16.pdf | OK (971 chars) | OK (971 chars) | 1.000 | 45 → 45 |
| cv_17.pdf | OK (838 chars) | OK (838 chars) | 1.000 | 47 → 47 |
| cv_18.pdf | OK (911 chars) | OK (911 chars) | 1.000 | 48 → 48 |
| cv_19.pdf | OK (848 chars) | OK (848 chars) | 1.000 | 29 → 29 |
| cv_20.pdf | OK (895 chars) | OK (895 chars) | 1.000 | 18 → 18 |
| cv_21.pdf | OK (777 chars) | OK (777 chars) | 1.000 | 23 → 23 |
| cv_22.pdf | OK (863 chars) | OK (863 chars) | 1.000 | 39 → 39 |
| cv_23.pdf | OK (909 chars) | OK (909 chars) | 1.000 | 51 → 51 |
| cv_24.pdf | OK (723 chars) | OK (723 chars) | 1.000 | 52 → 52 |
| cv_25.pdf | OK (1270 chars) | OK (1270 chars) | 1.000 | 52 → 52 |

## Cross-file leakage check (old engine)

For every heavily-diverging file (Jaccard < 0.5), the OLD engine's output is compared against the NEW engine's output for every OTHER file in the dataset. A near-perfect match means pdf-parse emitted a different document's text — cross-file state leakage:

- **cv_15.pdf**: old output matches **cv_14.pdf**'s content (Jaccard 1.000) — pdf-parse returned the wrong document's text for this file in this run.

## Skill-match set changes (sample JD)

- **cv_15.pdf**: gained [aws, docker, postgresql] · lost []

## First divergence snippets (assembly-order differences are expected)

### cv_01.pdf (char 451)
- old: "to end.\nEXPERIENCE\nSenior Full-Stack Engineer — Recrubo SaaS\n2021 – Present\nAmsterdam\n•\nTech lead for a 4-engineer squad"
- new: "to end.\nEXPERIENCE\nSenior Full-Stack Engineer — Recrubo SaaS 2021 – Present\nAmsterdam\n• Tech lead for a 4-engineer squad"

### cv_02.pdf (char 530)
- old: "s · Terraform\nEXPERIENCE\nSenior Software Engineer — Personio\n2019 – Present\nMunich/Remote\n•\nFull-stack delivery on an HR"
- new: "s · Terraform\nEXPERIENCE\nSenior Software Engineer — Personio 2019 – Present\nMunich/Remote\n• Full-stack delivery on an HR"

### cv_03.pdf (char 372)
- old: " from API to UI.\nExperience\nFull-Stack Developer — Channable\n2020 – Present\nUtrecht\n•\nBuilt customer-facing features in "
- new: " from API to UI.\nExperience\nFull-Stack Developer — Channable 2020 – Present\nUtrecht\n• Built customer-facing features in "

### cv_04.pdf (char 336)
- old: "ript on internal tools.\nEXPERIENCE\nBackend Engineer — Bynder\n2019 – Present\nAmsterdam\n•\nDesigned and scaled Node.js REST"
- new: "ript on internal tools.\nEXPERIENCE\nBackend Engineer — Bynder 2019 – Present\nAmsterdam\n• Designed and scaled Node.js REST"

### cv_05.pdf (char 415)
- old: "/CD · AWS (basic)\nEXPERIENCE\nFull-Stack Engineer — Sendcloud\n2021 – Present\nEindhoven\n•\nReact/TypeScript frontend and No"
- new: "/CD · AWS (basic)\nEXPERIENCE\nFull-Stack Engineer — Sendcloud 2021 – Present\nEindhoven\n• React/TypeScript frontend and No"

### cv_06.pdf (char 410)
- old: "xperience.\nExperience\nHead of Engineering — Exact (ERP SaaS)\n2015 – Present\nDelft\n•\nLed a 40-engineer org; set architect"
- new: "xperience.\nExperience\nHead of Engineering — Exact (ERP SaaS) 2015 – Present\nDelft\n• Led a 40-engineer org; set architect"

### cv_07.pdf (char 474)
- old: "n and more.\nEXPERIENCE\nFrontend Developer — WebStudio Almere\n2023 – Present\nAlmere\n•\nBuilt marketing websites and a smal"
- new: "n and more.\nEXPERIENCE\nFrontend Developer — WebStudio Almere 2023 – Present\nAlmere\n• Built marketing websites and a smal"

### cv_08.pdf (char 392)
- old: " ecosystem.\nEXPERIENCE\nSenior Software Engineer — Teamleader\n2019 – Present\nGhent\n•\nBackend in Python/Django; frontend i"
- new: " ecosystem.\nEXPERIENCE\nSenior Software Engineer — Teamleader 2019 – Present\nGhent\n• Backend in Python/Django; frontend i"

### cv_09.pdf (char 383)
- old: "nd travel.\nExperience\nCareer break — Parental leave & travel\n2023 – 2024\n•\n18-month planned break; completed an advanced"
- new: "nd travel.\nExperience\nCareer break — Parental leave & travel 2023 – 2024\n• 18-month planned break; completed an advanced"

### cv_10.pdf (char 358)
- old: "er, eager to grow.\nEXPERIENCE\nFull-Stack Developer — Studocu\n2024 – Present\nAmsterdam\n•\nReact/TypeScript and Node.js fea"
- new: "er, eager to grow.\nEXPERIENCE\nFull-Stack Developer — Studocu 2024 – Present\nAmsterdam\n• React/TypeScript and Node.js fea"

### cv_11.pdf (char 398)
- old: "AWS · Docker · CI/CD\nEXPERIENCE\nSoftware Engineer — Backbase\n2022 – Present\nAmsterdam\n•\nFull-stack work: React/TypeScrip"
- new: "AWS · Docker · CI/CD\nEXPERIENCE\nSoftware Engineer — Backbase 2022 – Present\nAmsterdam\n• Full-stack work: React/TypeScrip"

### cv_12.pdf (char 380)
- old: "ly.\nEXPERIENCE\nContract Full-Stack Dev — Various (6 clients)\n2022 – Present\nRemote\n•\nSix 3–6 month contracts: React/Type"
- new: "ly.\nEXPERIENCE\nContract Full-Stack Dev — Various (6 clients) 2022 – Present\nRemote\n• Six 3–6 month contracts: React/Type"

### cv_13.pdf (char 347)
- old: "ntend work.\nExperience\nSenior Backend Engineer — Booking.com\n2018 – Present\nAmsterdam\n•\nJava/Spring and Go microservices"
- new: "ntend work.\nExperience\nSenior Backend Engineer — Booking.com 2018 – Present\nAmsterdam\n• Java/Spring and Go microservices"

### cv_14.pdf (char 352)
- old: "ckend experience.\nEXPERIENCE\nSenior Frontend Engineer — Miro\n2020 – Present\nAmsterdam\n•\nBuilt and owned a React/TypeScri"
- new: "ckend experience.\nEXPERIENCE\nSenior Frontend Engineer — Miro 2020 – Present\nAmsterdam\n• Built and owned a React/TypeScri"

### cv_15.pdf (char 0)
- old: "Isabelle Dubois\nSenior Frontend Engineer\nAmsterdam, Netherla"
- new: "Jeroen van Dijk\nFullstack Engineer\nTilburg, Netherlands | je"

### cv_16.pdf (char 380)
- old: " to the EU.\nEXPERIENCE\nSenior Full-Stack Engineer — Razorpay\n2019 – Present\nBengaluru\n•\nReact/TypeScript frontend and No"
- new: " to the EU.\nEXPERIENCE\nSenior Full-Stack Engineer — Razorpay 2019 – Present\nBengaluru\n• React/TypeScript frontend and No"

### cv_17.pdf (char 367)
- old: "\nExperience\nSoftware Engineering Intern — NXP Semiconductors\n2025 (6 months)\nNijmegen\n•\nBuilt an internal React/TypeScri"
- new: "\nExperience\nSoftware Engineering Intern — NXP Semiconductors 2025 (6 months)\nNijmegen\n• Built an internal React/TypeScri"

### cv_18.pdf (char 375)
- old: " projects.\nEXPERIENCE\nSenior Data Scientist — Ahold Delhaize\n2019 – Present\nZaandam\n•\nBuilt ML models in Python; product"
- new: " projects.\nEXPERIENCE\nSenior Data Scientist — Ahold Delhaize 2019 – Present\nZaandam\n• Built ML models in Python; product"

### cv_19.pdf (char 352)
- old: "gile coaching.\nExperience\nTechnical Project Manager — Ordina\n2016 – Present\nNieuwegein\n•\nManaged delivery of web platfor"
- new: "gile coaching.\nExperience\nTechnical Project Manager — Ordina 2016 – Present\nNieuwegein\n• Managed delivery of web platfor"

### cv_20.pdf (char 356)
- old: "software engineer.\nEXPERIENCE\nSenior Product Designer — Mews\n2019 – Present\nAmsterdam\n•\nEnd-to-end product design for a "
- new: "software engineer.\nEXPERIENCE\nSenior Product Designer — Mews 2019 – Present\nAmsterdam\n• End-to-end product design for a "

### cv_21.pdf (char 387)
- old: "pment experience.\nExperience\nSenior Firmware Engineer — ASML\n2016 – Present\nVeldhoven\n•\nReal-time firmware in C/C++ for "
- new: "pment experience.\nExperience\nSenior Firmware Engineer — ASML 2016 – Present\nVeldhoven\n• Real-time firmware in C/C++ for "

### cv_22.pdf (char 408)
- old: "S · Docker\nEXPERIENCE\nFull-Stack Developer — Stealth startup\n2023 – Present\nRemote\n•\nReact/TypeScript + Node.js MVP on P"
- new: "S · Docker\nEXPERIENCE\nFull-Stack Developer — Stealth startup 2023 – Present\nRemote\n• React/TypeScript + Node.js MVP on P"

### cv_23.pdf (char 380)
- old: "aaS.\nEXPERIENCE\nFull-Stack Engineer — sevDesk (fintech SaaS)\n2020 – Present\nCologne\n•\nReact/TypeScript frontends and Nod"
- new: "aaS.\nEXPERIENCE\nFull-Stack Engineer — sevDesk (fintech SaaS) 2020 – Present\nCologne\n• React/TypeScript frontends and Nod"

### cv_24.pdf (char 278)
- old: "ostgreSQL and AWS.\nEXPERIENCE\nFull-Stack Engineer — Usabilla\n2021 – 2024\nAmsterdam\n•\nReact/TypeScript + Node.js on Postg"
- new: "ostgreSQL and AWS.\nEXPERIENCE\nFull-Stack Engineer — Usabilla 2021 – 2024\nAmsterdam\n• React/TypeScript + Node.js on Postg"

### cv_25.pdf (char 439)
- old: "ributor.\nEXPERIENCE\nLead Full-Stack Engineer — Carerix (ATS)\n2020 – Present\nRotterdam\n•\nLead engineer on an applicant-tr"
- new: "ributor.\nEXPERIENCE\nLead Full-Stack Engineer — Carerix (ATS) 2020 – Present\nRotterdam\n• Lead engineer on an applicant-tr"


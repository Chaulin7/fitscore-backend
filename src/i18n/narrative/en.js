'use strict';

/**
 * src/i18n/narrative/en.js — English template catalogue for the narrative layer.
 *
 * EVERY customer-facing string in the narrative sections lives here, including
 * the section headings. src/routes/reportRenderer.js contains no prose of its
 * own for those sections, so translating the report is adding a sibling file
 * (nl.js, de.js) and one line in ./index.js — never editing generator logic and
 * never editing the renderer.
 *
 * Placeholders are {name}. The generator throws on a template key that does not
 * resolve and on a placeholder it cannot fill, rather than emitting a key or a
 * literal brace into a candidate's PDF. A broken build is recoverable; a report
 * that says "{score}" to a hiring manager is not.
 *
 * WRITING RULES, enforced by narrativeGenerator.test.js:
 *
 *   Every line describes THE DOCUMENT, never the person. "The CV does not
 *   document X" — not "the candidate lacks X". The distinction is not
 *   politeness: the engine has read a CV, not met an applicant, and a sentence
 *   that claims otherwise asserts something the record cannot support.
 *
 *   Banned outright: lacks, missing, weak, poor, unqualified, insufficient,
 *   fails (and inflections). A test asserts none of them appear in any string
 *   in this file.
 *
 *   Number agreement must hold at every count, including one. "1 of 6 skills
 *   appear" is a defect a reader notices immediately and reads as carelessness
 *   on a compliance document, so the sentences are phrased to avoid agreeing
 *   with a substituted number at all ("The CV contains {count} of the {total}
 *   ...") rather than carrying singular and plural variants of each key.
 *
 *   Nothing prescriptive. No "recommend", "proceed", "strong hire". The report
 *   already carries an advisory framing box stating that it is a
 *   requirement-matching aid and that all hiring decisions remain with the
 *   human reviewer; a narrative that then implied a decision would contradict
 *   the compliance posture of the document it sits inside.
 *
 * templateVersion is stamped into every NarrativeBlock and into the PDF
 * provenance footer. ANY edit to ANY string below must bump it — two reports
 * carrying the same version must be word-for-word comparable.
 */

/**
 * Bump on any edit to any string in TEMPLATES.
 *
 * t-2: band sentences reworded. "documents evidence AGAINST the requirements"
 *      parsed as evidence contradicting them — the opposite of the intended
 *      reading. Now phrased as extent of what the CV documents, matching the
 *      register of the gap lines ("The CV does not document X").
 */
const templateVersion = 't-2';

const TEMPLATES = Object.freeze({
  // Band label + the opening sentence of the assessment paragraph. Label and
  // sentence are separate because the label also appears on its own, in the
  // NarrativeBlock a caller may render elsewhere.
  band: Object.freeze({
    strong: Object.freeze({
      label: 'Strong alignment',
      sentence: 'The CV documents most of the recorded requirements, scoring {score} of 100.',
    }),
    partial: Object.freeze({
      label: 'Partial alignment',
      sentence: 'The CV documents some of the recorded requirements, scoring {score} of 100.',
    }),
    limited: Object.freeze({
      label: 'Limited alignment',
      sentence: 'The CV documents a limited share of the recorded requirements, scoring {score} of 100.',
    }),
    minimal: Object.freeze({
      label: 'Minimal alignment',
      sentence: 'The CV documents few of the recorded requirements, scoring {score} of 100.',
    }),
  }),

  skills: Object.freeze({
    matchedAll: 'The CV contains every skill named in the job description ({total} in total).',
    matchedNone: 'The CV contains none of the skills named in the job description ({total} in total).',
    matched: 'The CV contains {count} of the {total} skills named in the job description, including {items}.',
  }),

  experience: Object.freeze({
    meets: 'The experience signals in the CV align with the level recorded for this role, scoring {score} of 100.',
    below: 'The CV documents experience signals below the level recorded for this role, scoring {score} of 100.',
  }),

  education: Object.freeze({
    met: 'The CV documents a qualification at the level recorded for this role.',
    notEvidenced: 'The CV does not document a qualification at the level recorded for this role.',
  }),

  keywords: Object.freeze({
    matched: 'The CV contains {count} of the {total} job-description keywords, scoring {score} of 100.',
  }),

  gap: Object.freeze({
    skill: 'The CV does not document {items}.',
    keywords: 'The CV does not contain the following job-description terms: {items}.',
    experience: 'The CV does not document experience at the level recorded for this role.',
    education: 'The CV does not document a qualification at the level recorded for this role.',
  }),

  gaps: Object.freeze({
    disclaimer: 'Absence of evidence is not evidence of absence. These items indicate what the CV does not document, not what the candidate cannot do.',
  }),

  // Open and non-leading: each asks the candidate to describe, not to confirm
  // a conclusion the report has already drawn.
  question: Object.freeze({
    skill: 'Could you describe a piece of work where you used {item}?',
    leadership: 'Could you walk me through the scope and duration of your most recent role?',
    keyword: 'How does your experience relate to {item} as described in this role?',
  }),

  // Printed in place of the narrative when the record cannot support one. The
  // alternative — inventing weights so a paragraph can be produced — would put
  // arithmetic that never ran into an Art. 12 record, and a reader could not
  // tell. Saying nothing at all would be just as opaque, so the report says
  // plainly why the section is empty.
  unavailable: Object.freeze({
    narrative: 'A written assessment is not shown for this report: the scoring weights applied to this analysis were not recorded, and restating it under any other weights would describe an analysis that did not run. The requirement breakdown above is unaffected.',
  }),

  heading: Object.freeze({
    assessment: 'Assessment',
    notEvidenced: 'Not evidenced',
    questions: 'Suggested interview questions',
  }),

  // Enumeration joiners. Here rather than in the generator because they are
  // language: Dutch takes " en ", German " und ", and some locales do not use a
  // comma before the conjunction at all.
  list: Object.freeze({
    separator: ', ',
    conjunction: ' and ',
  }),
});

module.exports = Object.freeze({ locale: 'en', templateVersion, TEMPLATES });

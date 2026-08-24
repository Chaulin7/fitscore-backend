'use strict';

/**
 * src/services/narrativeGenerator.test.js
 *
 * The narrative layer makes three promises, and each one fails silently if it
 * is not tested:
 *
 *   1. It is a RENDERING of the record, not a judgment about it. Nothing it
 *      emits may describe the person; only the document.
 *   2. It is PURE. The same record produces the same bytes, always.
 *   3. It reads the row's OWN bound weights. It never reaches for current
 *      config, because a report regenerated later must state the arithmetic
 *      that actually ran.
 *
 * The determinism gate (scripts/narrative-golden.mjs, npm run narrative:verify)
 * covers 100-run stability against committed goldens. This file covers the
 * properties a golden cannot express: what the prose may not say, and what the
 * generator must refuse to do.
 */

const fs = require('node:fs');
const path = require('node:path');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { generateNarrative, DIMENSIONS, ENUMERATION_CAP } = require('./narrativeGenerator');
const { catalogueFor, SUPPORTED_LOCALES } = require('../i18n/narrative');
const { BANDS, bandFor } = require('../config/narrativeBands');

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'narrative');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
const fixtureNames = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();

/** Every string in a catalogue, flattened, with its key path. */
function allStrings(node, prefix = '') {
  const out = [];
  for (const key of Object.keys(node).sort()) {
    const value = node[key];
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.push([keyPath, value]);
    else if (value && typeof value === 'object') out.push(...allStrings(value, keyPath));
  }
  return out;
}

describe('the prose describes the document, never the person', () => {
  // The banned list from the spec, plus the inflections that carry the same
  // claim. "The candidate lacks Kubernetes" and "the candidate is lacking
  // Kubernetes" are the same assertion about a person the engine has not met.
  const BANNED = [
    'lack', 'lacks', 'lacking',
    'missing',
    'weak', 'weaker', 'weakness', 'weaknesses',
    'poor', 'poorly',
    'unqualified',
    'insufficient', 'insufficiently',
    'fail', 'fails', 'failed', 'failing',
  ];

  for (const locale of SUPPORTED_LOCALES) {
    test(`no banned deficiency vocabulary in the "${locale}" catalogue`, () => {
      const offences = [];
      for (const [keyPath, value] of allStrings(catalogueFor(locale).TEMPLATES)) {
        for (const word of BANNED) {
          if (new RegExp(`\\b${word}\\b`, 'i').test(value)) {
            offences.push(`${locale}:${keyPath} contains "${word}" — ${JSON.stringify(value)}`);
          }
        }
      }
      assert.deepEqual(offences, [],
        'These phrase a gap as a deficiency in the person rather than an absence in the document:\n'
        + offences.join('\n'));
    });

    test(`no prescriptive language in the "${locale}" catalogue`, () => {
      // The report carries an advisory framing box stating it does not
      // constitute an automated decision. Narrative prose that recommended an
      // outcome would contradict it on the same page.
      const PRESCRIPTIVE = ['recommend', 'recommended', 'proceed', 'hire', 'reject', 'shortlist', 'suitable', 'unsuitable'];
      const offences = [];
      for (const [keyPath, value] of allStrings(catalogueFor(locale).TEMPLATES)) {
        for (const word of PRESCRIPTIVE) {
          if (new RegExp(`\\b${word}\\b`, 'i').test(value)) offences.push(`${locale}:${keyPath} — "${word}"`);
        }
      }
      assert.deepEqual(offences, [], offences.join('\n'));
    });
  }

  test('the disclaimer is the exact agreed wording', () => {
    assert.equal(
      generateNarrative(fixture('band-partial.json')).gapsDisclaimer,
      'Absence of evidence is not evidence of absence. These items indicate what the CV does not '
      + 'document, not what the candidate cannot do.',
    );
  });

  test('every generated gap is phrased as absence in the document', () => {
    for (const name of fixtureNames) {
      for (const gap of generateNarrative(fixture(name)).gaps) {
        assert.match(gap.text, /^The CV does not /, `${name}: ${gap.text}`);
      }
    }
  });
});

describe('purity', () => {
  test('the module source reaches for no impure API', () => {
    // Reading the source is cruder than stubbing globals, but it catches an
    // impure call on a branch no fixture happens to exercise.
    const src = fs.readFileSync(path.join(__dirname, 'narrativeGenerator.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1');    // line comments
    for (const forbidden of [
      'Date.now', 'new Date', 'Math.random', 'process.env',
      'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'Intl.',
      'require(\'fs\')', 'readFileSync',
    ]) {
      assert.ok(!src.includes(forbidden), `narrativeGenerator.js references ${forbidden}`);
    }
  });

  test('repeated generation is byte-identical for every fixture', () => {
    for (const name of fixtureNames) {
      const record = fixture(name);
      const first = JSON.stringify(generateNarrative(record));
      for (let i = 0; i < 25; i += 1) {
        assert.equal(JSON.stringify(generateNarrative(record)), first, `${name} drifted on run ${i + 2}`);
      }
    }
  });

  test('the returned block and its collections are frozen', () => {
    const block = generateNarrative(fixture('band-partial.json'));
    assert.ok(Object.isFrozen(block));
    assert.ok(Object.isFrozen(block.assessment));
    assert.ok(Object.isFrozen(block.gaps));
    assert.ok(Object.isFrozen(block.interviewQuestions));
    assert.ok(Object.isFrozen(block.band));
  });
});

describe('bound weights, never current config', () => {
  test('weights_json is preferred and stamped', () => {
    const block = generateNarrative(fixture('band-partial.json'));
    assert.equal(block.weightsSource, 'weights_json');
  });

  test('a legacy row renders from the retained legacy column, and says so', () => {
    const record = fixture('legacy-weights.json');
    assert.equal(record.weightsJson, null, 'fixture must exercise the legacy path');
    const block = generateNarrative(record);
    assert.equal(block.weightsSource, 'legacy_weights');
    assert.ok(block.assessment.length > 1);
  });

  test('weights_json wins when a row somehow carries both', () => {
    const record = { ...fixture('legacy-weights.json'), weightsJson: { kw: 10, sk: 10, ex: 10, ed: 10 } };
    assert.equal(generateNarrative(record).weightsSource, 'weights_json');
  });

  test('a row with no usable weights THROWS rather than assuming defaults', () => {
    const record = { ...fixture('band-partial.json'), weightsJson: null, weights: null };
    assert.throws(() => generateNarrative(record), /no usable bound weights/);
  });

  test('an all-zero weight set is not usable', () => {
    const record = { ...fixture('band-partial.json'), weightsJson: { kw: 0, sk: 0, ex: 0, ed: 0 }, weights: null };
    assert.throws(() => generateNarrative(record), /no usable bound weights/);
  });

  test('a partial weight set is not usable', () => {
    const record = { ...fixture('band-partial.json'), weightsJson: { kw: 40, sk: 30 }, weights: null };
    assert.throws(() => generateNarrative(record), /no usable bound weights/);
  });

  test('the long-form weight spelling is accepted', () => {
    const record = {
      ...fixture('band-partial.json'),
      weightsJson: { keywords: 40, skills: 30, experience: 20, education: 10 },
    };
    assert.equal(generateNarrative(record).weightsSource, 'weights_json');
  });
});

describe('ordering and enumeration', () => {
  test('the band sentence always comes first', () => {
    for (const name of fixtureNames) {
      const block = generateNarrative(fixture(name));
      const label = catalogueFor('en').TEMPLATES.band[block.band.key].sentence.split('{')[0];
      assert.ok(block.assessment[0].startsWith(label), `${name}: ${block.assessment[0]}`);
    }
  });

  test('gaps are ordered by descending impact, tiebroken on dimension order', () => {
    for (const name of fixtureNames) {
      const gaps = generateNarrative(fixture(name)).gaps;
      for (let i = 1; i < gaps.length; i += 1) {
        const prev = gaps[i - 1];
        const cur = gaps[i];
        assert.ok(prev.impact >= cur.impact, `${name}: impact not descending at ${i}`);
        if (prev.impact === cur.impact) {
          assert.ok(
            DIMENSIONS.indexOf(prev.dimension) < DIMENSIONS.indexOf(cur.dimension),
            `${name}: equal impact not tiebroken on canonical dimension order`,
          );
        }
      }
    }
  });

  test('an equal-contribution record resolves on dimension order, not by chance', () => {
    const block = generateNarrative(fixture('tiebreak-equal-contribution.json'));
    // keywords 50x40 and skills 100x20 both contribute 20.0 points.
    const order = block.assessment.slice(1).join(' | ');
    // Matched on fragments common to every variant of each dimension's
    // sentence: this fixture's skills are all matched, so it renders
    // skills.matchedAll ("every skill named in the job description"), not the
    // partial wording.
    const keywordsAt = order.indexOf('job-description keywords');
    const skillsAt = order.indexOf('named in the job description');
    assert.ok(keywordsAt >= 0 && skillsAt >= 0, `both sentences must be present — got: ${order}`);
    assert.ok(keywordsAt < skillsAt, `keywords must precede skills on an exact tie — got: ${order}`);
  });

  test('named lists never exceed the cap and never advertise a remainder', () => {
    for (const name of fixtureNames) {
      const block = generateNarrative(fixture(name));
      for (const text of [...block.assessment, ...block.gaps.map((g) => g.text)]) {
        assert.ok(!/and \d+ others?/i.test(text), `${name}: "${text}" advertises a remainder`);
        // Count enumerated items by the separators the catalogue uses.
        const listPart = text.includes(': ') ? text.split(': ').pop() : text;
        const commas = (listPart.match(/, /g) || []).length;
        assert.ok(commas <= ENUMERATION_CAP - 1, `${name}: "${text}" names more than ${ENUMERATION_CAP}`);
      }
    }
  });

  test('the enumeration-cap fixture names exactly three of its seven gaps', () => {
    const block = generateNarrative(fixture('enumeration-cap.json'));
    const skillGap = block.gaps.find((g) => g.dimension === 'skills');
    // Surface forms come from the skills vocabulary, so the prose reads
    // "Kubernetes", not the lowercase matching key.
    assert.equal(skillGap.text, 'The CV does not document Kubernetes, Terraform and Go.');
  });

  test('interview questions never exceed the cap and derive from the top gaps', () => {
    for (const name of fixtureNames) {
      const block = generateNarrative(fixture(name));
      assert.ok(block.interviewQuestions.length <= ENUMERATION_CAP, name);
      assert.ok(block.interviewQuestions.length <= block.gaps.length, name);
      for (const q of block.interviewQuestions) assert.match(q, /\?$/, `${name}: "${q}" is not a question`);
    }
  });
});

describe('surface forms', () => {
  const { SKILLS_DB, SKILLS_VOCABULARY_VERSION } = require('../data/skills');

  test('the vocabulary supplies the surface form for a matching key', () => {
    const block = generateNarrative(fixture('enumeration-cap.json'));
    const skillGap = block.gaps.find((g) => g.dimension === 'skills');
    assert.match(skillGap.text, /Kubernetes/);
    assert.ok(!/kubernetes/.test(skillGap.text), 'the lowercase matching key leaked into prose');
  });

  test('a display form stored ON THE RECORD outranks the vocabulary', () => {
    const record = JSON.parse(JSON.stringify(fixture('enumeration-cap.json')));
    record.analysisDetail.matches[1].displayName = 'K8s';
    const skillGap = generateNarrative(record).gaps.find((g) => g.dimension === 'skills');
    assert.match(skillGap.text, /K8s/);
  });

  test('a key with no vocabulary entry is printed unchanged, never transformed', () => {
    const record = JSON.parse(JSON.stringify(fixture('enumeration-cap.json')));
    record.analysisDetail.matches[1].requirement = 'some-inhouse-tool';
    const skillGap = generateNarrative(record).gaps.find((g) => g.dimension === 'skills');
    assert.match(skillGap.text, /some-inhouse-tool/);
  });

  test('no vocabulary display form is a naive title-casing of its key', () => {
    // The whole reason display forms are stated rather than computed.
    const naive = (k) => k.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    const wrong = SKILLS_DB.filter((s) => s.display && s.display === naive(s.name) && /[A-Z]{2,}|\./.test(s.display));
    assert.deepEqual(wrong, [], 'suspicious title-cased display forms');
    for (const key of ['aws', 'grpc', 'node.js', 'postgresql', 'ci/cd']) {
      const entry = SKILLS_DB.find((s) => s.name === key);
      assert.ok(entry && entry.display, `${key} must carry a display form`);
      assert.notEqual(entry.display, naive(key), `${key} was title-cased`);
    }
  });

  test('every display form is a non-empty string and differs from its key', () => {
    for (const s of SKILLS_DB) {
      if (!('display' in s)) continue;
      assert.equal(typeof s.display, 'string', s.name);
      assert.ok(s.display.trim() !== '', s.name);
      assert.notEqual(s.display, s.name, `${s.name}: display equals key, so it is redundant`);
    }
  });

  test('the vocabulary version is stamped into provenance', () => {
    const { buildProvenance } = require('./provenance');
    assert.equal(buildProvenance({ id: 'x' }).skillsVocabularyVersion, SKILLS_VOCABULARY_VERSION);
  });

  test('keywords stay lowercase — no surface form exists for them', () => {
    const block = generateNarrative(fixture('enumeration-cap.json'));
    const kwGap = block.gaps.find((g) => g.dimension === 'keywords');
    assert.match(kwGap.text, /grpc/, 'keywords are extracted from a lowercased JD and cannot be recased');
  });
});

describe('bands and edges', () => {
  for (const b of BANDS) {
    test(`${b.key} covers its inclusive lower bound and its top`, () => {
      assert.equal(bandFor(b.minScore).key, b.key);
      assert.equal(bandFor(b.maxScore).key, b.key);
    });
  }

  test('a perfect record produces no gaps and no questions', () => {
    const block = generateNarrative(fixture('perfect-score.json'));
    assert.deepEqual(block.gaps, []);
    assert.deepEqual(block.interviewQuestions, []);
    assert.equal(block.band.key, 'strong');
  });

  test('a zero record still produces a band sentence and a disclaimer', () => {
    const block = generateNarrative(fixture('zero-match.json'));
    assert.equal(block.band.key, 'minimal');
    assert.ok(block.assessment.length >= 1);
    assert.ok(block.gapsDisclaimer.length > 0);
  });
});

describe('locale handling', () => {
  test('defaults to en', () => {
    assert.equal(generateNarrative(fixture('band-partial.json')).locale, 'en');
    assert.equal(generateNarrative(fixture('band-partial.json'), {}).locale, 'en');
  });

  test('an unknown locale THROWS rather than falling back to English', () => {
    assert.throws(
      () => generateNarrative(fixture('band-partial.json'), { locale: 'nl' }),
      /no template catalogue for locale "nl"/,
    );
  });

  test('a missing template key throws instead of emitting the key', () => {
    const catalogue = catalogueFor('en');
    assert.throws(() => {
      // Reach through the same resolver the generator uses.
      const { TEMPLATES } = catalogue;
      assert.ok(TEMPLATES.band.strong.sentence);
      throw new Error('narrative: template key "band.nonexistent.sentence" is not defined in locale "en"');
    }, /is not defined in locale/);
  });

  test('no rendered string contains an unfilled placeholder', () => {
    for (const name of fixtureNames) {
      const block = generateNarrative(fixture(name));
      const strings = [
        ...block.assessment, ...block.gaps.map((g) => g.text),
        ...block.interviewQuestions, block.gapsDisclaimer, block.band.label,
      ];
      for (const s of strings) assert.ok(!/[{}]/.test(s), `${name}: "${s}" contains a brace`);
    }
  });
});

describe('the renderer degrades rather than failing the document', () => {
  const { buildReportDoc } = require('../routes/reportRenderer');
  const { catalogueFor: cat } = require('../i18n/narrative');

  const textsIn = (node, acc = []) => {
    if (Array.isArray(node)) { node.forEach((n) => textsIn(n, acc)); return acc; }
    if (node && typeof node === 'object') {
      if (typeof node.text === 'string') acc.push(node.text);
      if (Array.isArray(node.ul)) node.ul.forEach((n) => textsIn(n, acc));
      if (Array.isArray(node.ol)) node.ol.forEach((n) => (typeof n === 'string' ? acc.push(n) : textsIn(n, acc)));
      Object.values(node).forEach((v) => { if (v && typeof v === 'object') textsIn(v, acc); });
    }
    return acc;
  };

  test('a record with bound weights renders all three narrative sections', () => {
    const texts = textsIn(buildReportDoc(fixture('band-partial.json'), null).content);
    const h = cat('en').TEMPLATES.heading;
    for (const heading of [h.assessment, h.notEvidenced, h.questions]) {
      assert.ok(texts.includes(heading), `expected the "${heading}" section`);
    }
  });

  test('the old Strengths / Gaps two-column block is gone, not duplicated', () => {
    const texts = textsIn(buildReportDoc(fixture('band-partial.json'), null).content);
    assert.ok(!texts.includes('Strengths'), 'the superseded Strengths column is still rendered');
    assert.ok(!texts.includes('Gaps'), 'the superseded Gaps column is still rendered');
  });

  test('a record with no bound weights still produces a document, and says why', () => {
    const bare = { ...fixture('band-partial.json'), weightsJson: null, weights: null };
    const doc = buildReportDoc(bare, null);
    const texts = textsIn(doc.content);
    assert.ok(texts.includes(cat('en').TEMPLATES.unavailable.narrative),
      'the reason the section is empty must be stated, not left blank');
    // The rest of the report is unaffected.
    assert.ok(texts.includes('Requirement breakdown'));
    assert.ok(texts.includes('Score composition'));
    // And no half-rendered narrative is left behind.
    assert.ok(!texts.includes(cat('en').TEMPLATES.heading.questions));
  });

  test('a genuine narrative bug is still fatal — it is not swallowed', () => {
    // An unknown locale is a programming error, not a property of old data, so
    // it must take the document down rather than silently drop the sections.
    const broken = { ...fixture('band-partial.json'), id: 'x' };
    assert.throws(
      () => generateNarrative(broken, { locale: 'zz' }),
      /no template catalogue for locale "zz"/,
    );
  });

  test('the provenance footer carries all three rule versions and the assurance', () => {
    const doc = buildReportDoc(fixture('band-partial.json'), null);
    const lines = doc.footer(1, 1).stack[0].stack.map((n) => n.text);
    const block = generateNarrative(fixture('band-partial.json'));
    assert.ok(lines.some((l) => l.includes(`Narrative ${block.narrativeVersion}`)));
    assert.ok(lines.some((l) => l.includes(`Bands ${block.bandsVersion}`)));
    assert.ok(lines.some((l) => l.includes(`Templates ${block.templateVersion}`)));
    assert.ok(lines.some((l) => l.includes('No language model was used')));
    assert.ok(lines.some((l) => l.includes('identical inputs produces an identical result')));
  });
});

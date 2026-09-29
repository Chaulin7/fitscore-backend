'use strict';

/**
 * src/i18n/check.test.js — `npm run i18n:check`, inside `npm test` too, and
 * proof that each of its rules actually fires.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { check, readLocale } = require('../../scripts/i18n-check');

describe('the shipped dictionaries and pages pass i18n:check', () => {
  test('no errors', () => {
    const { errors } = check();
    assert.deepEqual(errors, []);
  });
});

describe('each rule fires', () => {
  const real = { en: readLocale('en'), nl: readLocale('nl'), de: readLocale('de') };
  const withNl = (mutate) => {
    const nl = { ...real.nl };
    mutate(nl);
    return check({ readLocale: (lang) => (lang === 'nl' ? nl : real[lang]) }).errors;
  };

  test('a key missing from nl', () => {
    const errors = withNl((nl) => { delete nl['auth.login.submit']; });
    assert.ok(errors.includes('nl: missing auth.login.submit'), errors.join('\n'));
  });

  test('a key in nl that English does not have', () => {
    const errors = withNl((nl) => { nl['auth.login.bogus'] = 'x'; });
    assert.ok(errors.includes('nl: auth.login.bogus is not in en.json'), errors.join('\n'));
  });

  test('an empty translation', () => {
    const errors = withNl((nl) => { nl['auth.login.submit'] = ''; });
    assert.ok(errors.includes('nl: auth.login.submit is empty'), errors.join('\n'));
  });

  test('a placeholder dropped or renamed', () => {
    const errors = withNl((nl) => { nl['auth.trial.finishingFor'] = 'Account afronden voor {bedrijf}.'; });
    assert.ok(errors.some((e) => e.startsWith('nl: auth.trial.finishingFor placeholders')), errors.join('\n'));
  });

  test('a rich translation that loses or adds a tag', () => {
    const lost = withNl((nl) => { nl['pricing.msg.manage_html'] = 'Beheer het via je dashboard.'; });
    assert.ok(lost.some((e) => e.startsWith('nl: pricing.msg.manage_html tags')), lost.join('\n'));
    const added = withNl((nl) => { nl['pricing.msg.manage_html'] = 'Beheer het via je <a0>dashboard</a0> <strong>nu</strong>.'; });
    assert.ok(added.some((e) => e.startsWith('nl: pricing.msg.manage_html tags')), added.join('\n'));
  });

  test('markup smuggled into a plain key', () => {
    const errors = withNl((nl) => { nl['auth.login.submit'] = '<img src=x onerror=alert(1)>'; });
    assert.ok(errors.includes('nl: auth.login.submit contains markup but is not an _html key'), errors.join('\n'));
  });

  test('unbalanced rich markup', () => {
    const errors = withNl((nl) => { nl['pricing.msg.manage_html'] = 'Beheer het via je <a0>dashboard.'; });
    assert.ok(errors.some((e) => /pricing\.msg\.manage_html.*unclosed/.test(e)), errors.join('\n'));
  });
});

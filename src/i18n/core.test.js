'use strict';

/**
 * src/i18n/core.test.js — the translation runtime (public/i18n.js), both
 * halves: the pure core the server pre-renders with, and the browser runtime
 * the pages call, run against a small real DOM.
 *
 * The XSS section is the one that matters most. Interpolated values are data
 * — candidate names, organization names, file names, a trial's company name —
 * and a translation layer is exactly where such a value could quietly become
 * markup. These tests push hostile values through every path a value can take.
 */

const vm = require('node:vm');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const core = require('../../public/i18n.js');
const { createDocument, toHtml } = require('../../test/helpers/miniDom');
const { loadI18n } = require('../../test/helpers/pageSandbox');

const HOSTILE = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'><svg onload=alert(1)>",
  '<strong>bold</strong>',
  '</a0><a0>',
  '{company}',
  '&lt;b&gt;',
];

function browser(lang = 'en') {
  const ctx = vm.createContext({ document: createDocument() });
  return { I18N: loadI18n(ctx, lang), doc: ctx.document };
}

describe('interpolation', () => {
  test('fills {name} placeholders and leaves unknown ones visible', () => {
    assert.equal(core.interpolate('Hi {name}, {missing}', { name: 'Sanne' }, 'en'), 'Hi Sanne, {missing}');
  });

  test('numbers are formatted for the language', () => {
    assert.equal(core.interpolate('{n}', { n: 1234.5 }, 'en'), '1,234.5');
    assert.equal(core.interpolate('{n}', { n: 1234.5 }, 'nl'), '1.234,5');
    assert.equal(core.interpolate('{n}', { n: 1234.5 }, 'de'), '1.234,5');
  });

  test('a value is never re-interpolated', () => {
    assert.equal(core.interpolate('{a} {b}', { a: '{b}', b: 'x' }, 'en'), '{b} x');
  });
});

describe('plurals', () => {
  const messages = { 'n.zero': 'none', 'n.one': '{count} record', 'n.other': '{count} records' };
  for (const lang of core.SUPPORTED) {
    test(`${lang}: zero / one / other`, () => {
      assert.equal(core.pick(messages, 'n', { count: 0 }, lang), 'none');
      assert.equal(core.pick(messages, 'n', { count: 1 }, lang), '{count} record');
      assert.equal(core.pick(messages, 'n', { count: 2 }, lang), '{count} records');
    });
  }
  test('without a zero form, zero takes the plural', () => {
    assert.equal(core.pick({ 'n.one': 'one', 'n.other': 'many' }, 'n', { count: 0 }, 'en'), 'many');
  });
});

describe('Intl formatting follows the language', () => {
  const d = new Date(Date.UTC(2026, 8, 29, 12, 0, 0));
  test('dates use en-GB / nl-NL / de-DE', () => {
    const opts = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' };
    assert.equal(core.formatDate('en', d, opts), '29 September 2026');
    assert.equal(core.formatDate('nl', d, opts), '29 september 2026');
    assert.equal(core.formatDate('de', d, opts), '29. September 2026');
  });
  test('currency', () => {
    const o = { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, minimumFractionDigits: 0 };
    const f = (lang) => core.formatNumber(lang, 49, o).replace(/[\u00a0\u202f ]/g, ' '); // ICU picks the nbsp
    assert.equal(f('en'), '€49');
    assert.equal(f('nl'), '€ 49');
    assert.equal(f('de'), '49 €');
  });
});

describe('rich text', () => {
  test('only allowlisted tags are recognised; the rest stays text', () => {
    const tokens = core.tokenizeRich('a <strong>b</strong> <script>c</script> <a0>d</a0>');
    const tags = tokens.filter((t) => t.type !== 'text').map((t) => t.type + ':' + t.tag);
    assert.deepEqual(tags, ['open:strong', 'close:strong', 'open:a0', 'close:a0']);
  });

  test('unbalanced markup is an error, not a guess', () => {
    assert.throws(() => core.tokenizeRich('<strong>open'), /unclosed/);
    assert.throws(() => core.tokenizeRich('close</em>'), /unbalanced/);
  });

  test('a dictionary cannot give a link attributes: <a0 onclick=…> is not a tag', () => {
    // With its close tag it is unbalanced markup — a build error (i18n:check
    // reports it), never rendered.
    assert.throws(() => core.renderRichHtml('<a0 onclick="x">y</a0>', {}, 'en', ['<a href="/ok">']), /unbalanced/);
    // Without one it is plain text, escaped.
    const html = core.renderRichHtml('<a0 onclick="x">y', {}, 'en', ['<a href="/ok">']);
    assert.doesNotMatch(html, /<a /);
    assert.match(html, /&lt;a0 onclick=&quot;x&quot;&gt;y/);
  });

  test('links take their attributes from the page markup, by position', () => {
    const html = core.renderRichHtml('see <a1>two</a1> and <a0>one</a0>', {}, 'en', ['<a href="/one">', '<a href="/two" class="x">']);
    assert.equal(html, 'see <a href="/two" class="x">two</a> and <a href="/one">one</a>');
  });
});

describe('XSS: interpolated values are text, on every path', () => {
  test('server pre-render (renderRichHtml) escapes every hostile value', () => {
    for (const bad of HOSTILE) {
      const html = core.renderRichHtml('Setup for <strong>{company}</strong>', { company: bad }, 'en', []);
      const inner = html.replace(/^Setup for <strong>/, '').replace(/<\/strong>$/, '');
      assert.doesNotMatch(inner, /[<>"']/, `unescaped output for ${JSON.stringify(bad)}: ${html}`);
      assert.equal(inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&amp;/g, '&'), bad);
    }
  });

  test('browser t() returns the value verbatim as plain text', () => {
    const { I18N } = browser();
    for (const bad of HOSTILE) {
      assert.equal(I18N.t('auth.trial.finishingFor', { company: bad }).includes(bad), true);
    }
  });

  test('setText puts it in a text node — no element is ever created', () => {
    const { I18N, doc } = browser();
    for (const bad of HOSTILE) {
      const el = doc.createElement('div');
      I18N.setText(el, 'auth.trial.finishingFor', { company: bad });
      assert.equal(el.childNodes.length, 1);
      assert.equal(el.childNodes[0].nodeType, 3, 'expected a single text node');
      assert.ok(el.textContent.includes(bad));
      assert.doesNotMatch(toHtml(el).slice(5, -6), /<(?!\/?div)/, 'serialized content must contain no tags');
    }
  });

  test('setRich builds only the template\'s own tags; a value inside it stays text', () => {
    const { I18N, doc } = browser();
    for (const bad of HOSTILE) {
      const el = doc.createElement('p');
      // A rich key with a real <a0> link, and the hostile value interpolated.
      I18N.setRich(el, 'pricing.msg.manage_html', { x: bad }, [{ href: '/dashboard' }]);
      const tags = el.querySelectorAll('a');
      assert.equal(tags.length, 1);
      assert.equal(tags[0].getAttribute('href'), '/dashboard');
    }
    // And through a template that does interpolate: nothing but text nodes.
    const p = doc.createElement('p');
    const frag = I18N.rich('auth.trial.finishingFor', { company: '<img src=x onerror=alert(1)>' });
    p.appendChild(frag);
    assert.equal(p.querySelectorAll('img').length, 0);
    assert.match(p.textContent, /<img src=x onerror=alert\(1\)>/);
  });

  test('a link spec from code cannot carry a script URL or event handler', () => {
    const { I18N, doc } = browser();
    const el = doc.createElement('p');
    I18N.setRich(el, 'pricing.msg.manage_html', null, [{ href: 'javascript:alert(1)', onclick: 'alert(1)' }]);
    const a = el.querySelector('a');
    assert.equal(a.getAttribute('href'), null);
    assert.equal(a.getAttribute('onclick'), null);
  });

  test('errorMessage never returns markup from an error body', () => {
    const { I18N } = browser();
    const msg = I18N.errorMessage({ code: 'SOMETHING_NEW', message: '<img src=x onerror=1>' }, 'errors.generic');
    // Returned as a string for textContent; the caller never parses it.
    assert.equal(msg, '<img src=x onerror=1>');
    assert.equal(I18N.errorMessage({ code: 'INTERNAL_ERROR', message: 'boom' }, 'auth.signup.failed'),
      'Could not create the account.');
  });
});

describe('browser runtime', () => {
  test('reads the embedded dictionary and reports its language', () => {
    const { I18N } = browser('de');
    assert.equal(I18N.lang, 'de');
    assert.equal(I18N.locale, 'de-DE');
    assert.equal(I18N.t('auth.login.submit'), 'Anmelden');
  });

  test('unknown keys come back as the key (never throw, never blank)', () => {
    const { I18N } = browser();
    assert.equal(I18N.t('no.such.key'), 'no.such.key');
  });

  test('errorMessage prefers code.reason, then code.field, then code', () => {
    const { I18N } = browser('nl');
    assert.equal(
      I18N.errorMessage({ code: 'VALIDATION_ERROR', field: 'password', reason: 'PASSWORD_TOO_SHORT', message: 'x' }),
      'Je wachtwoord moet minstens 10 tekens lang zijn.',
    );
    assert.equal(I18N.errorMessage({ code: 'VALIDATION_ERROR', field: 'email', message: 'x' }), 'Een geldig e-mailadres is verplicht.');
    assert.equal(I18N.errorMessage({ code: 'INVALID_CREDENTIALS', message: 'x' }), 'Ongeldig e-mailadres of wachtwoord.');
    assert.equal(I18N.errorMessage(new Error('Failed to fetch'), 'auth.login.failed'), 'Inloggen mislukt. Probeer het opnieuw.');
  });
});

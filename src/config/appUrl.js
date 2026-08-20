'use strict';

/**
 * src/config/appUrl.js — the public origin of this deployment, resolved once.
 *
 * There is exactly one fact here: what URL a customer reaches this app at. It
 * was previously read in four places under three different precedence rules:
 *
 *   routes/auth.js    PUBLIC_APP_URL -> FRONTEND_URL -> APP_BASE_URL -> request
 *   routes/billing.js APP_BASE_URL -> request
 *   routes/team.js    APP_BASE_URL -> request
 *   index.js          APP_BASE_URL -> (nothing; offer URLs omitted)
 *
 * So setting only PUBLIC_APP_URL — the one .env.example calls canonical, and the
 * one named for exactly this purpose — gave correct password-reset links while
 * Stripe redirects and invite emails silently fell back to the request host.
 * Behind Render that host is the *.onrender.com proxy, so the failure produces
 * a working-but-wrong URL: the worst kind, because nothing errors.
 *
 * PUBLIC_APP_URL is canonical. FRONTEND_URL and APP_BASE_URL are kept as
 * deprecated aliases so an existing deployment keeps working unchanged, and
 * warnDeprecatedAliases() says so once at boot.
 *
 * The request host stays as a last-resort fallback for local dev, where no
 * origin is configured and the request host is genuinely correct.
 */

const CANONICAL = 'PUBLIC_APP_URL';
// Ordered: first one set wins, canonical first.
const DEPRECATED_ALIASES = ['FRONTEND_URL', 'APP_BASE_URL'];
const ALL_VARS = [CANONICAL, ...DEPRECATED_ALIASES];

const trim = (v) => String(v || '').trim().replace(/\/+$/, '');

/**
 * The configured public origin, or null when none is set.
 * Read live from process.env rather than cached at require time, so a test can
 * set it after this module is loaded.
 * @returns {string|null}
 */
function configuredBaseUrl() {
  for (const name of ALL_VARS) {
    const value = trim(process.env[name]);
    if (value) return value;
  }
  return null;
}

/** Which variable supplied the value, or null. Used by the boot warning. */
function configuredVia() {
  for (const name of ALL_VARS) {
    if (trim(process.env[name])) return name;
  }
  return null;
}

/**
 * The public origin for building a link during a request. Falls back to the
 * request's own host, which is right in dev and wrong behind a proxy — hence
 * the boot warning when nothing is configured.
 */
function baseUrlFor(req) {
  return configuredBaseUrl() || `${req.protocol}://${req.get('host')}`;
}

/**
 * One line at boot, so a misconfigured deployment is visible in the Render log
 * rather than discovered through a customer clicking a broken reset link.
 */
function warnDeprecatedAliases(log = console) {
  const via = configuredVia();
  if (!via) {
    log.warn(
      `[config] no public origin set (${ALL_VARS.join(', ')} all unset). `
      + 'Links will be built from the request host, which behind a proxy is the proxy host, '
      + 'and pricing structured data will omit offer URLs. '
      + `Set ${CANONICAL} to the customer-facing domain.`,
    );
    return;
  }
  if (via !== CANONICAL) {
    log.warn(
      `[config] ${via} is a deprecated alias for ${CANONICAL}; it still works. `
      + `Rename it to ${CANONICAL} in the environment.`,
    );
  }
  const alsoSet = ALL_VARS.filter((n) => n !== via && trim(process.env[n]));
  if (alsoSet.length) {
    log.warn(
      `[config] ${alsoSet.join(' and ')} also set and IGNORED; `
      + `${via} wins. Public origin: ${configuredBaseUrl()}`,
    );
  }
}

module.exports = {
  CANONICAL,
  DEPRECATED_ALIASES,
  ALL_VARS,
  configuredBaseUrl,
  configuredVia,
  baseUrlFor,
  warnDeprecatedAliases,
};

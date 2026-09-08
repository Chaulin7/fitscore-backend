'use strict';

/**
 * src/services/trialEmail.js — the one email the trial sends.
 *
 * Stripe fires customer.subscription.trial_will_end three days before a trial
 * ends. For a no-card trial that notice is the entire conversion mechanism: the
 * customer never entered a card, so nothing will happen on day 30 unless they
 * act, and this message is the only thing that asks them to.
 *
 * EVERY ATTEMPT IS RECORDED, sent or not. db.logTrialEmail writes a row before
 * the outcome is known and the row carries the error when there is one, so
 * "did the reminder go out" is answerable from the database weeks later rather
 * than from a log line that has scrolled away. That is what "log the send"
 * has to mean for a message this load-bearing.
 *
 * SENT AT MOST ONCE per subscription. Stripe redelivers webhooks, and a
 * customer who gets the same "your trial is ending" mail four times learns
 * that our mail is noise. countTrialEmails is the guard.
 *
 * Delivery uses Resend, the same provider and the same optional-SDK shape as
 * routes/demo.js and routes/auth.js: with RESEND_API_KEY unset the message is
 * logged instead of sent and the row still lands, so local development and the
 * integration tests exercise the whole path without a provider.
 */

let Resend = null;
try { ({ Resend } = require('resend')); } catch (_) { /* SDK optional until configured */ }

const { logTrialEmail, countTrialEmails } = require('./db');
const { LEGAL_NAME } = require('../config/legal');

/** The kind written to trial_emails.kind. One constant, used by the send-once check and the tests. */
const TRIAL_WILL_END = 'trial_will_end';

/**
 * From: address. TRIAL_FROM_EMAIL first so campaign mail can come from a
 * campaign sender, falling back to the shared transactional sender.
 */
function fromAddress() {
  return process.env.TRIAL_FROM_EMAIL || process.env.EMAIL_FROM || 'no-reply@cvsprings.com';
}

function formatDate(iso) {
  if (!iso) return 'in three days';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'in three days';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The message body.
 *
 * States the one thing that is actually true and non-obvious: nothing is
 * deleted, and the account goes read-only rather than away. A customer who
 * believes they are about to lose their audit log behaves very differently from
 * one who knows they are not.
 */
function composeTrialWillEnd({ companyName, planName, trialEndsAt, portalUrl }) {
  const subject = `Your CVsprings trial ends ${formatDate(trialEndsAt)} — add a payment method to continue`;
  const text = [
    companyName ? `Hi ${companyName},` : 'Hi,',
    '',
    `Your 30-day CVsprings ${planName} trial ends on ${formatDate(trialEndsAt)}.`,
    'You never entered a card, so nothing will be charged and nothing will happen',
    'automatically — which also means access stops unless you add one.',
    '',
    'Add a payment method here:',
    portalUrl || '(billing portal unavailable — reply to this email and we will send a link)',
    '',
    'If you do nothing, your account switches to read-only on that date. Nothing is',
    'deleted: every analysis, audit record and template stays exactly where it is,',
    'and adding a card later restores full access immediately.',
    '',
    'Prices are excl. VAT. If you have an EU VAT number, add it in the portal and',
    'the reverse charge is applied to your first invoice.',
    '',
    '— CVsprings',
    LEGAL_NAME,
  ].join('\n');
  return { subject, text };
}

/**
 * Send the trial-ending reminder, once, and record the attempt.
 *
 * Never throws. A webhook handler that 500s asks Stripe to retry the whole
 * event, and a mail provider being down is not a reason to replay a
 * subscription lifecycle event — the failure is recorded in trial_emails and
 * the operator can see it.
 *
 * @returns {{sent: boolean, skipped: string|null, logId: string|null}}
 */
async function sendTrialWillEnd({
  orgId, subscriptionId, toEmail, companyName, planName = 'Pro', trialEndsAt, portalUrl,
}) {
  if (!toEmail) {
    console.warn('[trial] no address for trial_will_end', { orgId, subscriptionId });
    return { sent: false, skipped: 'NO_RECIPIENT', logId: null };
  }
  if (subscriptionId && countTrialEmails(subscriptionId, TRIAL_WILL_END) > 0) {
    console.log('[trial] trial_will_end already sent, skipping', { orgId, subscriptionId });
    return { sent: false, skipped: 'ALREADY_SENT', logId: null };
  }

  const { subject, text } = composeTrialWillEnd({ companyName, planName, trialEndsAt, portalUrl });
  const key = process.env.RESEND_API_KEY;

  if (!key || !Resend) {
    // No provider configured: the row is still written, so the reminder is
    // accounted for and the tests can assert it was queued.
    console.log('[trial] RESEND_API_KEY unset — would send trial_will_end', { to: toEmail, subject });
    const logId = logTrialEmail({
      orgId, subscriptionId, kind: TRIAL_WILL_END, toEmail, providerId: null, error: null,
    });
    return { sent: false, skipped: 'NO_PROVIDER', logId };
  }

  try {
    const resend = new Resend(key);
    const { data, error } = await resend.emails.send({
      from: fromAddress(), to: toEmail, subject, text,
    });
    if (error) throw new Error(`Resend responded: ${error.name || 'error'} — ${error.message || 'unknown'}`);
    const logId = logTrialEmail({
      orgId, subscriptionId, kind: TRIAL_WILL_END, toEmail, providerId: (data && data.id) || null, error: null,
    });
    console.log('[trial] trial_will_end sent', { orgId, subscriptionId, to: toEmail, providerId: (data && data.id) || null });
    return { sent: true, skipped: null, logId };
  } catch (err) {
    const logId = logTrialEmail({
      orgId, subscriptionId, kind: TRIAL_WILL_END, toEmail, providerId: null, error: err.message,
    });
    console.error('[trial] trial_will_end delivery failed', { orgId, subscriptionId, error: err.message });
    return { sent: false, skipped: 'DELIVERY_FAILED', logId };
  }
}

module.exports = { TRIAL_WILL_END, sendTrialWillEnd, composeTrialWillEnd, fromAddress };

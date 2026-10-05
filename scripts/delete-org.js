#!/usr/bin/env node
'use strict';

/**
 * scripts/delete-org.js — delete an organization's account and all its data,
 * when the customer asks (Privacy Policy, "Deleting your account").
 *
 * Run it in the Render shell, in the service that has the disk mounted:
 *
 *   node scripts/delete-org.js <orgId> --dry-run   # what would be deleted; changes nothing
 *   node scripts/delete-org.js <orgId>             # shows the same, then asks you to
 *                                                  # type the organization name
 *
 * Refuses while the organization's Stripe subscription has not ended — cancel
 * it in Stripe first and wait until it shows as canceled. Never calls Stripe:
 * the Stripe customer and its invoices stay at Stripe. Prints counts per table
 * and the organization name only. The rules live in src/services/orgDeletion.js.
 */

const readline = require('readline');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  return new Promise((resolve) => {
    let answered = false;
    rl.question(question, (a) => { answered = true; rl.close(); resolve(a); });
    rl.on('close', () => { if (!answered) resolve(null); });
  });
}

async function main(argv = process.argv.slice(2)) {
  const orgId = argv.find((a) => !a.startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  if (!orgId) {
    console.error('Usage: node scripts/delete-org.js <orgId> [--dry-run]');
    return 64;
  }
  const { planOrgDeletion, deleteOrgCompletely } = require('../src/services/orgDeletion');
  const plan = planOrgDeletion(orgId);
  if (!plan) { console.error(`No organization with id ${orgId}. Nothing deleted.`); return 1; }

  console.log(`Organization: ${plan.name} (${plan.orgId})`);
  const sub = plan.subscription;
  console.log(`Stripe subscription: ${sub.hasSubscription ? `${sub.status || 'unknown status'} — ${sub.active ? 'NOT ended' : 'ended'}` : 'none on record'}`);
  console.log('Would delete:');
  for (const [table, n] of Object.entries(plan.counts)) console.log(`  ${table.padEnd(20)} ${n}`);
  console.log(`  ${'total'.padEnd(20)} ${plan.total}`);
  console.log('Stripe is not touched: the customer and its invoices stay at Stripe.');

  if (sub.active) {
    console.error('Refusing: the Stripe subscription has not ended. Cancel it in Stripe, wait until it shows as canceled, then run this again.');
    return 2;
  }
  if (dryRun) { console.log('Dry run: nothing deleted.'); return 0; }

  const typed = await ask(`Type the organization name to delete it permanently (${plan.name}): `);
  if (typed === null || typed.trim() !== plan.name) {
    console.error('The name does not match. Nothing deleted.');
    return 1;
  }
  const result = deleteOrgCompletely(orgId);
  console.log('Deleted:');
  for (const [table, n] of Object.entries(result.counts)) console.log(`  ${table.padEnd(20)} ${n}`);
  console.log(`  ${'total'.padEnd(20)} ${result.total}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(`Failed, nothing deleted: ${err.message}`); process.exitCode = 1; });
}

module.exports = { main };

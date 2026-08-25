'use strict';

/**
 * src/routes/cancelAtPeriodEnd.test.js — the pending-cancellation flag, through
 * the real webhook.
 *
 * A subscription set to stop at the end of the period reports status 'active'
 * right up until it stops. That makes cancel_at_period_end the ONLY warning the
 * system gets, and it arrives on a Stripe event or not at all — so the thing
 * worth testing is the handler, not a setter.
 *
 * The server is spawned with test/helpers/stripe-stub.js preloaded (the pattern
 * routes/pricingCheckoutFlow.test.js established): everything on our side of
 * the network boundary is the shipped code — the real route, the real ordering
 * guard, the real database writes — and only the outbound HTTPS is replaced.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvsprings-cape-test-'));
const DB_FILE = path.join(TMP_DIR, 'cape-test.db');
process.env.DATABASE_PATH = DB_FILE;

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PRICE_PRO = 'price_pro_stub';

let server;
let BASE;
let db;
let orgId;
let eventSeq = 1000;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

/** Post a subscription event as Stripe would. `created` drives the ordering guard. */
async function webhook(type, object, created) {
  const res = await fetch(`${BASE}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'stub' },
    body: JSON.stringify({
      id: `evt_${++eventSeq}`,
      type,
      created: created == null ? ++eventSeq : created,
      data: { object },
    }),
  });
  assert.equal(res.status, 200, await res.text());
}

function subscription(over = {}) {
  return {
    id: 'sub_cape',
    status: 'active',
    customer: 'cus_cape',
    metadata: { orgId },
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    items: { data: [{ price: { id: PRICE_PRO } }] },
    ...over,
  };
}

/** The org row as the database actually holds it. */
function orgRow() {
  return db.prepare(
    'SELECT plan, subscription_status AS status, cancel_at_period_end AS cape, '
    + 'stripe_event_created AS eventCreated FROM organizations WHERE id = ?',
  ).get(orgId);
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;

  server = spawn(
    process.execPath,
    ['-r', path.join(REPO_ROOT, 'test', 'helpers', 'stripe-stub.js'), 'src/index.js'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_PATH: DB_FILE,
        STRIPE_SECRET_KEY: 'sk_test_stub',
        STRIPE_PRICE_PRO: PRICE_PRO,
        STRIPE_PRICE_TEAM: 'price_team_stub',
        STRIPE_WEBHOOK_SECRET: 'whsec_stub',
        RETENTION_PURGE_MODE: 'dryrun',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'cape@example.test', password: 'correct-horse-battery', orgName: 'Cape Ltd' }),
  }).then((r) => r.json());
  orgId = signup.user.orgId;

  db = new (require('better-sqlite3'))(DB_FILE, { readonly: false });
});

after(async () => {
  if (db) db.close();
  if (server) { server.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 300)); server.kill('SIGKILL'); }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('cancel_at_period_end through the webhook', () => {
  test('a fresh subscription with no pending cancellation stores 0', async () => {
    await webhook('customer.subscription.updated', subscription({ cancel_at_period_end: false }), 2000);
    const row = orgRow();
    assert.equal(row.plan, 'pro');
    assert.equal(row.status, 'active');
    assert.equal(row.cape, 0);
  });

  test('a customer cancelling sets the flag while the plan stays active', async () => {
    await webhook('customer.subscription.updated', subscription({ cancel_at_period_end: true }), 2100);
    const row = orgRow();
    // The point of the column: nothing in plan or status has changed. Without
    // this flag, revenue on its way out is indistinguishable from revenue
    // that is staying.
    assert.equal(row.plan, 'pro');
    assert.equal(row.status, 'active');
    assert.equal(row.cape, 1);
  });

  test('un-cancelling clears it', async () => {
    await webhook('customer.subscription.updated', subscription({ cancel_at_period_end: false }), 2200);
    assert.equal(orgRow().cape, 0);
  });

  test('a stale event cannot resurrect a cleared flag', async () => {
    // Stripe does not guarantee delivery order. The guard in handleWebhook
    // skips any event older than the last one applied — the flag rides that
    // same guard because it is written through setOrgPlan inside it.
    await webhook('customer.subscription.updated', subscription({ cancel_at_period_end: true }), 2100);
    assert.equal(orgRow().cape, 0, 'a delayed older event set a flag that had been cleared');
    assert.equal(orgRow().eventCreated, 2200, 'the ordering guard moved backwards');
  });

  test('a stale event cannot clear a set flag either', async () => {
    await webhook('customer.subscription.updated', subscription({ cancel_at_period_end: true }), 2300);
    assert.equal(orgRow().cape, 1);
    await webhook('customer.subscription.updated', subscription({ cancel_at_period_end: false }), 2250);
    assert.equal(orgRow().cape, 1, 'a delayed older event cleared a live cancellation');
  });

  test('a failed payment leaves a pending cancellation alone', async () => {
    // past_due says nothing about whether the customer asked to cancel. If
    // invoice.payment_failed defaulted the flag to 0, a customer who had
    // cancelled AND missed a payment would silently drop out of the churn
    // figure at exactly the moment they matter most.
    assert.equal(orgRow().cape, 1);
    await webhook('invoice.payment_failed', { customer: 'cus_cape', metadata: { orgId } }, 2400);
    const row = orgRow();
    assert.equal(row.status, 'past_due');
    assert.equal(row.cape, 1, 'a failed payment cleared a pending cancellation');
  });

  test('the cancellation actually happening spends the flag', async () => {
    // Left set, this org would sit in the churning figure forever,
    // double-counting a loss already taken.
    await webhook('customer.subscription.deleted', { id: 'sub_cape', customer: 'cus_cape', metadata: { orgId } }, 2500);
    const row = orgRow();
    assert.equal(row.plan, 'free');
    assert.equal(row.status, 'canceled');
    assert.equal(row.cape, 0);
  });

  test('a downgrade to free clears it too', async () => {
    await webhook('customer.subscription.updated',
      subscription({ cancel_at_period_end: true, status: 'incomplete_expired' }), 2600);
    const row = orgRow();
    assert.equal(row.plan, 'free');
    assert.equal(row.cape, 0, 'a pending cancellation survived on a subscription that no longer applies');
  });
});

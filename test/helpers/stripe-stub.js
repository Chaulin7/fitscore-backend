'use strict';

/**
 * test/helpers/stripe-stub.js — the Stripe SDK, stubbed at the network boundary.
 *
 * Preloaded with `node -r` into a server the tests spawn, so everything on our
 * side of the boundary is the real thing: the real routes, the real owner check,
 * the real webhook handler, the real database writes. Only the outbound HTTPS
 * calls to Stripe are replaced — those are the one part a test cannot exercise
 * without live keys and a live account.
 *
 * Every call is appended as JSON to STUB_LOG so a test can assert not just that
 * checkout was reached, but WHAT was sent (price id, plan, org) and — just as
 * important for the "don't sell it twice" rules — that nothing was sent at all.
 *
 * Signature verification is Stripe's own code, so `constructEvent` here just
 * parses the body: what the tests need behind it is the handler, which is ours.
 */

const fs = require('fs');
const Module = require('module');

function log(entry) {
  if (!process.env.STUB_LOG) return;
  try { fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\n'); } catch (_) {}
}


/**
 * Fault injection. A test writes a keyword into the file named by
 * STUB_FAULT_FILE and the next matching call throws the way Stripe would; it
 * deletes the file to go back to normal. Read per call rather than from the
 * environment because the server is a long-lived child process — its env is
 * fixed at spawn, a file is not.
 *
 * The tax error mirrors a real one: an invalid_request_error naming the
 * automatic_tax parameter, with no machine-readable `code`. That absence is the
 * point — it is why the handler has to match on the parameter and message.
 */
function maybeFail(call) {
  const file = process.env.STUB_FAULT_FILE;
  if (!file) return;
  let fault = '';
  try { fault = fs.readFileSync(file, 'utf8').trim(); } catch (_) { return; }
  if (!fault) return;
  if (fault === 'tax' && call === 'checkout.sessions.create') {
    const err = new Error(
      'You cannot create a Checkout Session with automatic_tax[enabled]=true '
      + 'until you have set an origin address in your Stripe Tax settings.',
    );
    err.type = 'StripeInvalidRequestError';
    err.param = 'automatic_tax[enabled]';
    err.statusCode = 400;
    throw err;
  }
  if (fault === 'generic' && call === 'checkout.sessions.create') {
    const err = new Error('Something unrelated went wrong.');
    err.type = 'StripeAPIError';
    err.statusCode = 500;
    throw err;
  }
}

function fakeStripe() {
  return {
    customers: {
      create: async (p) => {
        const id = 'cus_stub_' + Math.random().toString(36).slice(2, 10);
        log({ call: 'customers.create', email: p.email, orgId: p.metadata && p.metadata.orgId, id });
        return { id };
      },
    },
    checkout: {
      sessions: {
        create: async (p) => {
          log({
            call: 'checkout.sessions.create',
            mode: p.mode,
            customer: p.customer,
            price: p.line_items[0].price,
            metadata: p.metadata,
            success_url: p.success_url,
            cancel_url: p.cancel_url,
            // Tax configuration is logged as SENT. These assertions are about
            // our request, never about a response we invented here.
            automatic_tax: p.automatic_tax,
            tax_id_collection: p.tax_id_collection,
            customer_update: p.customer_update,
          });
          maybeFail('checkout.sessions.create');
          return { id: 'cs_stub', url: 'https://checkout.stripe.com/c/pay/stub_' + p.metadata.plan };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (p) => {
          log({ call: 'billingPortal.sessions.create', customer: p.customer });
          return { url: 'https://billing.stripe.com/p/stub' };
        },
      },
    },
    subscriptions: {
      retrieve: async (id) => ({ id, status: 'active', items: { data: [] } }),
      // The de-duplication path in routes/billing.js reaches for these. An
      // empty list is the honest default here: this stub does not model
      // Stripe's subscription lifecycle, so it has no second subscription to
      // report. duplicateSubscription.test.js drives that case with its own
      // stub, which does.
      list: async (p) => {
        log({ call: 'subscriptions.list', customer: p.customer, status: p.status });
        return { data: [] };
      },
      cancel: async (id) => {
        log({ call: 'subscriptions.cancel', id });
        return { id, status: 'canceled' };
      },
    },
    webhooks: {
      constructEvent: (buf) => JSON.parse(buf.toString('utf8')),
    },
  };
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'stripe') return fakeStripe;
  return origLoad.call(this, request, parent, isMain);
};

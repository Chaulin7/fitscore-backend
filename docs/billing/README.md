# CVsprings — Billing setup (Stripe subscriptions)

Subscription billing is attached to the **organization**. Free orgs get
`FREE_MONTHLY_LIMIT` analyses per calendar month; Pro/Team are unlimited.
Gating is enforced **server-side**; the frontend is display only.

> **Use TEST keys for now.** Do not switch to live keys as part of this work —
> going live is gated on the move to paid hosting, to avoid cold-start webhook
> timeouts dropping subscription events.

## Required environment variables

Set these on the backend (Render web service → Environment). Nothing is
hardcoded — all Stripe identifiers come from here.

| Variable | Purpose | Example (test) |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API key | `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | Verifies the webhook signature | `whsec_...` |
| `STRIPE_PRICE_PRO` | Recurring price ID for the Pro plan | `price_...` |
| `STRIPE_PRICE_TEAM` | Recurring price ID for the Team plan | `price_...` |
| `FREE_MONTHLY_LIMIT` | Free analyses per org per month (optional, default 10) | `10` |
| `TRIAL_FROM_EMAIL` | From: address for the trial-ending reminder (falls back to `EMAIL_FROM`) | `billing@cvsprings.com` |
| `PUBLIC_APP_URL` | Public origin for Checkout success/cancel + portal return. `FRONTEND_URL` / `APP_BASE_URL` are deprecated aliases; see `src/config/appUrl.js` | `https://cvsprings.com` |

If `STRIPE_SECRET_KEY` is unset the app still boots; billing endpoints return
`503 BILLING_NOT_CONFIGURED` and every org stays on Free with the monthly cap.

## One-time Stripe dashboard setup (test mode)

1. Toggle **Test mode** in the Stripe dashboard.
2. **Products → add product** for Pro and for Team, each with a recurring
   monthly price. Copy each **price ID** (`price_...`) into `STRIPE_PRICE_PRO` /
   `STRIPE_PRICE_TEAM`. (Amounts live in Stripe — never in code.)
3. **Developers → API keys** → copy the test **secret key** into
   `STRIPE_SECRET_KEY`.
4. Register the webhook (next section) and copy its **signing secret** into
   `STRIPE_WEBHOOK_SECRET`.

## Webhook registration

- **Endpoint URL:** `{PUBLIC_APP_URL}/api/billing/webhook`
  (e.g. `https://cvsprings7.onrender.com/api/billing/webhook`).
  > This URL changes from the Render URL to the custom domain when the
  > domain-merge step lands — update the endpoint in the Stripe dashboard then;
  > no code change is required.
- **Events to send:**
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`
  - `customer.subscription.trial_will_end` — no-card trial (see below)
  - `payment_method.attached` — no-card trial (**required**, see below)
  - `invoice.paid` — no-card trial (see below)

  > The last three are needed by the 30-day no-card trial. If they are not
  > enabled on the endpoint, trials still start and still pause — but the
  > reminder email never goes out and, worse, **a customer who adds a card
  > stays paused forever**, because nothing clears `pause_collection`. There is
  > no error anywhere when this is misconfigured; the symptom is a paying
  > customer with no access.
- The route receives the **raw body** and verifies the `Stripe-Signature`
  header against `STRIPE_WEBHOOK_SECRET`. It is exempt from session auth.
  Handlers are **idempotent** — state is always set from the event, so repeated
  or out-of-order deliveries are safe.

### Local webhook testing with the Stripe CLI

```bash
stripe login
stripe listen --forward-to localhost:3000/api/billing/webhook
# copy the printed whsec_... into STRIPE_WEBHOOK_SECRET, then:
stripe trigger checkout.session.completed
```

## Test cards

In test mode (Stripe Checkout), use any future expiry, any CVC, any postal code:

| Card number | Result |
|---|---|
| `4242 4242 4242 4242` | Payment succeeds → subscription active |
| `4000 0000 0000 0341` | Attaches but later charge fails → `invoice.payment_failed` (org goes `past_due`) |
| `4000 0000 0000 9995` | Declined (insufficient funds) |

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/billing/usage` | session | plan, status, period end, used, limit (null = unlimited) |
| `POST` | `/api/billing/checkout` | session, **owner** | body `{ plan: 'pro'\|'team' }` → `{ url }` |
| `POST` | `/api/billing/portal` | session, **owner** | → `{ url }` (manage/cancel/update card) |
| `POST` | `/api/billing/webhook` | none (signature) | raw body; Stripe is the source of truth |

## Plan behaviour

- **Free:** blocked at `FREE_MONTHLY_LIMIT`; a batch that would exceed the cap is
  rejected whole (`402 QUOTA_EXCEEDED`). Failed/errored analyses do not consume
  quota. Counter resets automatically on the new calendar month (period key
  `YYYY-MM`).
- **Pro / Team:** unlimited while `subscriptionStatus` is `active` or
  `past_due`.
- **`past_due`** (failed payment): access is kept and a warning is surfaced in
  the UI; the org is not cut off immediately.
- **Canceled/deleted subscription:** the org returns to Free and the cap
  resumes.

## 30-day no-card trial

An invite-only flow, separate from the checkout path above and sharing none of
its code. Prospects get a link; nobody types a card to start.

### Minting invites

`POST /admin/trial-invites`, platform-operator only (same guard as
`/admin/metrics` — every other caller gets a 404, not a 403).

```bash
curl -sX POST https://cvsprings.com/admin/trial-invites \
  -H "Authorization: Bearer $SESSION_TOKEN" -H 'Content-Type: application/json' \
  -d '{"invites":[{"email":"lead@agency.nl","company_name":"Agency BV","campaign":"q1-agencies"}]}'
```

Returns a token and a full `/start?t=…` URL per prospect. Tokens expire 30 days
out by default; override per request with `expiresInDays` or an explicit
`expiresAt`. One bad address rejects the whole batch — nothing is half-written.

### Redeeming

`GET /start?t=<token>` (public — the prospect has no account yet). Valid tokens
redirect into Checkout; **anything else redirects to `/?trial=unavailable#pricing`
with one soft message**, identical for expired, spent and unknown tokens, so the
endpoint is not an oracle for guessing live tokens. The precise reason is in the
server log. Add `?plan=team` for a Team trial; the default is Pro.

The session sets `trial_period_days: 30`, `payment_method_collection:
'if_required'` (no card asked for) and
`subscription_data.trial_settings.end_behavior.missing_payment_method: 'pause'`.
Stripe Tax and VAT-ID collection stay on, with
`billing_address_collection: 'required'` — without that last one the VAT field
never appears, because Stripe normally infers the country from the payment
method and this session collects none.

`/start` refuses an address that is **already a customer** (subscription
`trialing`, `active` or `past_due`) and redirects to `/login?trial=existing_account`
instead — otherwise re-inviting an existing customer would open a second
trialing subscription beside the one they are already paying for. A `paused`
org is deliberately *not* refused: that is a lapsed trial an operator may
legitimately re-invite.

### Claiming the account

Redeeming reserves an organization for the prospect (named from
`company_name`) with no user on it. They claim it by following
`/signup?t=<token>` — the token rides the Checkout success URL, and the welcome
email carries a second copy for anyone who closes the tab.

**Possession of the token is the proof of claim.** It is not an email match:
prospects routinely pay from one address and sign up with another, and an
address on a fresh signup is unproved, so adopting on it let anyone who knew a
prospect's email claim that company's organization. The link works for
`TRIAL_INVITE_SIGNUP_TTL` — 14 days from redemption — and consumes on first use
(`trial_invites.consumed_at`, guarded in SQL so two concurrent signups cannot
both adopt).

An unusable link — expired, already consumed, unknown — **falls through to an
ordinary signup**. It never blocks account creation; somebody whose link expired
still wants an account, and the operator can extend `signup_expires_at` for that
one prospect.

If the invited address already has an account, `/start` puts the trial on
**their** organization and signing up again answers `409 TRIAL_ALREADY_YOURS`
telling them to log in — never a duplicate account.

### The email fallback is not live

`services/trialAdoption.adoptByVerifiedEmail()` exists for the prospect who lost
their link, and refuses unless `users.email_verified_at` is set. **Nothing sets
it: this codebase has no email-verification step.** The fallback is therefore
unreachable today, by design — it fails closed rather than adopting on an
unproved address.

Whoever builds email verification: call it from the success branch of the
verify-email handler, immediately after marking the address verified. Never from
signup, never from login, never on a timer. `trialAdoption.test.js` asserts that
signup performs no adoption, so wiring it in at the wrong place fails loudly.

### Lifecycle

| Day | Stripe event | What happens |
|---|---|---|
| 0 | `checkout.session.completed` | plan set, status `trialing`, token redeemed, 14-day signup link stamped, welcome email with the claim link sent to both the Checkout address and the invited one |
| 27 | `customer.subscription.trial_will_end` | Resend reminder + portal link; one row in `trial_emails` (sent at most once per subscription) |
| 30, no card | `customer.subscription.updated` → `paused` | account goes **read-only**. Nothing is deleted, nothing is invoiced |
| 30, card on file | `customer.subscription.updated` → `active`, `invoice.paid` | first invoice is €49 + VAT; org marked converted with its campaign |
| any day | `payment_method.attached` | clears `pause_collection` and restores full access |

**Adding a card does not resume a paused subscription by itself.** Stripe leaves
`pause_collection` set until something clears it; that something is the
`payment_method.attached` branch in `src/routes/billing.js`. It is idempotent,
and it also sets the customer's default payment method when they have none —
otherwise the resumed subscription's first invoice fails and they land in
`past_due`, which looks to them exactly like the pause they just escaped.

### Access levels

One mapping, in `src/services/entitlements.js`, used everywhere:

| Subscription status | Access |
|---|---|
| `trialing`, `active`, `past_due` | full |
| `paused` | read-only — every GET works, every write returns `402 SUBSCRIPTION_PAUSED` |
| `canceled`, `unpaid`, `incomplete*` | no paid entitlement; the org falls back to the Free tier and its cap |

`/api/billing` is deliberately **not** behind the read-only gate: the way out of
a pause is the billing portal.

### Reporting

`organizations.trial_campaign` and `trial_converted_at` carry attribution;
`trial_invites` holds the same per token, plus `redeemed_at`. Conversions are
recorded once — a redelivered `invoice.paid` cannot move the date or
double-count a campaign.

## Going live (later, with paid hosting)

1. Recreate the products/prices in **live mode**; set the `price_...` env vars to
   the live IDs.
2. Set `STRIPE_SECRET_KEY` to the live secret key.
3. Register a **live-mode** webhook at the production URL and set
   `STRIPE_WEBHOOK_SECRET` to its live signing secret.
4. Set `PUBLIC_APP_URL` to the production domain (it is the only URL variable; `APP_BASE_URL` still works as a deprecated alias).

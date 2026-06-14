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
| `FREE_MONTHLY_LIMIT` | Free analyses per org per month (optional, default 25) | `25` |
| `APP_BASE_URL` | Base URL for Checkout success/cancel + portal return | `https://cvsprings7.onrender.com` |

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

- **Endpoint URL:** `{APP_BASE_URL}/api/billing/webhook`
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

## Going live (later, with paid hosting)

1. Recreate the products/prices in **live mode**; set the `price_...` env vars to
   the live IDs.
2. Set `STRIPE_SECRET_KEY` to the live secret key.
3. Register a **live-mode** webhook at the production URL and set
   `STRIPE_WEBHOOK_SECRET` to its live signing secret.
4. Set `APP_BASE_URL` to the production domain.

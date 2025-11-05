// server.js (ESM)
// ----------------
// Requirements in package.json:
//  "type": "module",
//  deps: express, stripe, dotenv, cors
//
// ENV needed:
//  STRIPE_SECRET_KEY=sk_test_...
//  STRIPE_WEBHOOK_SECRET=whsec_...
//  BASE_URL=http://localhost:3000
//  STRIPE_PRICE_ID=price_...   (optional fallback)

import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Helpful boot log
console.log("Stripe mode:", process.env.STRIPE_SECRET_KEY?.startsWith("sk_live") ? "LIVE" : "TEST");
console.log("BASE_URL:", process.env.BASE_URL);

// --- Absolute path for db.json to avoid dir confusion ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "db.json");

// --- Resilient JSON helpers ---
function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return { users: {} };
    const txt = fs.readFileSync(DB_PATH, "utf8");
    if (!txt || !txt.trim()) return { users: {} };
    return JSON.parse(txt);
  } catch (e) {
    console.warn("DB parse error, resetting:", e.message);
    return { users: {} };
  }
}
function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("DB write error:", e.message);
  }
}
function updateUser(email, patch) {
  const db = readDB();
  const current = db.users[email] || { email, is_premium: false, current_period_end: null, stripe_customer_id: null, stripe_subscription_id: null };
  db.users[email] = { ...current, ...patch };
  writeDB(db);
  console.log("→ updated", email, patch);
}

// --- Premium status helper ---
const premiumStatuses = new Set(["active", "trialing", "past_due"]);
const statusIsPremium = (status) => premiumStatuses.has(status);

// --- Ensure we always have a valid customer in THIS account/mode ---
async function ensureStripeCustomerForEmail(email) {
  const db = readDB();
  const user = db.users[email] || { email };

  // 1) If we have a stored id, verify it exists here
  if (user.stripe_customer_id) {
    try {
      const existing = await stripe.customers.retrieve(user.stripe_customer_id);
      if (!existing.deleted) return existing.id;
    } catch (e) {
      console.warn("Stale stripe_customer_id for", email, "— recreating");
      user.stripe_customer_id = null;
      updateUser(email, user);
    }
  }

  // 2) Try to reuse an existing customer by email in this account
  const found = await stripe.customers.list({ email, limit: 1 });
  if (found.data.length) {
    const id = found.data[0].id;
    updateUser(email, { ...user, stripe_customer_id: id });
    return id;
  }

  // 3) Create a new one
  const created = await stripe.customers.create({ email });
  updateUser(email, { ...user, stripe_customer_id: created.id });
  return created.id;
}

// --- Body parsers: raw ONLY for /webhook, JSON elsewhere ---
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") return next();
  return express.json()(req, res, next);
});

app.use(cors());
app.use(express.static("public"));

// --- Create Checkout Session (subscriptions) ---
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { email, price_id } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });

    // pick price: from client or fallback env
    const price = price_id || process.env.STRIPE_PRICE_ID;
    if (!price) return res.status(400).json({ error: "price_id required (or set STRIPE_PRICE_ID in .env)" });

    const customerId = await ensureStripeCustomerForEmail(email);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: email, // lets webhook map quickly
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${process.env.BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&email=${encodeURIComponent(email)}`,
      cancel_url: `${process.env.BASE_URL}/cancel.html`
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    // Return text if JSON fails on client
    res.status(400).json({ error: e.message || "Checkout creation failed" });
  }
});

// --- Billing portal (optional) ---
app.post("/create-portal-session", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });
    const db = readDB();
    const user = db.users[email];
    if (!user?.stripe_customer_id) return res.status(404).json({ error: "No Stripe customer for this email" });

    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.BASE_URL}/dashboard.html`
    });

    res.json({ url: portal.url });
  } catch (e) {
    console.error("create-portal-session error:", e);
    res.status(400).json({ error: e.message || "Portal creation failed" });
  }
});

// --- Webhook: flip premium status from Stripe events ---
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("⚠️  Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const type = event.type;
  const obj = event.data.object;
  console.log("[WEBHOOK]", type);

  try {
    if (type === "checkout.session.completed") {
      // Try to get email straight from the session
      const emailFromEvent =
        (obj.customer_details && obj.customer_details.email) ||
        obj.client_reference_id ||
        null;

      const customerId = obj.customer;
      const subId = obj.subscription;

      // Some payment methods create the subscription slightly after the session; retrieve to be safe
      const sub = subId ? await stripe.subscriptions.retrieve(subId) : null;

      // Map to our user
      let email = emailFromEvent;
      if (!email) {
        const db = readDB();
        email = Object.keys(db.users).find(e => db.users[e].stripe_customer_id === customerId) || null;
      }

      if (email && sub) {
        updateUser(email, {
          stripe_customer_id: customerId,
          is_premium: statusIsPremium(sub.status),
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          stripe_subscription_id: sub.id
        });
      } else if (email && !sub) {
        // Rare edge: session completed, but no sub id (e.g., delayed). Mark customer id, premium TBD.
        updateUser(email, { stripe_customer_id: customerId });
        console.log("⚠️  Session completed but no subscription yet; will update on subscription.created.");
      } else {
        console.log("⚠️  Could not map checkout.session.completed to an email");
      }
    }

    if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
      const customerId = obj.customer;
      const db = readDB();
      const email = Object.keys(db.users).find(e => db.users[e].stripe_customer_id === customerId) || null;
      if (email) {
        updateUser(email, {
          is_premium: statusIsPremium(obj.status),
          current_period_end: new Date(obj.current_period_end * 1000).toISOString(),
          stripe_subscription_id: obj.id
        });
      } else {
        console.log("⚠️  Could not map subscription.* to an email");
      }
    }

    if (type === "customer.subscription.deleted") {
      const customerId = obj.customer;
      const db = readDB();
      const email = Object.keys(db.users).find(e => db.users[e].stripe_customer_id === customerId) || null;
      if (email) {
        updateUser(email, {
          is_premium: false,
          current_period_end: null,
          stripe_subscription_id: null
        });
      } else {
        console.log("⚠️  Could not map subscription.deleted to an email");
      }
    }

    // Optional: flag a grace period on payment failure
    if (type === "invoice.payment_failed") {
      const customerId = obj.customer;
      const db = readDB();
      const email = Object.keys(db.users).find(e => db.users[e].stripe_customer_id === customerId) || null;
      if (email) {
        const until = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
        updateUser(email, { grace_until: until });
        console.log("Grace period set until", until, "for", email);
      }
    }
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("Webhook handler failed");
  }

  res.json({ received: true });
});

// --- Simple status endpoint for your dashboard ---
app.get("/status", (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "email required" });
  const db = readDB();
  res.json({ user: db.users[email] || null });
});

// --- Start server ---
const PORT = 3000;
// Confirm a checkout session and update DB (webhook fallback)
app.post("/confirm-session", async (req, res) => {
  try {
    const { session_id, email } = req.body || {};
    if (!session_id || !email) {
      return res.status(400).json({ error: "session_id and email required" });
    }

    // Get the checkout session with expanded subscription
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["subscription", "customer"],
    });

    const customerId = session.customer;
    const sub = session.subscription; // may be null if still creating

    // If subscription not expanded yet, try to find the latest one for the customer
    let subscription = sub;
    if (!subscription) {
      const list = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 1,
      });
      subscription = list.data[0] || null;
    }

    // Update DB if we have a subscription
    if (subscription) {
      const premium = new Set(["active", "trialing", "past_due"]).has(subscription.status);
      updateUser(email, {
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
        is_premium: premium,
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      });
      console.log("✔ confirm-session → updated", email, {
        is_premium: premium,
        sub: subscription.id,
        status: subscription.status,
      });
      return res.json({ ok: true, premium, subscription_id: subscription.id, status: subscription.status });
    }

    // If we still don’t see a subscription, at least save the customer id
    updateUser(email, { stripe_customer_id: customerId });
    console.log("⚠ confirm-session: no subscription yet; saved customer only");
    return res.json({ ok: true, premium: false, subscription_id: null, status: "pending" });
  } catch (e) {
    console.error("confirm-session error:", e);
    return res.status(400).json({ error: e.message || "confirm-session failed" });
  }
});

app.listen(PORT, () => {
  console.log(`iseehalo web running at ${process.env.BASE_URL}`);
  // Ensure db.json exists
  if (!fs.existsSync(DB_PATH)) writeDB({ users: {} });
});

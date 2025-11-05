// server.js (ESM)
// ----------------
// package.json needs:  "type": "module"
// deps: express, stripe, dotenv, cors
//
// ENV needed:
//  STRIPE_SECRET_KEY=sk_live_... (or sk_test_...)
//  STRIPE_WEBHOOK_SECRET=whsec_...
//  BASE_URL=https://iseehalo-web.onrender.com   (or http://localhost:3000)
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
app.set("trust proxy", 1); // good practice on Render/hosts behind proxy

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Helpful boot log
console.log("Stripe mode:", process.env.STRIPE_SECRET_KEY?.startsWith("sk_live") ? "LIVE" : "TEST");
console.log("BASE_URL:", process.env.BASE_URL);

// --- Absolute paths ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const DB_PATH = path.join(__dirname, "db.json");

// --- Resilient JSON helpers (optional cache for webhooks) ---
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
  const current = db.users[email] || {
    email,
    is_premium: false,
    current_period_end: null,
    stripe_customer_id: null,
    stripe_subscription_id: null
  };
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

  if (user.stripe_customer_id) {
    try {
      const existing = await stripe.customers.retrieve(user.stripe_customer_id);
      if (!existing.deleted) return existing.id;
    } catch {
      console.warn("Stale stripe_customer_id for", email, "— recreating");
      user.stripe_customer_id = null;
      updateUser(email, user);
    }
  }

  const found = await stripe.customers.list({ email, limit: 1 });
  if (found.data.length) {
    const id = found.data[0].id;
    updateUser(email, { ...user, stripe_customer_id: id });
    return id;
  }

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

// --- Serve static assets from /public with absolute path ---
app.use(express.static(PUBLIC_DIR));

// --- Pretty routes that map to your HTML files ---
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"));
});
app.get("/success", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "success.html"));
});
app.get("/cancel", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "cancel.html"));
});

// --- Health check (optional) ---
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- Create Checkout Session (subscriptions) ---
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { email, price_id, priceId } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });

    const price = price_id || priceId || process.env.STRIPE_PRICE_ID;
    if (!price) return res.status(400).json({ error: "price_id required (or set STRIPE_PRICE_ID in .env)" });

    const customerId = await ensureStripeCustomerForEmail(email);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: email,
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}&email=${encodeURIComponent(email)}`,
      cancel_url: `${process.env.BASE_URL}/cancel`
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    res.status(400).json({ error: e.message || "Checkout creation failed" });
  }
});

// --- Billing portal (lookup customer by email via Stripe) ---
app.post("/create-portal-session", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });

    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) {
      return res.status(404).json({ error: "No Stripe customer found for this email" });
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: `${process.env.BASE_URL}/dashboard`,
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
      const emailFromEvent =
        (obj.customer_details && obj.customer_details.email) ||
        obj.client_reference_id ||
        null;

      const customerId = obj.customer;
      const subId = obj.subscription;
      const sub = subId ? await stripe.subscriptions.retrieve(subId) : null;

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

// --- Simple status for dashboard (Stripe-backed; no db.json dependency) ---
app.get("/status", async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: "email required" });

    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) {
      return res.json({ user: null });
    }

    const customer = customers.data[0];
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 1,
    });

    if (!subs.data.length) {
      return res.json({
        user: {
          email,
          stripe_customer_id: customer.id,
          stripe_subscription_id: null,
          is_premium: false,
          current_period_end: null,
        },
      });
    }

    const sub = subs.data[0];
    const premium = ["active", "trialing", "past_due"].includes(sub.status);

    return res.json({
      user: {
        email,
        stripe_customer_id: customer.id,
        stripe_subscription_id: sub.id,
        is_premium: premium,
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        status: sub.status,
      },
    });
  } catch (err) {
    console.error("status error:", err);
    return res.status(500).json({ error: err.message || "status failed" });
  }
});

// --- confirm-session (webhook fallback; optional but handy) ---
app.post("/confirm-session", async (req, res) => {
  try {
    const { session_id, email } = req.body || {};
    if (!session_id || !email) {
      return res.status(400).json({ error: "session_id and email required" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["subscription", "customer"],
    });

    const customerId = session.customer;
    let subscription = session.subscription;

    if (!subscription) {
      const list = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 1,
      });
      subscription = list.data[0] || null;
    }

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

    updateUser(email, { stripe_customer_id: customerId });
    console.log("⚠ confirm-session: no subscription yet; saved customer only");
    return res.json({ ok: true, premium: false, subscription_id: null, status: "pending" });
  } catch (e) {
    console.error("confirm-session error:", e);
    return res.status(400).json({ error: e.message || "confirm-session failed" });
  }
});

// --- Start server (Render uses assigned port) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`iseehalo web running at ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  if (!fs.existsSync(DB_PATH)) writeDB({ users: {} });
});

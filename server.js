// server.js (ESM)
// deps: express, stripe, dotenv, cors, @supabase/supabase-js

import express from "express";
import dotenv from "dotenv";
dotenv.config(); // ✅ Load env first

import Stripe from "stripe";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

// --- Safety Check ---
const requiredEnv = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "BASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_PRICE_ID"
];
for (const k of requiredEnv) {
  if (!process.env[k]) console.warn(`⚠️ Missing env variable: ${k}`);
}

// --- Initialization ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const DB_PATH = path.join(__dirname, "db.json");

// --- Middleware ---
app.set("trust proxy", 1);
app.use(cors()); // ✅ 1. Moved to top for Render/Cross-domain support

// --- Helper: Local DB (Fallback only) ---
function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return { users: {} };
    const txt = fs.readFileSync(DB_PATH, "utf8");
    return txt ? JSON.parse(txt) : { users: {} };
  } catch (e) { return { users: {} }; }
}
function writeDB(data) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch (e) {}
}

// --- Update Logic (Supabase Primary) ---
async function updateUser(email, patch) {
  // 1. Update File DB (Local debug)
  const db = readDB();
  db.users[email] = { ...(db.users[email] || { email }), ...patch };
  writeDB(db);

  // 2. Update Supabase (Production)
  try {
    const { data: row } = await supabase.from("users").select("id").eq("email", email).maybeSingle();
    if (row) {
      const { error } = await supabase.from("users").update(patch).eq("id", row.id);
      if (!error) console.log(`☁️ Supabase updated: ${email}`);
    } else {
      console.log(`ℹ️ No Supabase user found for email: ${email}`);
    }
  } catch (err) { console.error("Supabase sync error:", err.message); }
}

// --- Body Parsers ---
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") return next();
  return express.json()(req, res, next);
});

app.use(express.static(PUBLIC_DIR));

// --- Routes ---
app.get("/healthz", (req, res) => res.json({ ok: true }));

// --- Create Checkout Session ---
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { email } = req.body;
    const priceId = process.env.STRIPE_PRICE_ID;

    if (!email) return res.status(400).json({ error: "Email required" });
    if (!priceId) return res.status(400).json({ error: "STRIPE_PRICE_ID not set in server env" });

    // Ensure customer exists
    const customers = await stripe.customers.list({ email, limit: 1 });
    let customerId = customers.data.length ? customers.data[0].id : (await stripe.customers.create({ email })).id;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_email: email }, // ✅ 2. Critical for Webhook reliability
      success_url: `${process.env.BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/index.html`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("Checkout error:", e);
    res.status(500).json({ error: e.message });
  }
});

// --- Webhook ---
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;
  const email = obj.metadata?.user_email || obj.customer_details?.email;

  if (!email) return res.json({ received: true, info: "No email found" });

  if (event.type === "checkout.session.completed" || event.type === "customer.subscription.updated") {
    const subId = obj.subscription || obj.id;
    const subscription = await stripe.subscriptions.retrieve(subId);
    
    await updateUser(email, {
      is_premium: ["active", "trialing"].includes(subscription.status),
      stripe_customer_id: obj.customer,
      stripe_subscription_id: subId,
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
    });
  }

  if (event.type === "customer.subscription.deleted") {
    await updateUser(email, { is_premium: false, stripe_subscription_id: null });
  }

  res.json({ received: true });
});

// --- Portal ---
app.post("/create-portal-session", async (req, res) => {
  try {
    const { email } = req.body;
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.status(404).json({ error: "No customer" });

    const portal = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: `${process.env.BASE_URL}/dashboard.html`,
    });
    res.json({ url: portal.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 iseehalo running on port ${PORT}`));
// server.js (ESM)
// deps: express, stripe, dotenv, cors, @supabase/supabase-js

import express from "express";
import dotenv from "dotenv";
dotenv.config();

import Stripe from "stripe";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

app.set("trust proxy", 1);
app.use(cors());

// --- Helper Functions ---
async function updateUser(email, patch) {
  try {
    const { data: row } = await supabase.from("users").select("id").eq("email", email).maybeSingle();
    if (row) {
      await supabase.from("users").update(patch).eq("id", row.id);
      console.log(`☁️ Supabase updated via email: ${email}`);
    }
  } catch (err) { console.error("Update error:", err.message); }
}

function decodeAppleJWS(signedPayload) {
  try { return jwt.decode(signedPayload); } catch (e) { return null; }
}

async function updateAppleUser(appAccountToken, payload) {
  if (!appAccountToken) return;
  const patch = {
    is_premium: payload.status === 1,
    platform: 'apple',
    current_period_end: new Date(payload.expiresDate).toISOString(),
    apple_original_transaction_id: payload.originalTransactionId
  };
  await supabase.from("users").update(patch).eq("id", appAccountToken);
}

// --- Body Parser Logic ---
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") return next();
  return express.json()(req, res, next);
});

app.use(express.static(PUBLIC_DIR));

// --- Routes ---
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { email, mobileUserId } = req.body;
    const priceId = process.env.STRIPE_PRICE_ID;

    // Use email if available to find/create customer
    let customerId = null;
    if (email) {
      const customers = await stripe.customers.list({ email, limit: 1 });
      customerId = customers.data.length ? customers.data[0].id : (await stripe.customers.create({ email })).id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: mobileUserId || null, // THE BRIDGE
      metadata: { user_email: email || "mobile_checkout" },
      success_url: `${process.env.BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/index.html`,
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) { return res.status(400).send(err.message); }

  const obj = event.data.object;
  const email = obj.metadata?.user_email || obj.customer_details?.email;
  const mobileId = obj.client_reference_id;

  if (event.type === "checkout.session.completed" || event.type === "customer.subscription.updated") {
    const subId = obj.subscription || obj.id;
    const subscription = await stripe.subscriptions.retrieve(subId);
    const patch = {
      is_premium: ["active", "trialing"].includes(subscription.status),
      stripe_customer_id: obj.customer,
      stripe_subscription_id: subId,
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
    };

    if (mobileId) {
      await supabase.from("users").update(patch).eq("id", mobileId);
    } else if (email) {
      await updateUser(email, patch);
    }
  }
  res.json({ received: true });
});

// Apple Webhook stays the same as your current one
app.post("/webhook-apple", async (req, res) => {
  try {
    const { signedPayload } = req.body;
    const notification = decodeAppleJWS(signedPayload);
    const transaction = decodeAppleJWS(notification.data.signedTransactionInfo);
    if (transaction.appAccountToken) {
      await updateAppleUser(transaction.appAccountToken, transaction);
    }
    res.json({ received: true });
  } catch (err) { res.status(500).send("Error"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 iseehalo running on port ${PORT}`));
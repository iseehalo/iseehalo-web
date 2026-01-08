// server.js (ESM)
// deps: express, stripe, dotenv, cors, @supabase/supabase-js

import express from "express";
import dotenv from "dotenv";
dotenv.config();

import Stripe from "stripe";
import cors from "cors";
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

// --- Helper: Centralized Supabase Update ---
async function performSupabaseUpdate(filterField, filterValue, patch) {
  try {
    const { data, error } = await supabase
      .from("users")
      .update(patch)
      .eq(filterField, filterValue)
      .select(); // select() helps verify the update actually happened

    if (error) throw error;
    if (data && data.length > 0) {
      console.log(`Success: Updated user where ${filterField} = ${filterValue}`);
    } else {
      console.warn(`⚠️ Warning: No user found with ${filterField} = ${filterValue}`);
    }
  } catch (err) {
    console.error(`Supabase Error: ${err.message}`);
  }
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
    // Note: Ensure your index.html passes 'mobileUserId' in the fetch body
    const { email, mobileUserId } = req.body;
    const priceId = process.env.STRIPE_PRICE_ID;

    if (!priceId) throw new Error("STRIPE_PRICE_ID is not defined in env");

    let customerId = null;
    if (email) {
      const customers = await stripe.customers.list({ email, limit: 1 });
      customerId = customers.data.length 
        ? customers.data[0].id 
        : (await stripe.customers.create({ email })).id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: mobileUserId || null, // CRITICAL: This links the payment to the App User ID
      metadata: { 
        user_email: email || "mobile_checkout",
        source_platform: "mobile_app" 
      },
      success_url: `${process.env.BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/index.html`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("Checkout Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook Signature Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;

  if (event.type === "checkout.session.completed" || event.type === "customer.subscription.updated") {
    const subId = obj.subscription || obj.id;
    const mobileId = obj.client_reference_id;
    const email = obj.metadata?.user_email || obj.customer_details?.email;

    try {
      const subscription = await stripe.subscriptions.retrieve(subId);
      
      const patch = {
        is_premium: ["active", "trialing"].includes(subscription.status),
        stripe_customer_id: obj.customer,
        stripe_subscription_id: subId,
        platform: 'stripe',
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
      };

      // 1. Priority: Update via Mobile ID (client_reference_id)
      if (mobileId) {
        await performSupabaseUpdate("id", mobileId, patch);
      } 
      // 2. Fallback: Update via Email
      else if (email) {
        await performSupabaseUpdate("email", email, patch);
      }
    } catch (subErr) {
      console.error("Subscription Retrieval Error:", subErr.message);
    }
  }

  res.json({ received: true });
});

// --- Apple Webhook ---
app.post("/webhook-apple", async (req, res) => {
  try {
    const { signedPayload } = req.body;
    const notification = jwt.decode(signedPayload);
    const transaction = jwt.decode(notification.data.signedTransactionInfo);

    if (transaction.appAccountToken) {
      const patch = {
        is_premium: transaction.status === 1,
        platform: 'apple',
        current_period_end: new Date(transaction.expiresDate).toISOString()
      };
      await performSupabaseUpdate("id", transaction.appAccountToken, patch);
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Apple Webhook Error:", err.message);
    res.status(500).send("Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
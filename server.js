require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");

const app = express();

/* -------------------- ENV GUARDS -------------------- */
const required = [
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_ID",
  "CHECKOUT_SUCCESS_URL",
  "CHECKOUT_CANCEL_URL",
  "STRIPE_WEBHOOK_SECRET",
];

for (const k of required) {
  if (!process.env[k]) {
    console.error(`❌ Missing env var: ${k}`);
  }
}

/* -------------------- DATABASE -------------------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* -------------------- STRIPE -------------------- */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* -------------------- BASIC ROUTES -------------------- */
app.get("/", (req, res) => res.send("OK"));

app.get("/health", async (req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true, db: true });
  } catch (err) {
    console.error("DB health failed:", err.message);
    res.status(500).json({ ok: false, db: false, error: err.message });
  }
});

/* -------------------- STRIPE WEBHOOK (MUST BE RAW) -------------------- */
/**
 * IMPORTANT:
 * This must be defined BEFORE app.use(express.json())
 * because Stripe signature verification needs the raw bytes.
 */
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature failed:", err.message);
    return res.status(400).send("Webhook Error");
  }

  console.log("🔥 STRIPE EVENT:", event.type);

  // TODO: update DB + trigger Discord role updates based on event types
  // Examples:
  // - checkout.session.completed
  // - customer.subscription.updated
  // - customer.subscription.deleted
  // - invoice.payment_failed
  // - invoice.paid

  return res.json({ received: true });
});

/* -------------------- NORMAL JSON ROUTES -------------------- */
app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  const { discordId } = req.body;

  if (!discordId) return res.status(400).json({ error: "Missing discordId" });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: process.env.CHECKOUT_SUCCESS_URL,
      cancel_url: process.env.CHECKOUT_CANCEL_URL,
      metadata: { discord_id: discordId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe checkout failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- START -------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));

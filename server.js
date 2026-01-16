require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");

const app = express();

// --- Env checks (don’t crash later) ---
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY missing");
if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET missing");
if (!process.env.STRIPE_PRICE_ID) throw new Error("STRIPE_PRICE_ID missing");
if (!process.env.CHECKOUT_SUCCESS_URL) throw new Error("CHECKOUT_SUCCESS_URL missing");
if (!process.env.CHECKOUT_CANCEL_URL) throw new Error("CHECKOUT_CANCEL_URL missing");

// --- Clients ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --- Stripe webhook MUST be before express.json() ---
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    console.log("🔥 STRIPE WEBHOOK HIT");

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
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("✅ WEBHOOK VERIFIED:", event.type);
    return res.json({ received: true });
  }
);

// --- Normal JSON routes ---
app.use(express.json());

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("select 1 as ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (err) {
    res.status(500).json({ ok: false, db: false, error: err.message });
  }
});

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
    console.error("❌ Stripe session failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/routes", (req, res) => {
  res.json({
    routes: [
      "GET /health",
      "POST /create-checkout-session",
      "POST /stripe/webhook",
      "GET /routes",
    ],
  });
});

// --- Listen (Railway requires this) ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Backend running on ${port}`));

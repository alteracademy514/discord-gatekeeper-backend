require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");

const app = express();

/* ======================
   ENVIRONMENT CHECKS
   ====================== */
const REQUIRED_ENVS = [
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID",
  "CHECKOUT_SUCCESS_URL",
  "CHECKOUT_CANCEL_URL",
];

for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    throw new Error(`❌ Missing env var: ${key}`);
  }
}

/* ======================
   CLIENTS
   ====================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ======================
   DEBUG ROOT ROUTES
   ====================== */
app.get("/", (req, res) => {
  res.send("OK — discord-gatekeeper-backend is running");
});

app.get("/routes", (req, res) => {
  res.json({
    routes: [
      "GET /",
      "GET /health",
      "GET /routes",
      "POST /create-checkout-session",
      "POST /stripe/webhook",
    ],
  });
});

/* ======================
   STRIPE WEBHOOK
   ⚠ MUST be before express.json()
   ====================== */
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

    // Later we will handle:
    // checkout.session.completed
    // customer.subscription.updated
    // customer.subscription.deleted

    res.json({ received: true });
  }
);

/* ======================
   NORMAL JSON ROUTES
   ====================== */
app.use(express.json());

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("select 1 as ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/create-checkout-session", async (req, res) => {
  const { discordId } = req.body;

  if (!discordId) {
    return res.status(400).json({ error: "Missing discordId" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: process.env.CHECKOUT_SUCCESS_URL,
      cancel_url: process.env.CHECKOUT_CANCEL_URL,
      metadata: {
        discord_id: discordId,
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe checkout failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   START SERVER (Railway)
   ====================== */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Backend running on port ${port}`);
});

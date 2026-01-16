require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* -------------------- DATABASE -------------------- */
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* -------------------- STRIPE WEBHOOK (RAW BODY) -------------------- */
/**
 * IMPORTANT:
 * - This MUST come before app.use(express.json())
 * - Stripe needs the raw body to verify signatures
 */
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw Buffer
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature error:", err.message);
    return res.status(400).send("Webhook Error");
  }

  console.log("🔥 STRIPE EVENT:", event.type);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const discordId = session?.metadata?.discord_id;
    console.log("✅ PAYMENT COMPLETE for Discord ID:", discordId);
  }

  res.json({ received: true });
});

/* -------------------- NORMAL JSON ROUTES -------------------- */
app.use(express.json());

app.get("/health", async (req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true, db: true });
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
    console.error("Stripe checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/routes", (req, res) => {
  const routes = app._router.stack
    .filter((r) => r.route)
    .map((r) => {
      const methods = Object.keys(r.route.methods).join(",").toUpperCase();
      return `${methods} ${r.route.path}`;
    });

  res.json({ routes });
});

/* -------------------- START -------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));

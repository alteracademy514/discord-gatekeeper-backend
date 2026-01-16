require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");

const app = express();
app.use(express.json());

// --- Required env checks (fail fast) ---
["DATABASE_URL", "STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "CHECKOUT_SUCCESS_URL", "CHECKOUT_CANCEL_URL"].forEach((k) => {
  if (!process.env[k]) throw new Error(`${k} is missing (Railway Variables not set)`);
});

// --- DB ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Stripe ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --- Health ---
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("select 1 as ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (err) {
    res.status(500).json({ ok: false, db: false, error: err.message });
  }
});

// --- Checkout ---
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
    console.error("Stripe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Start server ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Backend running on ${port}`));

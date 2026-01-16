require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");

const app = express();

// Webhook needs raw body, so define it BEFORE express.json() affects it
app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Handle event types
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const discordId = session.metadata?.discord_id;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      // TODO: upsert into DB + mark active
      console.log("checkout.session.completed", { discordId, customerId, subscriptionId });
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      console.log("invoice.payment_failed", { customerId: invoice.customer });
      // TODO: mark payment issue + start 24h deadline
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      console.log("subscription.deleted", { customerId: sub.customer });
      // TODO: mark canceled + remove roles + kick
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).send("Server error");
  }
});


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

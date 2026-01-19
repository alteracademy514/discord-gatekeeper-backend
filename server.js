require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");
const crypto = require("crypto");

const app = express();

/* -------------------- ENV GUARDS -------------------- */
const required = [
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_ID",
  "CHECKOUT_SUCCESS_URL",
  "CHECKOUT_CANCEL_URL",
  "STRIPE_WEBHOOK_SECRET",
  "PUBLIC_BACKEND_URL" // Added this to ensure redirects work
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

/* -------------------- HELPER FUNCTIONS -------------------- */
function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

/* -------------------- BASIC ROUTES -------------------- */
app.get("/", (req, res) => res.send("Gatekeeper Backend Online 🟢"));

app.get("/health", async (req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true, db: true });
  } catch (err) {
    console.error("DB health failed:", err.message);
    res.status(500).json({ ok: false, db: false, error: err.message });
  }
});

/* -------------------- STRIPE WEBHOOK -------------------- */
// This MUST be before express.json() because it needs raw body
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
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

  // HANDLE SUCCESSFUL CHECKOUT
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const discordId = session.metadata.discord_id; // Retrieved from the session we created in /link
    const customerId = session.customer;

    if (discordId) {
      console.log(`✅ Linking Discord ${discordId} to Customer ${customerId}`);
      
      try {
        await pool.query(
          `UPDATE users 
           SET stripe_customer_id = $1, 
               subscription_status = 'active',
               updated_at = now()
           WHERE discord_id = $2`,
          [customerId, discordId]
        );
        console.log("Database updated successfully.");
      } catch (dbErr) {
        console.error("❌ Database update failed:", dbErr);
      }
    }
  }

  // HANDLE SUBSCRIPTION DELETION (Optional but recommended)
  if (event.type === 'customer.subscription.deleted') {
     const subscription = event.data.object;
     const customerId = subscription.customer;
     try {
       await pool.query(
          `UPDATE users SET subscription_status = 'inactive' WHERE stripe_customer_id = $1`,
          [customerId]
       );
       console.log(`❌ Subscription deleted for customer ${customerId}`);
     } catch (err) {
       console.error("Error updating inactive status:", err);
     }
  }

  return res.json({ received: true });
});

/* -------------------- JSON MIDDLEWARE -------------------- */
// Apply this AFTER the webhook
app.use(express.json());


/* -------------------- CORE LOGIC ROUTES -------------------- */

// 1. Bot calls this to get a unique link for the user
app.post("/link/start", async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) {
    return res.status(400).json({ error: "Missing discordId" });
  }

  try {
    // Upsert user (create if not exists)
    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline)
       VALUES ($1, 'unlinked', now() + interval '48 hours')
       ON CONFLICT (discord_id) DO UPDATE 
       SET link_deadline = now() + interval '48 hours'`,
      [discordId]
    );

    const token = makeToken();

    // Store the token
    await pool.query(
      `INSERT INTO link_tokens (token, discord_id, expires_at)
       VALUES ($1, $2, now() + interval '48 hours')`,
      [token, discordId]
    );

    // Return the full URL for the bot to display
    res.json({
      url: `${process.env.PUBLIC_BACKEND_URL}/link?token=${token}`,
    });
  } catch (err) {
    console.error("Link start error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


// 2. User clicks the link -> We validate token -> Redirect to Stripe
app.get("/link", async (req, res) => {
  const { token } = req.query;

  if (!token) return res.status(400).send("Missing token parameter");

  try {
    // Find valid token
    const result = await pool.query(
      `SELECT * FROM link_tokens 
       WHERE token = $1 
       AND expires_at > now() 
       AND used_at IS NULL`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(403).send("Invalid or expired link. Please generate a new one via the bot.");
    }

    const discordId = result.rows[0].discord_id;

    // Mark token as used
    await pool.query(`UPDATE link_tokens SET used_at = now() WHERE token = $1`, [token]);

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: process.env.CHECKOUT_SUCCESS_URL,
      cancel_url: process.env.CHECKOUT_CANCEL_URL,
      metadata: { 
        discord_id: discordId // This passes the ID to the webhook later
      }, 
    });

    // Redirect user to Stripe's hosted checkout page
    res.redirect(session.url);

  } catch (err) {
    console.error("Link redirect error:", err);
    res.status(500).send("Internal Server Error");
  }
});


// Debug endpoint (keep or remove before production)
app.get("/env-check", (req, res) => {
  res.json({
    DATABASE_URL: !!process.env.DATABASE_URL,
    STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: !!process.env.STRIPE_WEBHOOK_SECRET,
    PUBLIC_BACKEND_URL: process.env.PUBLIC_BACKEND_URL,
  });
});

/* -------------------- START -------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
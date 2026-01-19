require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");
const crypto = require("crypto");

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

/* -------------------- 1. WEBHOOKS (MUST BE FIRST) -------------------- */
// This section listens for Stripe events. It handles the "Raw" data to verify security.
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // A. Payment Failed (Card Declined, etc.)
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      if (invoice.customer) {
        console.log(`⚠️ Payment failed for ${invoice.customer}. Giving 24h grace.`);
        // Set status to 'payment_issue' and give them 24 hours to fix it
        await pool.query(
          `UPDATE users SET subscription_status = 'payment_issue', link_deadline = now() + interval '24 hours' WHERE stripe_customer_id = $1`,
          [invoice.customer]
        );
      }
    }

    // B. Subscription Ended / Cancelled
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      if (sub.customer) {
        // LOGIC UPDATE: We use the ACTUAL end date from Stripe
        // sub.current_period_end is a Unix timestamp (seconds)
        const endDate = new Date(sub.current_period_end * 1000); // Convert to JS Date
        
        console.log(`🚫 Subscription ended for ${sub.customer}. Deadline set to: ${endDate}`);
        
        await pool.query(
          `UPDATE users 
           SET subscription_status = 'payment_issue', 
               link_deadline = to_timestamp($2) 
           WHERE stripe_customer_id = $1`,
          [sub.customer, sub.current_period_end]
        );
      }
    }
  } catch (err) {
    console.error("Webhook Logic Error:", err);
  }
  res.json({ received: true });
});

/* -------------------- 2. MIDDLEWARE (MUST BE SECOND) -------------------- */
// This allows the rest of the app to read JSON data (for the link pages)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* -------------------- 3. APP ROUTES -------------------- */

// Start Link Process
app.post("/link/start", async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: "Missing ID" });

  try {
    // New users get 48 hours to link
    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline)
       VALUES ($1, 'unlinked', now() + interval '48 hours')
       ON CONFLICT (discord_id) DO NOTHING`,
      [discordId]
    );

    const token = makeToken();
    await pool.query(
      `INSERT INTO link_tokens (token, discord_id, expires_at, metadata) VALUES ($1, $2, now() + interval '30 minutes', $3)`,
      [token, discordId, { type: 'initial_handshake' }]
    );

    res.json({ url: `${process.env.PUBLIC_BACKEND_URL}/link?token=${token}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Show Verify Page
app.get("/link", async (req, res) => {
  const { token } = req.query;
  const result = await pool.query(`SELECT 1 FROM link_tokens WHERE token = $1 AND expires_at > now() AND used_at IS NULL`, [token]);
  if (result.rows.length === 0) return res.status(403).send("Invalid link.");

  res.send(`
    <html><body style="font-family:sans-serif;max-width:500px;margin:50px auto;padding:20px;">
      <h2>🔐 Verify Subscription</h2>
      <form action="/link/scan" method="POST">
        <input type="hidden" name="token" value="${token}" />
        <input type="email" name="email" required placeholder="billing@example.com" style="width:100%;padding:10px;margin-bottom:10px;" />
        <button type="submit" style="padding:10px 20px;background:#5865F2;color:white;border:none;">Verify</button>
      </form>
    </body></html>
  `);
});

// Verify & Send Email (WordPress)
app.post("/link/scan", async (req, res) => {
  const { token, email } = req.body;

  try {
    const tokenRes = await pool.query(`SELECT * FROM link_tokens WHERE token = $1`, [token]);
    if (tokenRes.rows.length === 0) return res.status(403).send("Expired.");
    
    const discordId = tokenRes.rows[0].discord_id;

    // Check Stripe
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) return res.send("❌ No Stripe customer found.");
    const customer = customers.data[0];

    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active' });
    if (subs.data.length === 0) return res.send("⚠️ No active subscription found.");

    // Generate Magic Link
    await pool.query(`UPDATE link_tokens SET used_at = now() WHERE token = $1`, [token]);
    const magicToken = makeToken();
    await pool.query(
      `INSERT INTO link_tokens (token, discord_id, expires_at, metadata) VALUES ($1, $2, now() + interval '1 hour', $3)`,
      [magicToken, discordId, { customer_id: customer.id }]
    );

    const magicLink = `${process.env.PUBLIC_BACKEND_URL}/link/finish?token=${magicToken}`;

    // Send via WordPress
    console.log(`📤 Sending email to ${email} via WordPress...`);
    const wpResponse = await fetch(process.env.WORDPRESS_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-gatekeeper-secret': process.env.GATEKEEPER_SHARED_SECRET
        },
        body: JSON.stringify({ email: email, link: magicLink })
    });

    if (wpResponse.ok) {
        res.send(`<h2>✅ Email Sent</h2><p>Check your inbox for the verification link!</p>`);
    } else {
        console.error("WP Error:", await wpResponse.text());
        res.send(`<h2>⚠️ Email Error</h2><p>Verified, but email failed to send.</p>`);
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Error verifying.");
  }
});

// Finish Linking
app.get("/link/finish", async (req, res) => {
  const { token } = req.query;
  try {
    const result = await pool.query(`SELECT * FROM link_tokens WHERE token = $1 AND used_at IS NULL`, [token]);
    if (result.rows.length === 0) return res.status(403).send("Invalid link.");

    const { discord_id, metadata } = result.rows[0];
    await pool.query(`UPDATE link_tokens SET used_at = now() WHERE token = $1`, [token]);
    
    await pool.query(
      `UPDATE users SET stripe_customer_id = $1, subscription_status = 'active', updated_at = now() WHERE discord_id = $2`,
      [metadata.customer_id, discord_id]
    );

    res.send("<h1>🎉 Linked!</h1><p>You can close this window.</p>");
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.listen(process.env.PORT || 3000, () => console.log(`✅ Backend Online`));
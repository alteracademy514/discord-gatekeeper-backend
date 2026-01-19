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

/* -------------------- 1. WEBHOOKS (SIMPLIFIED) -------------------- */
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
    // A. Payment Failed (Bounced) -> KICK IMMEDIATELY
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      if (invoice.customer) {
        console.log(`⚠️ Payment bounced for ${invoice.customer}. Setting to Unlinked (Kick Now).`);
        await pool.query(
          `UPDATE users SET subscription_status = 'unlinked', link_deadline = now() WHERE stripe_customer_id = $1`,
          [invoice.customer]
        );
      }
    }

    // B. Subscription Ended -> KICK WHEN TIME RUNS OUT
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      if (sub.customer) {
        // Use the actual end date (if they cancelled at period end)
        // If they cancelled "Immediately", this date is NOW.
        const endDate = new Date(sub.current_period_end * 1000);
        console.log(`🚫 Subscription ENDED for ${sub.customer}. Kick set for: ${endDate}`);
        
        await pool.query(
          `UPDATE users 
           SET subscription_status = 'unlinked', 
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

/* -------------------- 2. MIDDLEWARE -------------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* -------------------- 3. APP ROUTES -------------------- */
app.post("/link/start", async (req, res) => {
  const { discordId } = req.body;
  try {
    // STRICT RULE: New users get exactly 24 hours
    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline)
       VALUES ($1, 'unlinked', now() + interval '24 hours')
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
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/link", async (req, res) => {
  const { token } = req.query;
  const result = await pool.query(`SELECT 1 FROM link_tokens WHERE token = $1 AND expires_at > now() AND used_at IS NULL`, [token]);
  if (result.rows.length === 0) return res.status(403).send("Invalid link.");
  res.send(`<html><body style="font-family:sans-serif;max-width:500px;margin:50px auto;padding:20px;"><h2>🔐 Verify Subscription</h2><form action="/link/scan" method="POST"><input type="hidden" name="token" value="${token}" /><input type="email" name="email" required placeholder="billing@example.com" style="width:100%;padding:10px;margin-bottom:10px;" /><button type="submit" style="padding:10px 20px;background:#5865F2;color:white;border:none;">Verify</button></form></body></html>`);
});

app.post("/link/scan", async (req, res) => {
  const { token, email } = req.body;
  try {
    const tokenRes = await pool.query(`SELECT * FROM link_tokens WHERE token = $1`, [token]);
    if (tokenRes.rows.length === 0) return res.status(403).send("Expired.");
    
    const discordId = tokenRes.rows[0].discord_id;
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) return res.send("❌ No Stripe customer found.");
    
    const customer = customers.data[0];
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active' });
    if (subs.data.length === 0) return res.send("⚠️ No active subscription found.");

    await pool.query(`UPDATE link_tokens SET used_at = now() WHERE token = $1`, [token]);
    const magicToken = makeToken();
    await pool.query(
      `INSERT INTO link_tokens (token, discord_id, expires_at, metadata) VALUES ($1, $2, now() + interval '1 hour', $3)`,
      [magicToken, discordId, { customer_id: customer.id }]
    );

    const magicLink = `${process.env.PUBLIC_BACKEND_URL}/link/finish?token=${magicToken}`;
    console.log(`📤 Sending email to ${email} via WordPress...`);
    
    try {
        await fetch(process.env.WORDPRESS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-gatekeeper-secret': process.env.GATEKEEPER_SHARED_SECRET
            },
            body: JSON.stringify({ email: email, link: magicLink })
        });
        res.send(`<h2>✅ Email Sent</h2><p>Check your inbox!</p>`);
    } catch(e) {
        res.send(`<h2>⚠️ Email Failed</h2><p>We verified you, but the email failed to send.</p>`);
    }
  } catch (err) {
    res.status(500).send("Error verifying.");
  }
});

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
    res.send("<h1>🎉 Linked!</h1>");
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.listen(process.env.PORT || 3000, () => console.log(`✅ Backend Online`));
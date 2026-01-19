require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");
const crypto = require("crypto");

const app = express();

/* -------------------- CONFIG -------------------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

/* -------------------- 1. WEBHOOKS (The Enforcer) -------------------- */
// This MUST be before express.json() to capture raw Stripe events
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
    console.error("❌ Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("🔥 STRIPE EVENT:", event.type);

  try {
    // A. PAYMENT FAILED -> Set "Payment Issue" + 24h Deadline
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      
      if (customerId) {
        console.log(`⚠️ Payment failed for Customer ${customerId}`);
        await pool.query(
          `UPDATE users 
           SET subscription_status = 'payment_issue', 
               link_deadline = now() + interval '24 hours' 
           WHERE stripe_customer_id = $1`,
          [customerId]
        );
      }
    }

    // B. SUBSCRIPTION CANCELED -> Immediate Unlink
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;
      
      if (customerId) {
        console.log(`🚫 Subscription deleted for Customer ${customerId}`);
        await pool.query(
          `UPDATE users 
           SET subscription_status = 'unlinked', 
               link_deadline = now() 
           WHERE stripe_customer_id = $1`,
          [customerId]
        );
      }
    }

  } catch (err) {
    console.error("Webhook Logic Error:", err);
  }

  res.json({ received: true });
});

/* -------------------- MIDDLEWARE -------------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* -------------------- 2. BOT HANDOFF -------------------- */
app.post("/link/start", async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: "Missing discordId" });

  try {
    // Create/Update user with 48h deadline if new
    await pool.query(
      `INSERT INTO users (discord_id, subscription_status, link_deadline)
       VALUES ($1, 'unlinked', now() + interval '48 hours')
       ON CONFLICT (discord_id) DO UPDATE SET updated_at = now()`,
      [discordId]
    );

    // Create Token A (Discord -> Web)
    const token = makeToken();
    await pool.query(
      `INSERT INTO link_tokens (token, discord_id, expires_at, metadata)
       VALUES ($1, $2, now() + interval '30 minutes', $3)`,
      [token, discordId, { type: 'initial_handshake' }]
    );

    res.json({ url: `${process.env.PUBLIC_BACKEND_URL}/link?token=${token}` });
  } catch (err) {
    console.error("Start error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* -------------------- 3. USER INTERFACE -------------------- */
app.get("/link", async (req, res) => {
  const { token } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM link_tokens WHERE token = $1 AND expires_at > now() AND used_at IS NULL`,
      [token]
    );

    if (result.rows.length === 0) return res.status(403).send("Invalid or expired link.");

    res.send(`
      <html>
        <body style="font-family: sans-serif; max-width: 500px; margin: 50px auto; padding: 20px;">
          <h2>🔐 Verify Subscription</h2>
          <p>Please enter the email address linked to your active Stripe subscription.</p>
          <form action="/link/scan" method="POST">
            <input type="hidden" name="token" value="${token}" />
            <input type="email" name="email" required placeholder="billing@example.com" style="width: 100%; padding: 10px; margin-bottom: 10px;" />
            <button type="submit" style="padding: 10px 20px; background: #5865F2; color: white; border: none; cursor: pointer;">Verify</button>
          </form>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/* -------------------- 4. VERIFY & EMAIL LOGIC -------------------- */
app.post("/link/scan", async (req, res) => {
  const { token, email } = req.body;

  try {
    const tokenRes = await pool.query(`SELECT * FROM link_tokens WHERE token = $1`, [token]);
    if (tokenRes.rows.length === 0) return res.status(403).send("Session expired.");
    
    const discordId = tokenRes.rows[0].discord_id;

    // A. Check Stripe for Customer
    const customers = await stripe.customers.list({ email: email, limit: 1 });
    if (customers.data.length === 0) return res.send("❌ No Stripe customer found with that email.");
    
    const customer = customers.data[0];

    // B. Check for Active Subscription
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active' });
    if (subs.data.length === 0) return res.send("⚠️ Customer found, but no active subscription.");

    // C. Generate Magic Link
    await pool.query(`UPDATE link_tokens SET used_at = now() WHERE token = $1`, [token]);
    
    const magicToken = makeToken();
    await pool.query(
      `INSERT INTO link_tokens (token, discord_id, expires_at, metadata)
       VALUES ($1, $2, now() + interval '1 hour', $3)`,
      [magicToken, discordId, { type: 'email_verification', customer_id: customer.id }]
    );

    const magicLink = `${process.env.PUBLIC_BACKEND_URL}/link/finish?token=${magicToken}`;

    // --- SECURE MODE ---
    // Log to Console (So you can test manually until WordPress is ready)
    console.log(`🔗 [SECURE EMAIL] Magic Link for ${email}: ${magicLink}`);
    
    // Show "Check Inbox" to user (Link is HIDDEN from screen now)
    res.send(`
      <h2>✅ Verification Email Sent</h2>
      <p>We found your active subscription.</p>
      <p>Please check your email inbox (and spam folder) for the login link.</p>
      <p><i>(Admin Note: Check Railway Logs for the link)</i></p>
    `);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error verifying account.");
  }
});

/* -------------------- 5. FINALIZATION -------------------- */
app.get("/link/finish", async (req, res) => {
  const { token } = req.query;

  try {
    const result = await pool.query(`SELECT * FROM link_tokens WHERE token = $1 AND used_at IS NULL`, [token]);
    if (result.rows.length === 0) return res.status(403).send("Invalid or expired magic link.");

    const { discord_id, metadata } = result.rows[0];
    const customerId = metadata.customer_id;

    await pool.query(`UPDATE link_tokens SET used_at = now() WHERE token = $1`, [token]);

    // Set User to ACTIVE
    await pool.query(
      `UPDATE users 
       SET stripe_customer_id = $1, 
           subscription_status = 'active', 
           updated_at = now() 
       WHERE discord_id = $2`,
      [customerId, discord_id]
    );

    res.send("<h1>🎉 Account Linked!</h1><p>You may now close this window. Your Discord roles will update shortly.</p>");

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error.");
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", db: true }));
app.listen(process.env.PORT || 3000, () => console.log(`✅ Gatekeeper Backend Online`));
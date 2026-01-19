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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* -------------------- 1. BOT HANDOFF -------------------- */
// The Bot calls this to get the first link
app.post("/link/start", async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: "Missing discordId" });

  try {
    // Upsert User (Create if new, update if exists)
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

/* -------------------- 2. USER INTERFACE -------------------- */
// User lands here and sees the email form
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
          <p>Please enter your Stripe billing email.</p>
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

/* -------------------- 3. VERIFY & SHOW LINK (DEBUG MODE) -------------------- */
// Checks Stripe and shows the Magic Link on screen
app.post("/link/scan", async (req, res) => {
  const { token, email } = req.body;

  try {
    const tokenRes = await pool.query(`SELECT * FROM link_tokens WHERE token = $1`, [token]);
    if (tokenRes.rows.length === 0) return res.status(403).send("Session expired.");
    
    const discordId = tokenRes.rows[0].discord_id;

    // Search Stripe
    const customers = await stripe.customers.list({ email: email, limit: 1 });
    if (customers.data.length === 0) return res.send("❌ No Stripe customer found with that email.");
    
    const customer = customers.data[0];
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active' });
    
    if (subs.data.length === 0) return res.send("⚠️ Customer found, but no active subscription.");

    // Generate Magic Link
    await pool.query(`UPDATE link_tokens SET used_at = now() WHERE token = $1`, [token]);
    
    const magicToken = makeToken();
    await pool.query(
      `INSERT INTO link_tokens (token, discord_id, expires_at, metadata)
       VALUES ($1, $2, now() + interval '1 hour', $3)`,
      [magicToken, discordId, { type: 'email_verification', customer_id: customer.id }]
    );

    const magicLink = `${process.env.PUBLIC_BACKEND_URL}/link/finish?token=${magicToken}`;

    console.log(`🔗 MAGIC LINK for ${email}: ${magicLink}`);

    // --- DEBUG MODE: SHOW LINK ON SCREEN ---
    res.send(`
      <h2>✅ Verified!</h2>
      <p>We found your subscription.</p>
      <p><b>Click this link to finish linking your account:</b></p>
      <p><a href="${magicLink}">${magicLink}</a></p>
    `);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error verifying account.");
  }
});

/* -------------------- 4. FINISH -------------------- */
// User clicks the Magic Link to complete the process
app.get("/link/finish", async (req, res) => {
  const { token } = req.query;

  try {
    const result = await pool.query(`SELECT * FROM link_tokens WHERE token = $1 AND used_at IS NULL`, [token]);
    if (result.rows.length === 0) return res.status(403).send("Invalid link.");

    const { discord_id, metadata } = result.rows[0];
    const customerId = metadata.customer_id;

    await pool.query(`UPDATE link_tokens SET used_at = now() WHERE token = $1`, [token]);

    await pool.query(
      `UPDATE users 
       SET stripe_customer_id = $1, 
           subscription_status = 'active', 
           updated_at = now() 
       WHERE discord_id = $2`,
      [customerId, discord_id]
    );

    res.send("<h1>🎉 Account Linked!</h1><p>You may now close this window.</p>");

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error.");
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.listen(process.env.PORT || 3000, () => console.log(`✅ Server running`));
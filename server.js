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

// 1. Bot calls this to get a link
app.post("/link/start", async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: "Missing discordId" });

  try {
    await pool.query(
      \INSERT INTO users (discord_id, subscription_status, link_deadline)
       VALUES (\, 'unlinked', now() + interval '48 hours')
       ON CONFLICT (discord_id) DO UPDATE SET updated_at = now()\,
      [discordId]
    );

    const token = makeToken();
    await pool.query(
      \INSERT INTO link_tokens (token, discord_id, expires_at, metadata)
       VALUES (\, \, now() + interval '30 minutes', \)\,
      [token, discordId, { type: 'initial_handshake' }]
    );

    res.json({ url: \\/link?token=\\ });
  } catch (err) {
    console.error("Start error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 2. User sees HTML form
app.get("/link", async (req, res) => {
  const { token } = req.query;
  const result = await pool.query(
    \SELECT * FROM link_tokens WHERE token = \ AND expires_at > now() AND used_at IS NULL\,
    [token]
  );

  if (result.rows.length === 0) return res.status(403).send("Invalid or expired link.");

  res.send(\
    <html>
      <body style="font-family: sans-serif; max-width: 500px; margin: 50px auto; padding: 20px;">
        <h2>🔐 Verify Subscription</h2>
        <p>Enter your billing email to verify your active subscription.</p>
        <form action="/link/scan" method="POST">
          <input type="hidden" name="token" value="\" />
          <input type="email" name="email" required placeholder="billing@example.com" style="width: 100%; padding: 10px; margin-bottom: 10px;" />
          <button type="submit" style="padding: 10px 20px; background: #5865F2; color: white; border: none; cursor: pointer;">Check Subscription</button>
        </form>
      </body>
    </html>
  \);
});

// 3. Verify Email & Send Magic Link
app.post("/link/scan", async (req, res) => {
  const { token, email } = req.body;
  try {
    const tokenRes = await pool.query(\SELECT * FROM link_tokens WHERE token = \\, [token]);
    if (tokenRes.rows.length === 0) return res.status(403).send("Session expired.");
    
    const discordId = tokenRes.rows[0].discord_id;

    // Search Stripe
    const customers = await stripe.customers.list({ email: email, limit: 1 });
    if (customers.data.length === 0) return res.send("❌ No customer found with that email.");
    
    const customer = customers.data[0];
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active' });
    if (subs.data.length === 0) return res.send("⚠️ Customer found, but no active subscription.");

    // Generate Magic Link
    await pool.query(\UPDATE link_tokens SET used_at = now() WHERE token = \\, [token]);
    const magicToken = makeToken();
    await pool.query(
      \INSERT INTO link_tokens (token, discord_id, expires_at, metadata)
       VALUES (\, \, now() + interval '1 hour', \)\,
      [magicToken, discordId, { type: 'email_verification', customer_id: customer.id }]
    );

    const magicLink = \\/link/finish?token=\\;
    
    console.log(\🔗 MAGIC LINK for \: \\);

    res.send(\
      <h2>✅ Verified!</h2>
      <p>We found your subscription. Please check your email (or server logs) for the magic link to finish.</p>
    \);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error verifying.");
  }
});

// 4. Finish Link
app.get("/link/finish", async (req, res) => {
  const { token } = req.query;
  const result = await pool.query(\SELECT * FROM link_tokens WHERE token = \ AND used_at IS NULL\, [token]);
  if (result.rows.length === 0) return res.status(403).send("Invalid link.");

  const { discord_id, metadata } = result.rows[0];
  await pool.query(\UPDATE link_tokens SET used_at = now() WHERE token = \\, [token]);
  
  await pool.query(
    \UPDATE users SET stripe_customer_id = \, subscription_status = 'active', updated_at = now() WHERE discord_id = \\,
    [metadata.customer_id, discord_id]
  );

  res.send("<h1>🎉 Success!</h1><p>Your account is linked.</p>");
});

app.get("/health", (req, res) => res.json({ ok: true, db: true }));
app.listen(process.env.PORT || 3000, () => console.log("Gatekeeper online"));
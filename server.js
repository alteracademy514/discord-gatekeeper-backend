require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

app.post("/create-checkout-session", (req, res) => {
  res.json({ ok: true, got: req.body });
});


if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing (Railway Variables not set)");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("select 1 as ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (err) {
    res.status(500).json({ ok: false, db: false, error: err.message });
  }
});

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());

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
    console.error(err);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

app.get("/routes", (req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route) {
      const methods = Object.keys(m.route.methods).join(",").toUpperCase();
      routes.push(`${methods} ${m.route.path}`);
    }
  });
  res.json({ routes });
});



const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Backend running on ${port}`));

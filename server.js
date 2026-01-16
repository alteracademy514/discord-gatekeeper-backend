require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

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

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT UNIQUE,
      subscription_status TEXT NOT NULL DEFAULT 'unlinked',
      link_deadline TIMESTAMPTZ,
      billing_deadline TIMESTAMPTZ,
      linked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log("✅ users table ready");
})();


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Backend running on ${port}`));

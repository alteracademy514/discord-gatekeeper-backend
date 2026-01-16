require("dotenv").config();
const express = require("express");

const app = express();

app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Backend running on ${port}`));

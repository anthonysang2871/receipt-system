const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

const app = express();
app.use(helmet());
app.use(express.json());

// Rate limit creates
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      amount BIGINT NOT NULL,
      fee BIGINT DEFAULT 0,
      tax BIGINT DEFAULT 0,
      recipient TEXT,
      description TEXT,
      reference TEXT,
      email TEXT,
      status TEXT DEFAULT 'completed',
      hash TEXT NOT NULL
    )`);
  } catch (e) {
    console.error("DB init failed", e);
  }
})();

function computeHash(id) {
  const secret = process.env.RECEIPT_SECRET || "changeme";
  return crypto.createHmac("sha256", secret).update(id).digest("hex");
}

// Optional email transport
let transporter;
if (process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function getReceipt(id) {
  const r = await pool.query("SELECT * FROM receipts WHERE id=$1", [id]);
  return r.rows[0];
}

async function insertReceipt(r) {
  const sql = `INSERT INTO receipts (id, amount, fee, tax, recipient, description, reference, email, status, hash)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  const values = [
    r.id,
    r.amount,
    r.fee,
    r.tax,
    r.recipient,
    r.description,
    r.reference,
    r.email,
    r.status,
    r.hash,
  ];
  await pool.query(sql, values);
}

app.get("/health", (req, res) => res.json({ ok: true }));

// Create
app.post("/api/receipts", createLimiter, async (req, res) => {
  if (!process.env.API_KEY) {
    return res.status(500).json({ error: "API_KEY not configured" });
  }
  const key = req.header("x-api-key");
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const id = "TXN-" + uuidv4().slice(0, 8).toUpperCase();
    const receipt = {
      id,
      amount: parseInt(req.body.amount, 10),
      fee: parseInt(req.body.fee || 0, 10),
      tax: parseInt(req.body.tax || 0, 10),
      recipient: req.body.recipient || "",
      description: req.body.description || "",
      reference: req.body.reference || "",
      email: req.body.email || null,
      status: "completed",
    };

    if (Number.isNaN(receipt.amount)) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    receipt.hash = computeHash(receipt.id);

    // Persist
    await insertReceipt(receipt);

    // PDF
    const doc = new PDFDocument();
    const filePath = `/tmp/${receipt.id}.pdf`;
    doc.pipe(fs.createWriteStream(filePath));
    doc.fontSize(20).text("Payment Receipt");
    doc.moveDown();
    doc.fontSize(14).text(`Amount: $${(receipt.amount / 100).toFixed(2)}`);
    doc.text(`Recipient: ${receipt.recipient}`);
    doc.text(`Description: ${receipt.description}`);
    doc.text(`Reference: ${receipt.reference}`);
    doc.text(`Transaction ID: ${receipt.id}`);
    doc.end();

    // Email
    if (transporter && receipt.email) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: receipt.email,
        subject: "Your Receipt",
        text: `Receipt ID: ${receipt.id}\nVerify: ${req.protocol}://${req.get("host")}/verify/${receipt.id}/${receipt.hash}`,
        attachments: [{ path: filePath }],
      });
    }

    const payload = {
      receipt,
      receipt_url: `/r/${receipt.id}`,
      verify_url: `/verify/${receipt.id}/${receipt.hash}`,
    };

    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/receipts/:id", async (req, res) => {
  const receipt = await getReceipt(req.params.id);
  if (!receipt) return res.status(404).json({ error: "Not found" });
  res.json(receipt);
});

app.get("/r/:id", async (req, res) => {
  const receipt = await getReceipt(req.params.id);
  if (!receipt) return res.status(404).send("Not found");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Receipt</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#f6f9fc; padding:40px; }
          .card { max-width: 600px; margin:auto; background:#fff; padding:30px; border-radius:12px; box-shadow:0 2px 10px rgba(0,0,0,.05); }
          .amt { font-size:36px; font-weight:700; margin:20px 0; }
          table { width:100%; border-collapse:collapse; margin-top:20px; }
          td { padding:8px 0; border-bottom:1px solid #eee; }
          .footer { margin-top:30px; font-size:12px; color:#666; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Payment Receipt</h1>
          <div class="amt">$${(receipt.amount / 100).toFixed(2)}</div>
          <table>
            <tr><td>Recipient</td><td>${receipt.recipient}</td></tr>
            <tr><td>Description</td><td>${receipt.description}</td></tr>
            <tr><td>Reference</td><td>${receipt.reference}</td></tr>
            <tr><td>ID</td><td>${receipt.id}</td></tr>
            <tr><td>Status</td><td>${receipt.status}</td></tr>
          </table>
          <div class="footer">
            Verify: <a href="/verify/${receipt.id}/${receipt.hash}">/verify/${receipt.id}/${receipt.hash}</a><br />
            Issued by YOUR COMPANY. Not affiliated with Stripe.
          </div>
        </div>
      </body>
    </html>
  `);
});

app.get("/verify/:id/:hash", async (req, res) => {
  const receipt = await getReceipt(req.params.id);
  if (!receipt) return res.send("❌ Invalid");

  const expected = computeHash(receipt.id);
  if (expected !== req.params.hash) return res.send("❌ Invalid");

  res.send(`✅ Verified<br/>ID: ${receipt.id}<br/>Amount: $${(receipt.amount / 100).toFixed(2)}<br/>Status: ${receipt.status}`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`running on ${port}`));

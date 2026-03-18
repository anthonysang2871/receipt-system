const express = require("express");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

// In-memory store (upgrade: replace with Postgres)
const receipts = new Map();

// Optional email transport (only used if configured)
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

function hashReceipt(id, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(id)
    .digest("hex");
}

app.post("/api/receipts", async (req, res) => {
  const id = "TXN-" + uuidv4().slice(0, 8).toUpperCase();
  const receipt = {
    id,
    amount: req.body.amount,
    fee: req.body.fee || 0,
    tax: req.body.tax || 0,
    recipient: req.body.recipient,
    description: req.body.description,
    reference: req.body.reference,
    email: req.body.email,
    date: new Date().toISOString(),
    status: "completed",
  };

  receipts.set(id, receipt);

  // verification hash (upgrade: store in DB)
  const secret = process.env.RECEIPT_SECRET || "dev-secret";
  const verification_hash = hashReceipt(id, secret);

  // generate PDF
  const filePath = `/tmp/${id}.pdf`;
  const doc = new PDFDocument();
  doc.pipe(fs.createWriteStream(filePath));
  doc.fontSize(20).text("Payment Receipt");
  doc.moveDown();
  doc.fontSize(14).text(`Amount: $${(receipt.amount / 100).toFixed(2)}`);
  doc.text(`Recipient: ${receipt.recipient}`);
  doc.text(`Description: ${receipt.description}`);
  doc.text(`Reference: ${receipt.reference}`);
  doc.text(`Transaction ID: ${receipt.id}`);
  doc.text(`Verification Hash: ${verification_hash}`);
  doc.end();

  // send email if configured
  if (transporter && receipt.email) {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: receipt.email,
      subject: "Your Receipt",
      text: `Receipt ID: ${receipt.id}\nVerification: ${verification_hash}`,
      attachments: [{ path: filePath }],
    });
  }

  res.json({
    receipt,
    verification_hash,
    receipt_url: `/r/${id}`,
    verify_url: `/verify/${id}/${verification_hash}`,
  });
});

app.get("/api/receipts/:id", (req, res) => {
  const receipt = receipts.get(req.params.id);
  if (!receipt) return res.status(404).send("Not found");
  res.json(receipt);
});

app.get("/r/:id", (req, res) => {
  const r = receipts.get(req.params.id);
  if (!r) return res.send("Not found");

  res.send(`
    <h1>Payment Receipt</h1>
    <h2>$${(r.amount / 100).toFixed(2)}</h2>
    <p>Recipient: ${r.recipient}</p>
    <p>Description: ${r.description}</p>
    <p>Reference: ${r.reference}</p>
    <p>ID: ${r.id}</p>
  `);
});

app.get("/verify/:id/:hash", (req, res) => {
  const r = receipts.get(req.params.id);
  if (!r) return res.send("❌ Invalid receipt");

  const secret = process.env.RECEIPT_SECRET || "dev-secret";
  const expected = hashReceipt(req.params.id, secret);
  if (expected !== req.params.hash) return res.send("❌ Verification failed");

  res.send(`
    <h1>✅ Verified</h1>
    <p>ID: ${r.id}</p>
    <p>Amount: $${(r.amount / 100).toFixed(2)}</p>
  `);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});

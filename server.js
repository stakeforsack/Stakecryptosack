// server.js (UPDATED FINAL VERSION)

import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { connectDB, User, Transaction, Membership } from "./db.js";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
await connectDB();

// CONFIG ===========================
const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";
const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];
const isProd = process.env.NODE_ENV === "production";

// CORS =============================
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("CORS blocked: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.set("trust proxy", isProd ? 1 : 0);

// SESSION ==========================
app.use(
  session({
    secret: process.env.SESSION_SECRET || "your-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
      path: "/",
    },
  })
);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// AUTH MIDDLEWARE ===================
const needAuth = (req, res, next) => {
  if (!req.session?.userId)
    return res.status(401).json({ error: "Please login" });
  next();
};

// ADMIN MIDDLEWARE (FIXED)
function requireAdmin(req, res, next) {
  const key =
    req.headers["x-admin-key"] ||
    req.query.key ||
    req.query.admin_key;

  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized admin" });
  }
  next();
}

// HEALTH CHECK ======================
app.get("/api/health", (req, res) => res.json({ ok: true }));

// REGISTER ==========================
app.post("/api/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ error: "All fields required" });

    const exists = await User.findOne({
      $or: [{ email }, { username }],
    });
    if (exists) return res.status(400).json({ error: "User exists" });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({
      email,
      username,
      password: hash,
      balance: 0,
    });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    res.json({
      ok: true,
      user: { id: user._id, email, username },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message });
  }
});

// LOGIN =============================
app.post("/api/login", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const lookup = username || email;
    if (!lookup || !password)
      return res.status(400).json({ error: "Credentials missing" });

    const user = await User.findOne({
      $or: [{ email: lookup }, { username: lookup }],
    });
    if (!user) return res.status(401).json({ error: "Invalid login" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Invalid login" });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    res.json({
      ok: true,
      user: { id: user._id, username: user.username, email: user.email },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PROFILE ===========================
app.get("/api/profile", needAuth, async (req, res) => {
  const user = await User.findById(req.session.userId).select("-password");
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({ ok: true, user });
});

// LOGOUT ============================
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid", {
      path: "/",
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
    });
    res.json({ ok: true });
  });
});

// CREATE DEPOSIT (pending) ==========
app.post("/api/deposit", needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;

    if (!coin || !amount || amount <= 0)
      return res.status(400).json({ error: "Invalid deposit" });

    const tx = await Transaction.create({
      userId: req.session.userId,
      type: "DEPOSIT",
      coin,
      amount,
      status: "PENDING",
    });

    res.json({
      ok: true,
      txId: tx._id,
      coin,
      amount,
    });
  } catch (err) {
    console.error("Deposit error:", err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

// CHECK PAYMENT STATUS (NO AUTO CONFIRM)
app.post("/api/verify-payment", needAuth, async (req, res) => {
  const { txId } = req.body;

  const tx = await Transaction.findById(txId);
  if (!tx) return res.json({ status: "NOT_FOUND" });

  res.json({
    status: tx.status,
    coin: tx.coin,
    amount: tx.amount,
  });
});

// WITHDRAW ==========================
app.post("/api/withdraw", needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;

    if (!coin || !amount || amount <= 0)
      return res.status(400).json({ error: "Invalid withdrawal" });

    const user = await User.findById(req.session.userId);
    if (user.balance < amount)
      return res.status(400).json({ error: "Insufficient balance" });

    const tx = await Transaction.create({
      userId: user._id,
      type: "WITHDRAW",
      coin,
      amount,
      status: "PENDING",
    });

    res.json({ ok: true, txId: tx._id });
  } catch (err) {
    console.error("Withdraw error:", err);
    res.status(500).json({ error: "Withdraw failed" });
  }
});

// ========== ADMIN ENDPOINTS ==========

// ALL USERS
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const users = await User.find().select("-password");
  res.json({ ok: true, users });
});

// PENDING DEPOSITS
app.get("/api/admin/pending-deposits", requireAdmin, async (req, res) => {
  const pending = await Transaction.find({
    type: "DEPOSIT",
    status: "PENDING",
  }).populate("userId", "username email");
  res.json({ ok: true, pending });
});

// PENDING WITHDRAW
app.get("/api/admin/pending-withdraws", requireAdmin, async (req, res) => {
  const pending = await Transaction.find({
    type: "WITHDRAW",
    status: "PENDING",
  }).populate("userId", "username email");
  res.json({ ok: true, pending });
});

// ALL TRANSACTIONS
app.get("/api/admin/all-transactions", requireAdmin, async (req, res) => {
  const tx = await Transaction.find()
    .sort({ createdAt: -1 })
    .populate("userId", "username email");
  res.json({ ok: true, tx });
});

// APPROVE DEPOSIT ====================
app.post("/api/admin/approve-deposit", requireAdmin, async (req, res) => {
  try {
    const { txId } = req.body;

    const tx = await Transaction.findById(txId);
    if (!tx) return res.json({ error: "Not found" });

    tx.status = "CONFIRMED";
    await tx.save();

    const user = await User.findById(tx.userId);
    user.balance = (user.balance || 0) + tx.amount;
    await user.save();

    res.json({ ok: true });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// APPROVE WITHDRAW ===================
app.post("/api/admin/approve-withdraw", requireAdmin, async (req, res) => {
  try {
    const { txId, tx_hash } = req.body;

    const tx = await Transaction.findById(txId);
    if (!tx) return res.json({ error: "Not found" });

    tx.status = "CONFIRMED";
    tx.meta = { tx_hash };
    await tx.save();

    const user = await User.findById(tx.userId);
    user.balance -= tx.amount;
    if (user.balance < 0) user.balance = 0;
    await user.save();

    res.json({ ok: true });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ----------------------
// Decline transaction (Deposit or Withdraw)
// ----------------------
app.post("/api/admin/decline-transaction", requireAdmin, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });
    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    tx.status = "DECLINED";
    await tx.save();
    // NOTE: we don't credit/deduct balances when declining
    return res.json({ ok: true, message: "Transaction declined" });
  } catch (err) {
    console.error("Decline transaction error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// Get transaction history for a user (admin)
// ----------------------
app.get("/api/admin/user-transactions/:userId", requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const tx = await Transaction.find({ userId }).sort({ createdAt: -1 });
    return res.json({ ok: true, tx });
  } catch (err) {
    console.error("User transactions error:", err);
    res.status(500).json({ error: err.message });
  }
});


// API NOT FOUND ======================
app.use("/api/*", (req, res) =>
  res.status(404).json({ error: "API endpoint not found" })
);

// STATIC FALLBACK =====================
app.use((req, res) => {
  const file = req.path === "/" ? "/index.html" : req.path;
  res.sendFile(path.join(__dirname, "public", file));
});

// START SERVER ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);

export default app;

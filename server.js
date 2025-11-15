// server.js
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

// Config
const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";
const ALLOWED_ORIGINS = [FRONTEND_URL, "http://localhost:3000", "http://127.0.0.1:3000"];
const isProd = process.env.NODE_ENV === "production";

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("CORS blocked: " + origin));
  },
  credentials: true,
  methods: ["GET","POST","PUT","DELETE","OPTIONS"]
}));

app.set("trust proxy", isProd ? 1 : 0);

app.use(session({
  secret: process.env.SESSION_SECRET || "your-secret-key",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 24*60*60*1000,
    path: "/",
  },
}));

app.use((req,res,next)=>{ res.header("Access-Control-Allow-Credentials","true"); next(); });
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Auth middleware
const needAuth = (req, res, next) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: "Please login" });
  next();
};
const requireAdmin = (req, res, next) => {
  const key = req.header("x-admin-key") || req.query.admin_key || req.query.key;
  if (!key || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  next();
};

// Health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Register
app.post("/api/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) return res.status(400).json({ error: "All fields required" });
    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists) return res.status(400).json({ error: "User exists" });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, username, password: hash });
    req.session.userId = user._id.toString();
    req.session.username = user.username;
    return res.json({ ok: true, user: { id: user._id, username: user.username, email: user.email } });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const input = username || email;
    if (!input || !password) return res.status(400).json({ error: "Credentials required" });
    const user = await User.findOne({ $or: [{ username: input }, { email: input }] });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });
    req.session.userId = user._id.toString();
    req.session.username = user.username;
    res.json({ ok: true, user: { id: user._id, username: user.username, email: user.email } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Profile
app.get("/api/profile", needAuth, async (req, res) => {
  const user = await User.findById(req.session.userId).select("-password");
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json({ ok: true, user });
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid", { path: "/", httpOnly: true, sameSite: isProd ? "none" : "lax", secure: isProd });
    res.json({ ok: true });
  });
});

// Deposit (create pending)
app.post("/api/deposit", needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;
    if (!coin || !amount || amount <= 0) return res.status(400).json({ error: "Invalid deposit data" });
    const tx = await Transaction.create({ userId: req.session.userId, type: "DEPOSIT", coin, amount, status: "PENDING" });
    return res.json({ ok: true, txId: tx._id.toString(), coin, amount });
  } catch (err) {
    console.error("Deposit error:", err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

// Verify payment (do NOT auto-confirm)
app.post("/api/verify-payment", needAuth, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });
    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ status: "NOT_FOUND" });
    return res.json({ status: tx.status, coin: tx.coin, amount: tx.amount });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ error: "Could not verify payment" });
  }
});

// Withdraw request (pending)
app.post("/api/withdraw", needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;
    if (!coin || !amount || amount <= 0) return res.status(400).json({ error: "Invalid withdraw data" });
    const user = await User.findById(req.session.userId);
    const currentBalance = user.balance || 0;
    if (amount > currentBalance) return res.status(400).json({ error: "Insufficient balance" });
    const tx = await Transaction.create({ userId: req.session.userId, type: "WITHDRAW", coin, amount, status: "PENDING" });
    return res.json({ ok: true, txId: tx._id.toString() });
  } catch (err) {
    console.error("Withdraw error:", err);
    res.status(500).json({ error: "Withdraw failed" });
  }
});

// ===== Admin endpoints =====
// Pending deposits
app.get("/api/admin/pending-deposits", requireAdmin, async (req, res) => {
  const pending = await Transaction.find({ type: "DEPOSIT", status: "PENDING" }).sort({ createdAt: -1 });
  res.json({ ok: true, pending });
});

// Pending withdraws
app.get("/api/admin/pending-withdraws", requireAdmin, async (req, res) => {
  const pending = await Transaction.find({ type: "WITHDRAW", status: "PENDING" }).sort({ createdAt: -1 });
  res.json({ ok: true, pending });
});

// All transactions
app.get("/api/admin/all-transactions", requireAdmin, async (req, res) => {
  const tx = await Transaction.find().sort({ createdAt: -1 }).limit(1000);
  res.json({ ok: true, tx });
});

// Approve deposit (confirm + credit)
app.post("/api/admin/approve-deposit", requireAdmin, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });
    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (tx.type !== "DEPOSIT") return res.status(400).json({ error: "Not a deposit" });
    if (tx.status === "CONFIRMED") return res.json({ ok: true, message: "Already confirmed" });
    tx.status = "CONFIRMED";
    await tx.save();
    // credit user balance
    const user = await User.findById(tx.userId);
    if (user) { user.balance = (user.balance || 0) + tx.amount; await user.save(); }
    return res.json({ ok: true, txId: tx._id.toString() });
  } catch (err) {
    console.error("Approve deposit error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Approve withdraw (confirm + deduct)
app.post("/api/admin/approve-withdraw", requireAdmin, async (req, res) => {
  try {
    const { txId, tx_hash } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });
    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (tx.type !== "WITHDRAW") return res.status(400).json({ error: "Not a withdraw" });
    if (tx.status === "CONFIRMED") return res.json({ ok: true, message: "Already confirmed" });
    tx.status = "CONFIRMED";
    tx.meta = { ...(tx.meta || {}), tx_hash };
    await tx.save();
    // deduct user balance
    const user = await User.findById(tx.userId);
    if (user) { user.balance = (user.balance || 0) - tx.amount; if (user.balance < 0) user.balance = 0; await user.save(); }
    return res.json({ ok: true, txId: tx._id.toString() });
  } catch (err) {
    console.error("Approve withdraw error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Membership endpoints (user upgrade & admin grant)
app.post("/api/membership/upgrade", needAuth, async (req, res) => {
  try {
    const { tier } = req.body;
    const tiers = { V1:{daily:10,duration:5,bonus:50}, V2:{daily:20,duration:7,bonus:100}, V3:{daily:30,duration:10,bonus:150}, V4:{daily:50,duration:15,bonus:250}, V5:{daily:100,duration:30,bonus:500} };
    if (!tiers[tier]) return res.status(400).json({ error: "Invalid tier" });
    const t = tiers[tier];
    const m = await Membership.create({ userId: req.session.userId, tier, startDate: new Date(), durationDays: t.duration, dailyAmount: t.daily, bonusAtMonthEnd: t.bonus });
    return res.json({ ok: true, membership: m });
  } catch (err) {
    console.error("Membership upgrade error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/approve-membership", requireAdmin, async (req, res) => {
  try {
    const { userId, tier } = req.body;
    if (!userId || !tier) return res.status(400).json({ error: "userId & tier required" });
    const tiers = { V1:{daily:10,duration:5,bonus:50}, V2:{daily:20,duration:7,bonus:100}, V3:{daily:30,duration:10,bonus:150}, V4:{daily:50,duration:15,bonus:250}, V5:{daily:100,duration:30,bonus:500} };
    if (!tiers[tier]) return res.status(400).json({ error: "Invalid tier" });
    const t = tiers[tier];
    const m = await Membership.create({ userId, tier, startDate: new Date(), durationDays: t.duration, dailyAmount: t.daily, bonusAtMonthEnd: t.bonus });
    return res.json({ ok: true, membership: m });
  } catch (err) {
    console.error("Approve membership error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Cron payouts - must be called once per day by scheduler (admin header required)
app.post("/api/cron/payouts", requireAdmin, async (req, res) => {
  try {
    const memberships = await Membership.find({ status: "ACTIVE" });
    const results = [];
    for (const m of memberships) {
      if (m.lastPayout && new Date(m.lastPayout).toDateString() === new Date().toDateString()) {
        results.push({ membership: m._id, skipped: "already paid today" });
        continue;
      }
      if (m.daysPaid >= m.durationDays) { results.push({ membership: m._id, skipped: "completed" }); continue; }
      const tx = await Transaction.create({ userId: m.userId, type: "DEPOSIT", coin: "USD", amount: m.dailyAmount, status: "CONFIRMED" });
      const user = await User.findById(m.userId);
      if (user) { user.balance = (user.balance || 0) + m.dailyAmount; await user.save(); }
      m.daysPaid += 1; m.lastPayout = new Date();
      if (m.daysPaid >= m.durationDays) m.status = "COMPLETED";
      await m.save();
      results.push({ membership: m._id, txId: tx._id.toString() });
    }
    res.json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API 404
app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found" }));

// Serve static fallback
app.use((req, res) => {
  const filePath = req.path === "/" ? "/index.html" : req.path;
  res.sendFile(path.join(__dirname, "public", filePath));
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
export default app;

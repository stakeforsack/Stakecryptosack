// server.js (UPDATED to support per-coin balances: BTC, ETH, USDT, BNB, ADA)
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

// membership tiers config (keep synced with frontend)
const TIERS = {
  V1: { price: 51, daily: 10, duration: 5, bonus: 50 },
  V2: { price: 1498.5, daily: 100, duration: 7, bonus: 3000 },
  V3: { price: 3001, daily: 10000, duration: 10, bonus: 90000 },
  V4: { price: 29998.5, daily: 50000, duration: 15, bonus: 300000 },
  V5: { price: 50001, daily: 75000, duration: 30, bonus: 500000 },
};

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
  if (!req.session?.userId) return res.status(401).json({ error: "Please login" });
  next();
};

// ADMIN MIDDLEWARE
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key || req.query.admin_key;
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
    if (!email || !username || !password) return res.status(400).json({ error: "All fields required" });

    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists) return res.status(400).json({ error: "User exists" });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({
      email,
      username,
      password: hash,
      balances: { BTC:0, ETH:0, USDT:0, BNB:0, ADA:0, USD:0 }
    });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    res.json({ ok: true, user: { id: user._id, email, username } });
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
    if (!lookup || !password) return res.status(400).json({ error: "Credentials missing" });

    const user = await User.findOne({ $or: [{ email: lookup }, { username: lookup }] });
    if (!user) return res.status(401).json({ error: "Invalid login" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Invalid login" });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    res.json({ ok: true, user: { id: user._id, username: user.username, email: user.email } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PROFILE ===========================
app.get("/api/profile", needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });

    // recent txs (limit)
    const transactions = await Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(200);

    // membership (latest active or last)
    const membership = await Membership.findOne({ userId: user._id }).sort({ createdAt: -1 });

    res.json({
      ok: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        balances: user.balances || { BTC:0, ETH:0, USDT:0, BNB:0, ADA:0, USD:0 },
        membership: membership || null,
        createdAt: user.createdAt,
      },
      transactions,
    });
  } catch (err) {
    console.error("Profile error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ===============================
// CHART DATA API (CoinGecko Proxy)
// ===============================
app.get("/api/chart/:coin", async (req, res) => {
  try {
    const { coin } = req.params;
    const days = req.query.days || 30;

    const url = `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=${days}`;

    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!response.ok) {
      return res.status(400).json({ error: "Failed to fetch chart data" });
    }

    const data = await response.json();

    // only return necessary data (reduces size)
    res.json({
      prices: data.prices || [],
      market_caps: data.market_caps || [],
      total_volumes: data.total_volumes || []
    });

  } catch (err) {
    console.error("Chart API error:", err);
    res.status(500).json({ error: "Chart server error" });
  }
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
// Accepts optional membershipTier in body (marks tx.meta)
app.post("/api/deposit", needAuth, async (req, res) => {
  try {
    const { coin, amount, membershipTier } = req.body;

    if (!coin || !amount || amount <= 0) return res.status(400).json({ error: "Invalid deposit" });

    // validate allowed coins
    const ALLOWED = ["BTC","ETH","USDT","BNB","ADA"];
    if (!ALLOWED.includes(coin)) return res.status(400).json({ error: "Unsupported coin" });

    const meta = {};
    if (membershipTier) {
      meta.isMembership = true;
      meta.membershipTier = membershipTier; // e.g. "V1"
    }

    const tx = await Transaction.create({
      userId: req.session.userId,
      type: "DEPOSIT",
      coin,
      amount,
      status: "PENDING",
      meta,
    });

    res.json({ ok: true, txId: tx._id.toString(), coin, amount, meta });
  } catch (err) {
    console.error("Deposit error:", err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

// CHECK PAYMENT STATUS (NO AUTO CONFIRM)
app.post("/api/verify-payment", needAuth, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });
    const tx = await Transaction.findById(txId);
    if (!tx) return res.json({ status: "NOT_FOUND" });
    res.json({ status: tx.status, coin: tx.coin, amount: tx.amount, meta: tx.meta || {} });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ error: "Could not verify payment" });
  }
});

// WITHDRAW ==========================
app.post("/api/withdraw", needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;
    if (!coin || !amount || amount <= 0) return res.status(400).json({ error: "Invalid withdrawal" });

    const ALLOWED = ["BTC","ETH","USDT","BNB","ADA"];
    if (!ALLOWED.includes(coin)) return res.status(400).json({ error: "Unsupported coin" });

    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // ensure balances object exists
    user.balances = user.balances || { BTC:0, ETH:0, USDT:0, BNB:0, ADA:0, USD:0 };

    const currentBalance = Number(user.balances[coin] || 0);
    if (amount > currentBalance) return res.status(400).json({ error: "Insufficient balance" });

    const tx = await Transaction.create({ userId: user._id, type: "WITHDRAW", coin, amount, status: "PENDING" });
    res.json({ ok: true, txId: tx._id.toString() });
  } catch (err) {
    console.error("Withdraw error:", err);
    res.status(500).json({ error: "Withdraw failed" });
  }
});

// ========== ADMIN ENDPOINTS ==========

// ALL USERS
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select("-password");
    res.json({ ok: true, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PENDING DEPOSITS
app.get("/api/admin/pending-deposits", requireAdmin, async (req, res) => {
  try {
    const pending = await Transaction.find({ type: "DEPOSIT", status: "PENDING" }).populate("userId", "username email");
    res.json({ ok: true, pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PENDING WITHDRAW
app.get("/api/admin/pending-withdraws", requireAdmin, async (req, res) => {
  try {
    const pending = await Transaction.find({ type: "WITHDRAW", status: "PENDING" }).populate("userId", "username email");
    res.json({ ok: true, pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ALL TRANSACTIONS
app.get("/api/admin/all-transactions", requireAdmin, async (req, res) => {
  try {
    const tx = await Transaction.find().sort({ createdAt: -1 }).populate("userId", "username email");
    res.json({ ok: true, tx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// APPROVE DEPOSIT (handles membership activation)
app.post("/api/admin/approve-deposit", requireAdmin, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });

    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (tx.type !== "DEPOSIT") return res.status(400).json({ error: "Not a deposit" });
    if (tx.status === "CONFIRMED") return res.json({ ok: true, message: "Already confirmed" });

    // Confirm transaction
    tx.status = "CONFIRMED";
    await tx.save();

    // ensure user exists
    const user = await User.findById(tx.userId);
    if (!user) return res.status(404).json({ error: "User not found for tx" });

    // Ensure balances object
    user.balances = user.balances || { BTC:0, ETH:0, USDT:0, BNB:0, ADA:0, USD:0 };

    // Membership purchase?
    if (tx.meta && tx.meta.isMembership && tx.meta.membershipTier) {
      const tier = tx.meta.membershipTier;
      const tcfg = TIERS[tier];
      if (!tcfg) {
        console.warn("Unknown membership tier on tx:", tier);
        // fallback: credit as normal deposit to the coin balance
        user.balances[tx.coin] = (user.balances[tx.coin] || 0) + tx.amount;
        await user.save();
        return res.json({ ok: true, message: "Confirmed (unknown tier, credited as deposit)" });
      }

      // Create membership record
      await Membership.create({
        userId: tx.userId,
        tier,
        startDate: new Date(),
        status: "ACTIVE",
        durationDays: tcfg.duration,
        daysPaid: 0,
        dailyAmount: tcfg.daily,
        bonusAtMonthEnd: tcfg.bonus,
        bonusPaid: false,
      });

      // Optionally mark user as vip and save
      user.membership = tier;
      user.membershipActivatedAt = new Date();
      await user.save();

      return res.json({ ok: true, membershipActivated: true });
    }

    // Normal deposit -> credit user coin balance
    user.balances[tx.coin] = (user.balances[tx.coin] || 0) + tx.amount;
    await user.save();

    return res.json({ ok: true });
  } catch (err) {
    console.error("Approve deposit error:", err);
    res.status(500).json({ error: err.message });
  }
});

// APPROVE WITHDRAW ===================
app.post("/api/admin/approve-withdraw", requireAdmin, async (req, res) => {
  try {
    const { txId, tx_hash } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });

    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (tx.type !== "WITHDRAW") return res.status(400).json({ error: "Not a withdraw" });
    if (tx.status === "CONFIRMED") return res.json({ ok: true, message: "Already confirmed" });

    // ensure user
    const user = await User.findById(tx.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.balances = user.balances || { BTC:0, ETH:0, USDT:0, BNB:0, ADA:0, USD:0 };
    const current = Number(user.balances[tx.coin] || 0);
    if (tx.amount > current) {
      // Mark as declined or error (but we'll still mark as DECLINED to avoid negative)
      tx.status = "DECLINED";
      await tx.save();
      return res.status(400).json({ error: "Insufficient user balance to approve withdraw" });
    }

    tx.status = "CONFIRMED";
    tx.meta = { ...(tx.meta || {}), tx_hash };
    await tx.save();

    // deduct user coin balance
    user.balances[tx.coin] = current - tx.amount;
    await user.save();

    return res.json({ ok: true });
  } catch (err) {
    console.error("Approve withdraw error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Decline transaction (Deposit or Withdraw)
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

// Get transaction history for a user (admin)
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

// Cron payouts - call once per day (admin)
app.post("/api/cron/payouts", requireAdmin, async (req, res) => {
  try {
    const memberships = await Membership.find({ status: "ACTIVE" });
    const results = [];

    for (const m of memberships) {
      // skip if paid today
      if (m.lastPayout && new Date(m.lastPayout).toDateString() === new Date().toDateString()) {
        results.push({ membership: m._id.toString(), skipped: "already paid today" });
        continue;
      }

      if (m.daysPaid >= m.durationDays) {
        // if completed and bonus not paid -> pay bonus
        if (!m.bonusPaid) {
          const bonusAmt = m.bonusAtMonthEnd || 0;
          if (bonusAmt > 0) {
            const txBonus = await Transaction.create({
              userId: m.userId,
              type: "PAYOUT",
              coin: "USD",
              amount: bonusAmt,
              status: "CONFIRMED",
              meta: { reason: "membership_bonus", membershipId: m._id }
            });
            const u = await User.findById(m.userId);
            if (u) { u.balances = u.balances || { BTC:0, ETH:0, USDT:0, BNB:0, ADA:0, USD:0 }; u.balances.USD = (u.balances.USD || 0) + bonusAmt; await u.save(); }
            m.bonusPaid = true;
            await m.save();
            results.push({ membership: m._id.toString(), bonusTx: txBonus._id.toString() });
          }
        } else {
          results.push({ membership: m._id.toString(), skipped: "completed & bonus paid" });
        }
        continue;
      }

      // pay daily amount (to USD)
      const daily = m.dailyAmount || 0;
      if (daily <= 0) { results.push({ membership: m._id.toString(), skipped: "no daily amount configured" }); continue; }

      const txDaily = await Transaction.create({
        userId: m.userId,
        type: "MEMBERSHIP_PAYOUT",
        coin: "USD",
        amount: daily,
        status: "CONFIRMED",
        meta: { membershipId: m._id }
      });
      const user = await User.findById(m.userId);
      if (user) { user.balances = user.balances || { BTC:0, ETH:0, USDT:0, BNB:0, ADA:0, USD:0 }; user.balances.USD = (user.balances.USD || 0) + daily; await user.save(); }

      m.daysPaid = (m.daysPaid || 0) + 1;
      m.lastPayout = new Date();
      if (m.daysPaid >= m.durationDays) {
        m.status = "COMPLETED";
      }
      await m.save();

      results.push({ membership: m._id.toString(), txId: txDaily._id.toString(), daysPaid: m.daysPaid });
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error("Cron payouts error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API NOT FOUND ======================
app.use("/api/*", (req, res) => res.status(404).json({ error: "API endpoint not found" }));

// STATIC FALLBACK =====================
app.use((req, res) => {
  const file = req.path === "/" ? "/index.html" : req.path;
  res.sendFile(path.join(__dirname, "public", file));
});

// START SERVER ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

export default app;

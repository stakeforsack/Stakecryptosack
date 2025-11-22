// server.js
// Production-ready server with per-coin balances, Mongo session store, profile normalization,
// /api/balances endpoint, deposit/withdraw/membership flows and admin endpoints.
// Node ESM expected (type: module in package.json).

import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import MongoStore from "connect-mongo";
import { connectDB, User, Transaction, Membership } from "./db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// connect to MongoDB (db.js exports connectDB + models)
await connectDB();

const app = express();

// ---------------- CONFIG ----------------
const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";
const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
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

// ---------------- CORS ----------------
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      console.warn("Blocked CORS origin:", origin);
      return callback(new Error("CORS blocked: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.set("trust proxy", isProd ? 1 : 0);

// ---------------- Sessions ----------------
let sessionStore = null;
if (process.env.MONGO_URI) {
  sessionStore = MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: "sessions",
  });
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || "your-secret-key",
    store: sessionStore || undefined,
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

// ---------------- Auth middleware ----------------
const needAuth = (req, res, next) => {
  if (!req.session?.userId) return res.status(401).json({ error: "Please login" });
  next();
};

// ---------------- Admin middleware ----------------
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key || req.query.admin_key;
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized admin" });
  }
  next();
}

// ---------------- Health ----------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---------------- Register ----------------
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
      balances: { BTC: 0, ETH: 0, USDT: 0, BNB: 0, ADA: 0, USD: 0 },
    });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    res.json({ ok: true, user: { id: user._id, email, username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Login ----------------
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Profile ----------------
app.get("/api/profile", needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });

    const transactions = await Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(200);
    const membership = await Membership.findOne({ userId: user._id }).sort({ createdAt: -1 });

    if (!user.balances) {
      const legacy = Number(user.balance || 0) || 0;
      user.balances = { BTC: 0, ETH: 0, USDT: legacy, BNB: 0, ADA: 0, USD: 0 };
      user.save().catch(() => {});
    }

    res.json({
      ok: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        balances: user.balances,
        membership: membership || null,
        createdAt: user.createdAt,
      },
      transactions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- GET /api/balances ----------------
app.get("/api/balances", needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select("balances balance");
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.balances) {
      const legacy = Number(user.balance || 0) || 0;
      user.balances = { BTC: 0, ETH: 0, USDT: legacy, BNB: 0, ADA: 0, USD: 0 };
      user.save().catch(() => {});
    }

    return res.json({ ok: true, balances: user.balances });
  } catch (err) {
    return res.status(500).json({ error: "Could not load balances" });
  }
});

// ---------------- NEW: GET /api/total-usd (FIXES BALANCE DIFFERENCE) ----------------
app.get("/api/total-usd", needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select("balances").lean();
    if (!user || !user.balances) {
      return res.json({ ok: true, totalUSD: 0, breakdown: {} });
    }

    const balances = user.balances;
    const coins = ["BTC", "ETH", "BNB", "ADA", "USDT", "USD"];
    const cgMap = {
      BTC: "bitcoin",
      ETH: "ethereum",
      BNB: "binancecoin",
      ADA: "cardano",
      USDT: "tether",
    };

    const url =
      "https://api.coingecko.com/api/v3/simple/price?ids=" +
      Object.values(cgMap).join(",") +
      "&vs_currencies=usd";

    const priceRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const prices = await priceRes.json();

    let totalUSD = 0;
    let breakdown = {};

    for (const coin of coins) {
      const amount = Number(balances[coin] || 0);
      if (amount <= 0) continue;

      let usdValue = 0;

      if (coin === "USD") usdValue = amount;
      else if (coin === "USDT") usdValue = amount;
      else {
        const cgId = cgMap[coin];
        const rate = prices[cgId]?.usd || 0;
        usdValue = amount * rate;
      }

      breakdown[coin] = Number(usdValue.toFixed(6));
      totalUSD += usdValue;
    }

    res.json({
      ok: true,
      totalUSD: Number(totalUSD.toFixed(6)),
      breakdown,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Failed to calculate total USD" });
  }
});

// ------------------------------------------------------------------------------------
// (Remaining admin sections + payout cron remain unchanged from your server.js)
// ------------------------------------------------------------------------------------

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select("-password");
    res.json({ ok: true, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/pending-deposits", requireAdmin, async (req, res) => {
  try {
    const pending = await Transaction.find({ type: "DEPOSIT", status: "PENDING" }).populate("userId", "username email");
    res.json({ ok: true, pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/pending-withdraws", requireAdmin, async (req, res) => {
  try {
    const pending = await Transaction.find({ type: "WITHDRAW", status: "PENDING" }).populate("userId", "username email");
    res.json({ ok: true, pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/all-transactions", requireAdmin, async (req, res) => {
  try {
    const tx = await Transaction.find().sort({ createdAt: -1 }).populate("userId", "username email");
    res.json({ ok: true, tx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

    const user = await User.findById(tx.userId);
    if (!user) return res.status(404).json({ error: "User not found for tx" });

    user.balances = user.balances || { BTC: 0, ETH: 0, USDT: 0, BNB: 0, ADA: 0, USD: 0 };

    if (tx.meta?.isMembership && tx.meta.membershipTier) {
      const tcfg = TIERS[tx.meta.membershipTier];
      if (!tcfg) {
        user.balances[tx.coin] += tx.amount;
        await user.save();
        return res.json({ ok: true, message: "Confirmed as normal deposit" });
      }

      await Membership.create({
        userId: tx.userId,
        tier: tx.meta.membershipTier,
        startDate: new Date(),
        status: "ACTIVE",
        durationDays: tcfg.duration,
        daysPaid: 0,
        dailyAmount: tcfg.daily,
        bonusAtMonthEnd: tcfg.bonus,
        bonusPaid: false,
      });

      user.membership = tx.meta.membershipTier;
      user.membershipActivatedAt = new Date();
      await user.save();
      return res.json({ ok: true, membershipActivated: true });
    }

    user.balances[tx.coin] += tx.amount;
    await user.save();

    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/approve-withdraw", requireAdmin, async (req, res) => {
  try {
    const { txId, tx_hash } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });

    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (tx.type !== "WITHDRAW") return res.status(400).json({ error: "Not a withdraw" });
    if (tx.status === "CONFIRMED") return res.json({ ok: true, message: "Already confirmed" });

    const user = await User.findById(tx.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const current = Number(user.balances[tx.coin] || 0);
    if (tx.amount > current) {
      tx.status = "DECLINED";
      await tx.save();
      return res.status(400).json({ error: "Insufficient user balance to approve withdraw" });
    }

    tx.status = "CONFIRMED";
    tx.meta = { ...(tx.meta || {}), tx_hash };
    await tx.save();

    user.balances[tx.coin] = current - tx.amount;
    await user.save();

    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/decline-transaction", requireAdmin, async (req, res) => {
  try {
    const { txId } = req.body;
    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    tx.status = "DECLINED";
    await tx.save();
    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- User transaction history (for frontend) ----------------
app.get("/api/transactions", needAuth, async (req, res) => {
  try {
    const tx = await Transaction.find({ userId: req.session.userId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ ok: true, transactions: tx });
  } catch (err) {
    console.error("Transactions load error:", err);
    res.status(500).json({ error: "Unable to load transactions" });
  }
});


// ---------------- Internal Transfer ----------------
app.post("/api/internal-transfer", needAuth, async (req, res) => {
  try {
    const { recipient, amount, coin } = req.body;

    if (!recipient || !amount || amount <= 0)
      return res.status(400).json({ error: "Invalid transfer" });

    const ALLOWED = ["BTC", "ETH", "USDT", "BNB", "ADA"];
    if (!ALLOWED.includes(coin))
      return res.status(400).json({ error: "Unsupported coin" });

    const sender = await User.findById(req.session.userId);
    if (!sender) return res.status(404).json({ error: "Sender not found" });

    sender.balances = sender.balances || {};
    const senderBalance = Number(sender.balances[coin] || 0);
    if (senderBalance < amount)
      return res.status(400).json({ error: "Insufficient balance" });

    const receiver = await User.findOne({ username: recipient });
    if (!receiver) return res.status(404).json({ error: "Recipient not found" });

    receiver.balances = receiver.balances || {};

    // Deduct from sender
    sender.balances[coin] = senderBalance - amount;

    // Credit to receiver
    receiver.balances[coin] = Number(receiver.balances[coin] || 0) + amount;

    await sender.save();
    await receiver.save();

    // Transaction logs
    await Transaction.create({
      userId: sender._id,
      type: "TRANSFER",
      coin,
      amount,
      status: "CONFIRMED",
      meta: { direction: "SENT", to: receiver.username }
    });

    await Transaction.create({
      userId: receiver._id,
      type: "TRANSFER",
      coin,
      amount,
      status: "CONFIRMED",
      meta: { direction: "RECEIVED", from: sender.username }
    });

    res.json({ ok: true, message: "Transfer successful" });

  } catch (err) {
    console.error("Internal transfer error:", err);
    res.status(500).json({ error: "Transfer failed" });
  }
});


// ---------------- Unknown API routes ----------------
app.use("/api/*", (req, res) => res.status(404).json({ error: "API endpoint not found" }));

// ---------------- Static fallback ----------------
app.use((req, res) => {
  const file = req.path === "/" ? "/index.html" : req.path;
  res.sendFile(path.join(__dirname, "public", file));
});

// ---------------- Start server ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

export default app;

// server.js
// Refactored server with robust, idempotent admin approve/decline logic.
// Node ESM expected (type: "module" in package.json)

import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import MongoStore from "connect-mongo";
import fetch from "node-fetch"; // If running Node >=18, you can remove this import and use global fetch.
import { connectDB, User, Transaction, Membership } from "./db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Connect DB
await connectDB();

const app = express();

// ---------------- Config ----------------
const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";
const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const isProd = process.env.NODE_ENV === "production";

// membership tiers (keep synced with frontend)
const TIERS = {
  V1: { price: 51, daily: 10, duration: 5, bonus: 50 },
  V2: { price: 1498.5, daily: 100, duration: 7, bonus: 3000 },
  V3: { price: 3001, daily: 10000, duration: 10, bonus: 90000 },
  V4: { price: 29998.5, daily: 50000, duration: 15, bonus: 300000 },
  V5: { price: 50001, daily: 75000, duration: 30, bonus: 500000 },
};

// ---------------- Middleware ----------------
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

// Sessions
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

// Auth middleware
const needAuth = (req, res, next) => {
  if (!req.session?.userId) return res.status(401).json({ error: "Please login" });
  next();
};

// Admin middleware
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key || req.query.admin_key;
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized admin" });
  }
  next();
}

// ---------------- Helpers ----------------
function defaultBalances() {
  // canonical balances keys (USDT used for stable ledger)
  return { BTC: 0, ETH: 0, USDT: 0, BNB: 0, ADA: 0 };
}

/**
 * ensureBalancesAndMigrateUSD(user)
 * - Ensures user.balances exists with canonical keys
 * - Migrates legacy balances.USD -> balances.USDT when present
 * - Saves the user document if changes were required
 */
async function ensureBalancesAndMigrateUSD(user) {
  let changed = false;
  if (!user.balances) {
    user.balances = defaultBalances();
    changed = true;
  } else {
    // If old top-level 'balance' exists (legacy), or balances.USD exists, migrate into USDT
    if (typeof user.balances.USD !== "undefined" && Number(user.balances.USD || 0) > 0) {
      const legacyUsd = Number(user.balances.USD || 0);
      user.balances.USDT = Number(user.balances.USDT || 0) + legacyUsd;
      user.balances.USD = 0;
      changed = true;
    }
    // ensure keys
    const defaults = defaultBalances();
    for (const k of Object.keys(defaults)) {
      if (typeof user.balances[k] === "undefined") {
        user.balances[k] = defaults[k];
        changed = true;
      }
    }
  }
  if (changed) {
    try {
      await user.save();
    } catch (e) {
      console.warn("Balance migration save failed:", e.message || e);
    }
  }
  return changed;
}

/**
 * Safe save helper to avoid unhandled rejections
 */
async function safeSave(doc) {
  try {
    await doc.save();
    return true;
  } catch (e) {
    console.error("save failed:", e);
    return false;
  }
}

/**
 * applyDeposit(tx, user)
 * - credits user's balance for tx.coin by tx.amount if not already applied
 * - sets tx.meta.applied = true and tx.status = 'CONFIRMED'
 */
async function applyDeposit(tx, user) {
  tx.meta = tx.meta || {};
  if (tx.meta.applied) {
    // already applied
    if (tx.status !== "CONFIRMED") tx.status = "CONFIRMED";
    await safeSave(tx);
    return { ok: true, message: "Already applied" };
  }

  user.balances = user.balances || defaultBalances();
  user.balances[tx.coin] = Number(user.balances[tx.coin] || 0) + Number(tx.amount || 0);

  tx.meta.applied = true;
  tx.status = "CONFIRMED";

  await Promise.all([safeSave(user), safeSave(tx)]);
  await Transaction.create({
    userId: user._id,
    type: "DEPOSIT", // log again as confirmed
    coin: tx.coin,
    amount: tx.amount,
    status: "CONFIRMED",
    meta: { note: "Admin applied deposit (approve)", originTx: tx._id }
  });

  return { ok: true, message: "Deposit applied" };
}

/**
 * revertDeposit(tx, user)
 * - reverses a previously applied deposit (tx.meta.applied === true)
 * - subtracts tx.amount from user's balance if possible
 * - sets tx.meta.applied = false and tx.status = 'DECLINED'
 */
async function revertDeposit(tx, user) {
  tx.meta = tx.meta || {};
  if (!tx.meta.applied) {
    tx.status = "DECLINED";
    await safeSave(tx);
    return { ok: true, message: "Not applied (nothing to revert)" };
  }

  const cur = Number(user.balances[tx.coin] || 0);
  const amt = Number(tx.amount || 0);

  if (cur < amt) {
    // Prevent accidental negative balances. Admin must resolve manually.
    return { ok: false, error: "User has insufficient balance to revert deposit" };
  }

  user.balances[tx.coin] = cur - amt;
  tx.meta.applied = false;
  tx.status = "DECLINED";

  await Promise.all([safeSave(user), safeSave(tx)]);
  await Transaction.create({
    userId: user._id,
    type: "DEPOSIT",
    coin: tx.coin,
    amount: -amt,
    status: "CONFIRMED",
    meta: { note: "Admin reverted deposit (decline)", originTx: tx._id }
  });

  return { ok: true, message: "Deposit reverted" };
}

/**
 * applyWithdraw(tx, user)
 * - when admin approves a withdraw, subtract amount from user (if not already applied)
 * - set tx.meta.applied = true and tx.status = 'CONFIRMED'
 */
async function applyWithdraw(tx, user) {
  tx.meta = tx.meta || {};
  if (tx.meta.applied) {
    if (tx.status !== "CONFIRMED") tx.status = "CONFIRMED";
    await safeSave(tx);
    return { ok: true, message: "Withdraw already applied" };
  }

  const cur = Number(user.balances[tx.coin] || 0);
  const amt = Number(tx.amount || 0);
  if (cur < amt) {
    return { ok: false, error: "Insufficient user balance to approve withdraw" };
  }

  user.balances[tx.coin] = cur - amt;
  tx.meta.applied = true;
  tx.status = "CONFIRMED";
  await Promise.all([safeSave(user), safeSave(tx)]);

  await Transaction.create({
    userId: user._id,
    type: "WITHDRAW",
    coin: tx.coin,
    amount: -amt,
    status: "CONFIRMED",
    meta: { note: "Admin approved withdraw (applied)", originTx: tx._id, tx_hash: tx.meta?.tx_hash || null }
  });

  return { ok: true, message: "Withdraw applied" };
}

/**
 * revertWithdraw(tx, user)
 * - if a previously approved withdraw is later declined, refund the user (if applied)
 */
async function revertWithdraw(tx, user) {
  tx.meta = tx.meta || {};
  if (!tx.meta.applied) {
    tx.status = "DECLINED";
    await safeSave(tx);
    return { ok: true, message: "Withdraw not applied (nothing to revert)" };
  }

  const amt = Number(tx.amount || 0);
  user.balances[tx.coin] = Number(user.balances[tx.coin] || 0) + amt;
  tx.meta.applied = false;
  tx.status = "DECLINED";
  await Promise.all([safeSave(user), safeSave(tx)]);

  await Transaction.create({
    userId: user._id,
    type: "WITHDRAW",
    coin: tx.coin,
    amount: amt,
    status: "CONFIRMED",
    meta: { note: "Admin reverted withdraw (decline)", originTx: tx._id }
  });

  return { ok: true, message: "Withdraw reverted and refunded" };
}

// ---------------- Health ----------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---------------- Auth Endpoints ----------------
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
      balances: defaultBalances(),
    });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    res.json({ ok: true, user: { id: user._id, email, username } });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ error: err.message });
  }
});

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
    console.error("login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Internal Transfer ----------------
app.post("/api/internal-transfer", needAuth, async (req, res) => {
  try {
    let { recipient, amount, coin } = req.body;
    recipient = (recipient || "").trim().toLowerCase();
    amount = Number(amount);
    coin = (coin || "").toUpperCase();

    if (!recipient) return res.status(400).json({ ok: false, error: "Recipient required" });
    if (!amount || amount <= 0) return res.status(400).json({ ok: false, error: "Invalid amount" });

    const ALLOWED_COINS = ["USDT", "BTC", "ETH", "BNB", "ADA"];
    if (!ALLOWED_COINS.includes(coin)) {
      return res.status(400).json({ ok: false, error: "Invalid coin type" });
    }

    const sender = await User.findById(req.session.userId);
    if (!sender) return res.status(404).json({ ok: false, error: "Sender not found" });

    sender.username = sender.username || "";
    await ensureBalancesAndMigrateUSD(sender);

    if (sender.username.toLowerCase() === recipient) {
      return res.status(400).json({ ok: false, error: "You cannot transfer to yourself" });
    }

    const receiver = await User.findOne({
      username: { $regex: new RegExp("^" + recipient + "$", "i") }
    });
    if (!receiver) return res.status(404).json({ ok: false, error: "Recipient not found" });

    await ensureBalancesAndMigrateUSD(receiver);

    const senderBal = Number(sender.balances[coin] || 0);
    if (senderBal < amount) {
      return res.status(400).json({ ok: false, error: "Insufficient balance" });
    }

    sender.balances[coin] = senderBal - amount;
    receiver.balances[coin] = Number(receiver.balances[coin] || 0) + amount;

    await Promise.all([safeSave(sender), safeSave(receiver)]);

    await Transaction.create({
      userId: sender._id,
      type: "TRANSFER",
      coin,
      amount,
      status: "CONFIRMED",
      meta: { direction: "SENT", to: receiver.username, toUserId: receiver._id }
    });

    await Transaction.create({
      userId: receiver._id,
      type: "TRANSFER",
      coin,
      amount,
      status: "CONFIRMED",
      meta: { direction: "RECEIVED", from: sender.username, fromUserId: sender._id }
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("internal-transfer error:", err);
    return res.status(500).json({ ok: false, error: "Server transfer crash" });
  }
});

// ---------------- Profile ----------------
app.get("/api/profile", needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });

    const transactions = await Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(200);
    const memberships = await Membership.find({ userId: user._id }).sort({ createdAt: -1 }).lean();

    await ensureBalancesAndMigrateUSD(user);

    res.json({
      ok: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        balances: user.balances,
        memberships: memberships || [],
        createdAt: user.createdAt,
      },
      transactions,
    });
  } catch (err) {
    console.error("profile error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Deposit ----------------
app.post("/api/deposit", needAuth, async (req, res) => {
  try {
    const { coin, amount, membershipTier } = req.body;
    if (!coin || !amount || amount <= 0) return res.status(400).json({ error: "Invalid deposit" });

    const ALLOWED = ["BTC", "ETH", "USDT", "BNB", "ADA"];
    if (!ALLOWED.includes(coin)) return res.status(400).json({ error: "Unsupported coin" });

    const meta = {};
    if (membershipTier) {
      meta.isMembership = true;
      meta.membershipTier = membershipTier;
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
    console.error("deposit error:", err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

// ---------------- Verify Payment ----------------
app.post("/api/verify-payment", needAuth, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });
    const tx = await Transaction.findById(txId);
    if (!tx) return res.json({ status: "NOT_FOUND" });
    res.json({ status: tx.status, coin: tx.coin, amount: tx.amount, meta: tx.meta || {} });
  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ error: "Could not verify payment" });
  }
});

// ---------------- Withdraw (user request -> pending) ----------------
app.post("/api/withdraw", needAuth, async (req, res) => {
  try {
    const { coin, amount, wallet } = req.body;
    if (!coin || !amount || amount <= 0) return res.status(400).json({ error: "Invalid withdrawal" });

    const ALLOWED = ["BTC", "ETH", "USDT", "BNB", "ADA"];
    if (!ALLOWED.includes(coin)) return res.status(400).json({ error: "Unsupported coin" });

    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    await ensureBalancesAndMigrateUSD(user);

    const currentBalance = Number(user.balances[coin] || 0);
    if (amount > currentBalance) return res.status(400).json({ error: "Insufficient balance" });

    const meta = {};
    if (wallet) meta.wallet = String(wallet);

    const tx = await Transaction.create({
      userId: user._id,
      type: "WITHDRAW",
      coin,
      amount,
      status: "PENDING",
      meta,
    });

    console.log("[WITHDRAW] Created withdrawal tx:", { txId: tx._id, userId: user._id, coin, amount });

    res.json({ ok: true, txId: tx._id.toString() });
  } catch (err) {
    console.error("withdraw error:", err);
    res.status(500).json({ error: "Withdraw failed" });
  }
});

// ---------------- GET Balances ----------------
app.get("/api/balances", needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select("balances");
    if (!user) return res.status(404).json({ error: "User not found" });

    await ensureBalancesAndMigrateUSD(user);

    return res.json({ ok: true, balances: user.balances });
  } catch (err) {
    console.error("balances error:", err);
    return res.status(500).json({ error: "Could not load balances" });
  }
});

// ---------------- total-usdt ----------------
app.get("/api/total-usdt", needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select("balances").lean();
    if (!user || !user.balances) return res.json({ ok: true, totalUSDT: 0, breakdown: {} });

    const balances = user.balances;
    const coins = ["BTC", "ETH", "BNB", "ADA", "USDT"];
    const cgMap = { BTC: "bitcoin", ETH: "ethereum", BNB: "binancecoin", ADA: "cardano", USDT: "tether" };

    const url = "https://api.coingecko.com/api/v3/simple/price?ids=" + Object.values(cgMap).join(",") + "&vs_currencies=usd";
    const priceRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const prices = await priceRes.json();

    let totalUSDT = 0;
    let breakdown = {};

    for (const coin of coins) {
      const amount = Number(balances[coin] || 0);
      if (amount <= 0) continue;

      let usdValue = 0;
      if (coin === "USDT") usdValue = amount;
      else {
        const cgId = cgMap[coin];
        const rate = prices[cgId]?.usd || 0;
        usdValue = amount * rate;
      }

      breakdown[coin] = Number(usdValue.toFixed(6));
      totalUSDT += usdValue;
    }

    res.json({ ok: true, totalUSDT: Number(totalUSDT.toFixed(6)), breakdown });
  } catch (err) {
    console.error("total-usdt error:", err);
    res.status(500).json({ ok: false, error: "Failed to calculate total USDT" });
  }
});

// alias for backwards compatibility
app.get("/api/total-usd", needAuth, async (req, res) => {
  // delegate: compute and return same shape as /api/total-usdt
  return app._router.handle(req, res, () => {}, "get", "/api/total-usdt");
});

// ---------------- Membership collect ----------------
app.post("/api/membership/collect", needAuth, async (req, res) => {
  try {
    const { membershipId } = req.body;
    if (!membershipId) return res.status(400).json({ error: "membershipId required" });

    const membership = await Membership.findById(membershipId);
    if (!membership) return res.status(404).json({ error: "Membership not found" });
    if (String(membership.userId) !== String(req.session.userId)) return res.status(403).json({ error: "Not your membership" });

    if (membership.status !== "ACTIVE") {
      if (membership.status === "COMPLETED") return res.status(400).json({ error: "Membership already completed" });
      return res.status(400).json({ error: "Membership not active" });
    }

    const now = new Date();
    if (membership.lastPayout) {
      const last = new Date(membership.lastPayout);
      const sameDay = last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate();
      if (sameDay) return res.status(400).json({ error: "Already collected today" });
    }

    const payout = Number(membership.dailyAmount || 0);
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    await ensureBalancesAndMigrateUSD(user);

    user.balances.USDT = Number(user.balances.USDT || 0) + payout;
    membership.daysPaid = (membership.daysPaid || 0) + 1;
    membership.lastPayout = new Date();

    if (membership.daysPaid >= membership.durationDays) {
      membership.status = "COMPLETED";
      if (membership.bonusAtMonthEnd && !membership.bonusPaid) {
        const bonus = Number(membership.bonusAtMonthEnd || 0);
        user.balances.USDT += bonus;
        membership.bonusPaid = true;
        await Transaction.create({
          userId: user._id,
          type: "MEMBERSHIP_PAYOUT",
          coin: "USDT",
          amount: bonus,
          status: "CONFIRMED",
          meta: { note: "Final membership bonus", membershipId: membership._id },
        });
      }
    }

    await Promise.all([membership.save(), user.save()]);

    await Transaction.create({
      userId: user._id,
      type: "MEMBERSHIP_PAYOUT",
      coin: "USDT",
      amount: payout,
      status: "CONFIRMED",
      meta: { membershipId: membership._id, day: membership.daysPaid }
    });

    const updated = await Membership.findById(membership._id).lean();
    return res.json({ ok: true, membership: updated, payout });
  } catch (err) {
    console.error("membership collect error:", err);
    return res.status(500).json({ error: "Collect failed" });
  }
});

// ---------------- Admin endpoints ----------------
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select("-password");
    res.json({ ok: true, users });
  } catch (err) {
    console.error("admin/users error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/pending-deposits", requireAdmin, async (req, res) => {
  try {
    const pending = await Transaction.find({ type: "DEPOSIT", status: "PENDING" }).populate("userId", "username email");
    res.json({ ok: true, pending });
  } catch (err) {
    console.error("admin/pending-deposits error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/pending-withdraws", requireAdmin, async (req, res) => {
  try {
    const pending = await Transaction.find({ type: "WITHDRAW", status: "PENDING" }).populate("userId", "username email");
    res.json({ ok: true, pending });
  } catch (err) {
    console.error("admin/pending-withdraws error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/all-transactions", requireAdmin, async (req, res) => {
  try {
    const tx = await Transaction.find().sort({ createdAt: -1 }).populate("userId", "username email");
    res.json({ ok: true, tx });
  } catch (err) {
    console.error("admin/all-transactions error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Helper to load tx and its user
async function loadTxAndUser(txId) {
  const tx = await Transaction.findById(txId);
  if (!tx) return { error: "Transaction not found" };
  const user = await User.findById(tx.userId);
  if (!user) return { error: "User not found for transaction", tx };
  await ensureBalancesAndMigrateUSD(user);
  return { tx, user };
}

// Approve deposit (idempotent & reversible)
app.post("/api/admin/approve-deposit", requireAdmin, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });

    const loaded = await loadTxAndUser(txId);
    if (loaded.error) return res.status(404).json({ error: loaded.error });

    const tx = loaded.tx;
    const user = loaded.user;

    if (tx.type !== "DEPOSIT") return res.status(400).json({ error: "Not a deposit" });

    // If tx already confirmed and applied -> noop
    if (tx.status === "CONFIRMED" && tx.meta?.applied) {
      return res.json({ ok: true, message: "Already confirmed and applied" });
    }

    // If tx.status === CONFIRMED but not applied (edge-case), attempt to apply
    const applyResult = await applyDeposit(tx, user);
    if (!applyResult.ok) return res.status(400).json({ error: applyResult.error || "Could not apply deposit" });

    return res.json({ ok: true, message: applyResult.message });
  } catch (err) {
    console.error("approve-deposit error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Approve withdraw (idempotent & reversible)
app.post("/api/admin/approve-withdraw", requireAdmin, async (req, res) => {
  try {
    const { txId, tx_hash } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });

    const loaded = await loadTxAndUser(txId);
    if (loaded.error) return res.status(404).json({ error: loaded.error });

    const tx = loaded.tx;
    const user = loaded.user;

    if (tx.type !== "WITHDRAW") return res.status(400).json({ error: "Not a withdraw" });

    // Attach tx_hash for bookkeeping
    tx.meta = tx.meta || {};
    if (tx_hash) tx.meta.tx_hash = tx_hash;

    // If already applied -> noop
    if (tx.meta.applied && tx.status === "CONFIRMED") {
      await safeSave(tx);
      return res.json({ ok: true, message: "Withdraw already approved/applied" });
    }

    const applyResult = await applyWithdraw(tx, user);
    if (!applyResult.ok) return res.status(400).json({ error: applyResult.error || "Could not apply withdraw" });

    return res.json({ ok: true, message: applyResult.message });
  } catch (err) {
    console.error("approve-withdraw error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Decline transaction (works for DEPOSIT or WITHDRAW; if already CONFIRMED and applied -> revert)
app.post("/api/admin/decline-transaction", requireAdmin, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: "txId required" });

    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    const user = await User.findById(tx.userId);
    if (!user) return res.status(404).json({ error: "User not found for tx" });

    await ensureBalancesAndMigrateUSD(user);

    // If type is DEPOSIT
    if (tx.type === "DEPOSIT") {
      // if deposit was applied earlier -> revert
      if (tx.meta?.applied) {
        const revert = await revertDeposit(tx, user);
        if (!revert.ok) return res.status(400).json({ error: revert.error || "Could not revert deposit" });
        return res.json({ ok: true, message: revert.message });
      }
      // otherwise simply mark declined
      tx.status = "DECLINED";
      await safeSave(tx);
      return res.json({ ok: true, message: "Deposit marked declined" });
    }

    // If type is WITHDRAW
    if (tx.type === "WITHDRAW") {
      // if withdraw was applied earlier -> revert (refund)
      if (tx.meta?.applied) {
        const revert = await revertWithdraw(tx, user);
        if (!revert.ok) return res.status(400).json({ error: revert.error || "Could not revert withdraw" });
        return res.json({ ok: true, message: revert.message });
      }
      tx.status = "DECLINED";
      await safeSave(tx);
      return res.json({ ok: true, message: "Withdraw marked declined" });
    }

    // For other tx types (TRANSFER, etc.) just mark declined
    tx.status = "DECLINED";
    await safeSave(tx);
    return res.json({ ok: true, message: "Transaction marked declined" });
  } catch (err) {
    console.error("decline-transaction error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Admin helper: get pending deposits/withdraws already implemented above.
// Additional admin endpoints used by frontend/admin UI:
app.get("/api/admin/all-memberships", requireAdmin, async (req, res) => {
  try {
    const memberships = await Membership.find().sort({ createdAt: -1 }).populate("userId", "username email");
    res.json({ ok: true, memberships });
  } catch (err) {
    console.error("admin/all-memberships error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Optional: fetch user's transactions (admin)
app.get("/api/admin/user-transactions/:userId", requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const tx = await Transaction.find({ userId }).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, transactions: tx });
  } catch (err) {
    console.error("admin/user-transactions error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- User Transactions (frontend) ----------------
app.get("/api/transactions", needAuth, async (req, res) => {
  try {
    const tx = await Transaction.find({ userId: req.session.userId }).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, transactions: tx });
  } catch (err) {
    console.error("transactions error:", err);
    res.status(500).json({ error: "Unable to load transactions" });
  }
});

// ---------------- Logout ----------------
app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("logout error:", err);
      return res.status(500).json({ error: "Logout failed" });
    }
    res.clearCookie("connect.sid", {
      path: "/",
      httpOnly: true,
      sameSite: "none",
      secure: true
    });
    return res.json({ ok: true });
  });
});

// ---------------- Unknown api ---------------
app.use("/api/*", (req, res) => res.status(404).json({ error: "API endpoint not found" }));

// ---------------- Static fallback ----------------
app.use((req, res) => {
  const file = req.path === "/" ? "/index.html" : req.path;
  res.sendFile(path.join(__dirname, "public", file));
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

export default app;

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
  V1: { price: 51, daily: 14, duration: 5, bonus: 10 },
  V2: { price: 150, daily: 20, duration: 10, bonus: 25 },
  V3: { price: 1200, daily: 90, duration: 20, bonus: 100 },
  V4: { price: 3000, daily: 200, duration: 20, bonus: 240 },
  V5: { price: 10000, daily: 750, duration: 15, bonus: 500 },
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

// ---------------- Helpers ----------------
function defaultBalances() {
  // USD removed — using USDT as stablecoin ledger
  return { BTC: 0, ETH: 0, USDT: 0, BNB: 0, ADA: 0 };
}

/**
 * ensureBalances(user)
 * - makes sure user.balances exists and migrates any legacy USD into USDT.
 * - returns true if migration performed (saved), false otherwise.
 */
async function ensureBalancesAndMigrateUSD(user) {
  let changed = false;
  if (!user.balances) {
    user.balances = defaultBalances();
    changed = true;
  } else {
    // if legacy USD field exists (from older schema), migrate it into USDT
    // and remove/zero the USD value (we won't persist USD field in new balances, but some docs may have it)
    if (typeof user.balances.USD !== "undefined" && Number(user.balances.USD || 0) > 0) {
      const legacyUsd = Number(user.balances.USD || 0);
      user.balances.USDT = Number(user.balances.USDT || 0) + legacyUsd;
      user.balances.USD = 0;
      changed = true;
    }
    // ensure all expected coin keys exist
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
      // continue; don't crash on save failure
      console.warn("Balance migration save failed:", e.message || e);
    }
  }
  return changed;
}

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
      balances: defaultBalances(),
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


// ---------------- Internal Transfer (FULL FIX) ----------------
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

    // Case-insensitive username search
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

    await sender.save();
    await receiver.save();

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
    console.error("🔥 INTERNAL TRANSFER ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server transfer crash" });
  }
});



// ---------------- Profile (now returns memberships array) ----------------
app.get("/api/profile", needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });

    const transactions = await Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(200);
    // fetch all memberships for the user (most recent first)
    const memberships = await Membership.find({ userId: user._id }).sort({ createdAt: -1 }).lean();

    // ensure balances exist and migrate any USD => USDT
    await ensureBalancesAndMigrateUSD(user);

    res.json({
      ok: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        balances: user.balances,
        memberships: memberships || [],   // <-- array of memberships
        createdAt: user.createdAt,
      },
      transactions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Create deposit (for membership & normal deposit) ----------------
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
    console.error("Deposit error:", err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

// ---------------- Verify payment status ----------------
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

// ---------------- Withdraw request (creates pending withdraw tx) ----------------
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
    console.error("Withdraw error:", err);
    res.status(500).json({ error: "Withdraw failed" });
  }
});

// ---------------- GET /api/balances ----------------
app.get("/api/balances", needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select("balances");
    if (!user) return res.status(404).json({ error: "User not found" });

    await ensureBalancesAndMigrateUSD(user);

    return res.json({ ok: true, balances: user.balances });
  } catch (err) {
    return res.status(500).json({ error: "Could not load balances" });
  }
});

// ---------------- NEW: GET /api/total-usdt ----------------
// returns the total across coins converted to USD equivalent (but expressed as USDT)
// Breakdown contains per-coin USD-equivalent values (under coin keys).
app.get("/api/total-usdt", needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select("balances").lean();
    if (!user || !user.balances) {
      return res.json({ ok: true, totalUSDT: 0, breakdown: {} });
    }

    const balances = user.balances;
    const coins = ["BTC", "ETH", "BNB", "ADA", "USDT"];
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

    res.json({
      ok: true,
      totalUSDT: Number(totalUSDT.toFixed(6)),
      breakdown,
    });
  } catch (err) {
    console.error("total-usdt error:", err);
    res.status(500).json({ ok: false, error: "Failed to calculate total USDT" });
  }
});

// keep alias for backwards compatibility (old frontends hitting /api/total-usd will continue working)
app.get("/api/total-usd", needAuth, async (req, res) => {
  // Delegate to /api/total-usdt behavior
  return app._router.handle(req, res, () => {}, "get", "/api/total-usdt");
});

// ---------------- DAILY MEMBERSHIP COLLECT (now per membershipId) ----------------
app.post("/api/membership/collect", needAuth, async (req, res) => {
  try {
    const { membershipId } = req.body;

    if (!membershipId) return res.status(400).json({ error: "membershipId required" });

    const membership = await Membership.findById(membershipId);
    if (!membership) return res.status(404).json({ error: "Membership not found" });
    if (String(membership.userId) !== String(req.session.userId)) return res.status(403).json({ error: "Not your membership" });

    if (membership.status !== "ACTIVE") {
      // if already completed, return helpful message
      if (membership.status === "COMPLETED") return res.status(400).json({ error: "Membership already completed" });
      return res.status(400).json({ error: "Membership not active" });
    }

    // Already collected today?
    const now = new Date();
    if (membership.lastPayout) {
      const last = new Date(membership.lastPayout);
      const sameDay =
        last.getFullYear() === now.getFullYear() &&
        last.getMonth() === now.getMonth() &&
        last.getDate() === now.getDate();
      if (sameDay)
        return res.status(400).json({ error: "Already collected today" });
    }

    const payout = Number(membership.dailyAmount || 0);

    // get user
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // ensure balances exist and migrate if needed
    await ensureBalancesAndMigrateUSD(user);

    // credit USDT only (removed USD ledger)
    user.balances.USDT = Number(user.balances.USDT || 0) + payout;

    // update membership
    membership.daysPaid = (membership.daysPaid || 0) + 1;
    membership.lastPayout = new Date();

    // completion + bonus — each membership gets its own bonus
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

    // save
    await membership.save();
    await user.save();

    // log daily payout (USDT)
    await Transaction.create({
      userId: user._id,
      type: "MEMBERSHIP_PAYOUT",
      coin: "USDT",
      amount: payout,
      status: "CONFIRMED",
      meta: {
        membershipId: membership._id,
        day: membership.daysPaid
      }
    });

    // return updated membership
    const updated = await Membership.findById(membership._id).lean();
    return res.json({ ok: true, membership: updated, payout });

  } catch (err) {
    console.error("Collect error:", err);
    return res.status(500).json({ error: "Collect failed" });
  }
});

// ------------------------------------------------------------------------------------
// Admin + Transactions
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
    console.log("[ADMIN] Pending withdraws found:", pending.length);
    res.json({ ok: true, pending });
  } catch (err) {
    console.error("Pending withdraws error:", err);
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

    await ensureBalancesAndMigrateUSD(user);

    if (tx.meta?.isMembership && tx.meta.membershipTier) {
      const tcfg = TIERS[tx.meta.membershipTier];
      if (!tcfg) {
        // fallback to normal deposit
        user.balances[tx.coin] = (user.balances[tx.coin] || 0) + tx.amount;
        await user.save();
        return res.json({ ok: true, message: "Confirmed as normal deposit (unknown tier)" });
      }

      // Prevent duplicate ACTIVE membership of same tier
      const existingActive = await Membership.findOne({
        userId: tx.userId,
        tier: tx.meta.membershipTier,
        status: "ACTIVE"
      });

      if (existingActive) {
        // credit as normal deposit instead of creating duplicate membership
        user.balances[tx.coin] = (user.balances[tx.coin] || 0) + tx.amount;
        await user.save();
        return res.json({ ok: true, message: "Existing active membership of same tier — credited as normal deposit" });
      }

      // create membership record
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

      // keep legacy single field if present (non-blocking). Not relied upon by frontend.
      user.membership = tx.meta.membershipTier;
      user.membershipActivatedAt = new Date();
      await user.save();
      return res.json({ ok: true, membershipActivated: true });
    }

    user.balances[tx.coin] = (user.balances[tx.coin] || 0) + tx.amount;
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

    await ensureBalancesAndMigrateUSD(user);

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

// ---------------- Logout ----------------
app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
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

// ---------------- Chart Data (for Trade page) ----------------
app.get("/api/chart/:coin", async (req, res) => {
  try {
    const { coin } = req.params;
    const days = req.query.days || 30;

    // build CoinGecko request
    const url = `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=${days}`;

    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const data = await response.json();

    if (!data || !data.prices) {
      return res.status(500).json({ error: "Chart data unavailable" });
    }

    return res.json({
      ok: true,
      prices: data.prices
    });

  } catch (err) {
    console.error("Chart API Error:", err);
    return res.status(500).json({ error: "Chart fetch failed" });
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

// server.updated.js
// Based on your server.fixed.js with added endpoints:
// - GET /api/balance?coin=COIN  -> returns per-coin balance
// - GET /api/balances           -> returns object of balances (already present)
// - GET /api/total-balance      -> returns total USD value (converts per-coin balances using CoinGecko)
// - price cache to avoid hitting CoinGecko repeatedly

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

await connectDB();

const app = express();

// CONFIG ===========================
const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";
const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const isProd = process.env.NODE_ENV === "production";

// membership tiers config
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
      console.warn("Blocked CORS origin:", origin);
      return callback(new Error("CORS blocked: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.set("trust proxy", isProd ? 1 : 0);

let sessionStore = null;
if (process.env.MONGO_URI) {
  sessionStore = MongoStore.create({ mongoUrl: process.env.MONGO_URI, collectionName: 'sessions' });
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

// AUTH MIDDLEWARE
const needAuth = (req, res, next) => {
  if (!req.session?.userId) return res.status(401).json({ error: "Please login" });
  next();
};

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key || req.query.admin_key;
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized admin" });
  }
  next();
}

// ---------------- Price helper + cache ----------------
// Map coin symbols used in your DB to CoinGecko ids
const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  BNB: 'binancecoin',
  ADA: 'cardano',
  USDT: 'tether'
};

let priceCache = { ts: 0, data: {} };
const PRICE_TTL = 30 * 1000; // 30s cache

async function fetchPrices(symbols = Object.keys(COINGECKO_IDS)) {
  const now = Date.now();
  if (now - priceCache.ts < PRICE_TTL && Object.keys(priceCache.data).length) {
    return priceCache.data;
  }

  try {
    const ids = symbols.map(s => COINGECKO_IDS[s]).filter(Boolean).join(',');
    // if no ids (e.g. only USD) return trivial
    if (!ids) return {};
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error('CoinGecko fetch failed');
    const json = await resp.json();
    // map back to symbols
    const out = {};
    for (const sym of symbols) {
      const id = COINGECKO_IDS[sym];
      if (!id) {
        // USDT => assume 1
        out[sym] = sym === 'USDT' ? 1 : 0;
        continue;
      }
      out[sym] = Number(json[id]?.usd || 0);
    }
    priceCache = { ts: Date.now(), data: out };
    return out;
  } catch (err) {
    console.warn('Price fetch failed', err.message);
    // fall back to last cache if present
    return priceCache.data || {};
  }
}

// HEALTH
app.get('/api/health', (req, res) => res.json({ ok: true }));

// REGISTER / LOGIN (unchanged) ...
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
      balances: { BTC: 0, ETH: 0, USDT: 0, BNB: 0, ADA: 0, USD: 0 }
    });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    res.json({ ok: true, user: { id: user._id, email, username } });
  } catch (err) {
    console.error("Register error:", err);
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
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PROFILE: normalize balances
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

// Quick balances endpoint (keeps backward compatibility)
app.get('/api/balances', needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('balances balance');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.balances) {
      const legacy = Number(user.balance || 0) || 0;
      user.balances = { BTC:0, ETH:0, USDT: legacy, BNB:0, ADA:0, USD:0 };
      user.save().catch(()=>{});
    }
    return res.json({ ok: true, balances: user.balances });
  } catch (e) {
    console.error('Balances error', e);
    return res.status(500).json({ error: 'Could not load balances' });
  }
});

// NEW: single coin balance endpoint: GET /api/balance?coin=BTC
app.get('/api/balance', needAuth, async (req, res) => {
  try {
    const coin = (req.query.coin || 'USDT').toUpperCase();
    const user = await User.findById(req.session.userId).select('balances balance');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.balances) {
      const legacy = Number(user.balance || 0) || 0;
      user.balances = { BTC:0, ETH:0, USDT: legacy, BNB:0, ADA:0, USD:0 };
      user.save().catch(()=>{});
    }
    if (coin === 'TOTAL' || coin === 'USD_TOTAL') {
      // compute total USD value
      const balances = user.balances || {};
      const symbols = Object.keys(balances).filter(k => k !== 'USD');
      const prices = await fetchPrices(symbols);
      let total = 0;
      const breakdown = {};
      for (const sym of symbols) {
        const amt = Number(balances[sym] || 0);
        const price = Number(prices[sym] || (sym === 'USDT' ? 1 : 0));
        const usdVal = amt * price;
        breakdown[sym] = { amount: amt, price, usd: usdVal };
        total += usdVal;
      }
      // include USD balance if present
      if (balances.USD) { total += Number(balances.USD || 0); breakdown.USD = { amount: balances.USD, price: 1, usd: Number(balances.USD||0) }; }
      return res.json({ ok: true, totalUSD: total, breakdown });
    }

    const val = Number((user.balances || {})[coin] || 0);
    return res.json({ ok: true, coin, balance: val });
  } catch (err) {
    console.error('Single balance error', err);
    res.status(500).json({ error: 'Could not load balance' });
  }
});

// Total-balance convenience endpoint
app.get('/api/total-balance', needAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('balances balance');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.balances) {
      const legacy = Number(user.balance || 0) || 0;
      user.balances = { BTC:0, ETH:0, USDT: legacy, BNB:0, ADA:0, USD:0 };
      user.save().catch(()=>{});
    }
    const balances = user.balances || {};
    const symbols = Object.keys(balances).filter(k => k !== 'USD');
    const prices = await fetchPrices(symbols);
    let total = 0;
    const breakdown = {};
    for (const sym of symbols) {
      const amt = Number(balances[sym] || 0);
      const price = Number(prices[sym] || (sym === 'USDT' ? 1 : 0));
      const usdVal = amt * price;
      breakdown[sym] = { amount: amt, price, usd: usdVal };
      total += usdVal;
    }
    if (balances.USD) { total += Number(balances.USD || 0); breakdown.USD = { amount: balances.USD, price:1, usd: Number(balances.USD||0) }; }
    return res.json({ ok: true, totalUSD: total, breakdown });
  } catch (e) {
    console.error('Total balance error', e);
    return res.status(500).json({ error: 'Could not compute total balance' });
  }
});

// DEPOSIT / VERIFY / WITHDRAW endpoints (unchanged logic from server.fixed)
app.post('/api/deposit', needAuth, async (req, res) => {
  try {
    const { coin, amount, membershipTier } = req.body;
    if (!coin || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid deposit' });
    const ALLOWED = ['BTC','ETH','USDT','BNB','ADA'];
    if (!ALLOWED.includes(coin)) return res.status(400).json({ error: 'Unsupported coin' });
    const meta = {};
    if (membershipTier) { meta.isMembership = true; meta.membershipTier = membershipTier; }
    const tx = await Transaction.create({ userId: req.session.userId, type: 'DEPOSIT', coin, amount, status: 'PENDING', meta });
    res.json({ ok: true, txId: tx._id.toString(), coin, amount, meta });
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Deposit failed' });
  }
});

app.post('/api/verify-payment', needAuth, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: 'txId required' });
    const tx = await Transaction.findById(txId);
    if (!tx) return res.json({ status: 'NOT_FOUND' });
    res.json({ status: tx.status, coin: tx.coin, amount: tx.amount, meta: tx.meta || {} });
  } catch (err) {
    console.error('Verify payment error:', err);
    res.status(500).json({ error: 'Could not verify payment' });
  }
});

app.post('/api/withdraw', needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;
    if (!coin || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid withdrawal' });
    const ALLOWED = ['BTC','ETH','USDT','BNB','ADA'];
    if (!ALLOWED.includes(coin)) return res.status(400).json({ error: 'Unsupported coin' });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.balances = user.balances || { BTC:0, ETH:0, USDT:0, BNB:0, ADA:0, USD:0 };
    const currentBalance = Number(user.balances[coin] || 0);
    if (amount > currentBalance) return res.status(400).json({ error: 'Insufficient balance' });
    const tx = await Transaction.create({ userId: user._id, type: 'WITHDRAW', coin, amount, status: 'PENDING' });
    res.json({ ok: true, txId: tx._1d?.toString?.() || tx._id.toString() });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ error: 'Withdraw failed' });
  }
});

// ADMIN endpoints and other code remain unchanged (not repeated here for brevity). You can copy them from your server.fixed.js.

// API NOT FOUND
app.use('/api/*', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

// STATIC FALLBACK
app.use((req, res) => {
  const file = req.path === '/' ? '/index.html' : req.path;
  res.sendFile(path.join(__dirname, 'public', file));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

export default app;

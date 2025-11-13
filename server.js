import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { connectDB, User, Transaction } from "./db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ✅ Frontend URL (replace with your Vercel domain)
// ✅ Frontend URL (replace with your Vercel domain)
const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";


// ✅ CORS
// ✅ CORS
app.use(
  cors({
    origin: [
      FRONTEND_URL, 
      "http://localhost:3000", 
      "http://localhost:5173"
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);


// ✅ Body parsers
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// ✅ Static files (for local testing)
app.use(express.static(path.join(__dirname, "public")));

// ✅ Trust proxy for Vercel HTTPS
app.set("trust proxy", 1);

// ✅ Session setup
app.use(
  session({
    secret: process.env.SESSION_SECRET || "your-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
      path: "/",
    },
  })
);

// ✅ Allow session cookies for cross-site requests
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});


// ✅ Auth middleware
const needAuth = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Please login" });
  }
  next();
};

// ✅ Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Server running fine ✅" });
});

// ✅ Register
app.post("/api/register", async (req, res) => {
  try {
    await connectDB();
    const { email, username, password } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ error: "All fields required" });

    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists) return res.status(400).json({ error: "Email or username already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, username, password: hashedPassword });
    await user.save();

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Session save failed" });
      res.json({ ok: true, user: { id: user._id, email, username } });
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ✅ Login
app.post("/api/login", async (req, res) => {
  try {
    await connectDB();
    const { username, email, password } = req.body;
    const userOrEmail = username || email;

    if (!userOrEmail || !password)
      return res.status(400).json({ error: "Username/Email and password required" });

    const user = await User.findOne({
      $or: [{ username: userOrEmail }, { email: userOrEmail }],
    });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Session save failed" });
      res.json({ ok: true, user: { id: user._id, username: user.username, email: user.email } });
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ✅ Profile (protected)
app.get("/api/profile", needAuth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.session.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });

    const userId = new mongoose.Types.ObjectId(req.session.userId);

    const deposits = await Transaction.aggregate([
      { $match: { userId, type: "DEPOSIT", status: "CONFIRMED" } },
      { $group: { _id: "$coin", total: { $sum: "$amount" } } },
    ]);

    const withdrawals = await Transaction.aggregate([
      { $match: { userId, type: "WITHDRAW", status: "CONFIRMED" } },
      { $group: { _id: "$coin", total: { $sum: "$amount" } } },
    ]);

    const balance = {};
    deposits.forEach((dep) => { balance[dep._id] = (balance[dep._id] || 0) + dep.total; });
    withdrawals.forEach((wit) => { balance[wit._id] = (balance[wit._id] || 0) - wit.total; });

    res.json({
      ok: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        vip: user.vip,
        createdAt: user.createdAt,
      },
      balance,
    });
  } catch (err) {
    console.error("Profile error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ✅ Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Logout failed" });
    res.clearCookie("connect.sid", {
      path: "/",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
    });
    res.json({ ok: true, message: "Logged out successfully" });
  });
});

// ✅ Deposit endpoint
app.post("/api/deposit", needAuth, async (req, res) => {
  try {
    await connectDB();
    const { coin, amount } = req.body;

    if (!coin || !amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid deposit data" });
    }

    const deposit = new Transaction({
      userId: req.session.userId,
      coin,
      amount,
      type: "DEPOSIT",
      status: "PENDING", // initially pending
      createdAt: new Date(),
    });

    await deposit.save();

    res.json({
      ok: true,
      txId: deposit._id.toString(),
      coin,
      amount,
    });
  } catch (err) {
    console.error("Deposit error:", err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

// ✅ Verify payment endpoint
app.post("/api/verify-payment", needAuth, async (req, res) => {
  try {
    await connectDB();
    const { txId } = req.body;
    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ status: "NOT_FOUND" });

    // For testing, we can auto-confirm the payment
    if (tx.status !== "CONFIRMED") {
      tx.status = "CONFIRMED";
      await tx.save();
    }

    res.json({ status: tx.status, coin: tx.coin, amount: tx.amount });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ error: "Could not verify payment" });
  }
});

// ✅ Withdraw endpoint (instant balance deduction)
app.post("/api/withdraw", needAuth, async (req, res) => {
  try {
    await connectDB();
    const { coin, amount } = req.body;

    if (!coin || !amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid withdraw data" });
    }

    const userId = new mongoose.Types.ObjectId(req.session.userId);

    // Fetch confirmed deposits and withdrawals
    const deposits = await Transaction.aggregate([
      { $match: { userId, type: "DEPOSIT", status: "CONFIRMED" } },
      { $group: { _id: "$coin", total: { $sum: "$amount" } } },
    ]);

    const withdrawals = await Transaction.aggregate([
      { $match: { userId, type: "WITHDRAW", status: "CONFIRMED" } },
      { $group: { _id: "$coin", total: { $sum: "$amount" } } },
    ]);

    // Calculate balance
    const balance = {};
    deposits.forEach((dep) => { balance[dep._id] = (balance[dep._id] || 0) + dep.total; });
    withdrawals.forEach((wit) => { balance[wit._id] = (balance[wit._id] || 0) - wit.total; });

    const currentBalance = balance[coin] || 0;

    if (amount > currentBalance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Record the withdrawal transaction and mark as CONFIRMED immediately
    const withdrawal = new Transaction({
      userId,
      coin,
      amount,
      type: "WITHDRAW",
      status: "CONFIRMED", // ✅ instantly confirm to deduct balance
      createdAt: new Date(),
    });

    await withdrawal.save();

    res.json({
      ok: true,
      message: `Withdrawal of ${amount} ${coin} successful.`,
      txId: withdrawal._id.toString(),
      coin,
      amount,
      newBalance: currentBalance - amount, // send updated balance
    });
  } catch (err) {
    console.error("Withdraw error:", err);
    res.status(500).json({ error: "Withdraw failed" });
  }
});


// ✅ Verify withdrawal endpoint
app.post("/api/verify-withdraw", needAuth, async (req, res) => {
  try {
    await connectDB();
    const { txId } = req.body;
    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ status: "NOT_FOUND" });

    if (tx.status !== "CONFIRMED") {
      tx.status = "CONFIRMED";
      await tx.save();
    }

    res.json({ status: tx.status, coin: tx.coin, amount: tx.amount });
  } catch (err) {
    console.error("Verify withdraw error:", err);
    res.status(500).json({ error: "Could not verify withdrawal" });
  }
});



// ✅ 404 fallback
app.use((req, res) => res.status(404).json({ error: "Endpoint not found" }));

// ✅ Global error handler
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`✓ Server running on http://localhost:${PORT}`));
}

export default app;

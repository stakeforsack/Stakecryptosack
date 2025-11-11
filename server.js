import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { connectDB, User, Transaction, Deposit } from "./db.js";

dotenv.config();

const app = express();

// --- CONFIG ---
app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));
app.use(express.json());

// --- ENV VARIABLES ---
const JWT_SECRET = process.env.JWT_SECRET || "supersecretjwtkey";

// --- CONNECT DB ---
connectDB().catch(err => {
  console.error("Failed to connect to DB:", err);
  process.exit(1);
});

// --- AUTH MIDDLEWARE ---
const needAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

// --- ROUTES ---

// Register
app.post("/api/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ error: "All fields are required" });

    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists)
      return res.status(400).json({ error: "Email or username already taken" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ email, username, password: hashed });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ ok: true, token, user: { id: user._id, email, username } });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ ok: true, token, user: { id: user._id, email, username: user.username } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Deposit
app.post("/api/deposit", needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;
    const tx = await Transaction.create({
      userId: req.userId,
      type: "DEPOSIT",
      coin,
      amount: parseFloat(amount),
      status: "PENDING"
    });

    res.json({ ok: true, address: getCoinAddress(coin), txId: tx._id });
  } catch (err) {
    console.error("Deposit error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Withdraw
app.post("/api/withdraw", needAuth, async (req, res) => {
  try {
    const { coin, amount, address } = req.body;
    const tx = await Transaction.create({
      userId: req.userId,
      type: "WITHDRAW",
      coin,
      amount: parseFloat(amount),
      status: "PENDING",
      meta: { address }
    });

    res.json({ ok: true, txId: tx._id });
  } catch (err) {
    console.error("Withdraw error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Transactions
app.get("/api/transactions", needAuth, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json({ ok: true, transactions });
  } catch (err) {
    console.error("Transaction list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Session
app.get("/api/session", needAuth, async (req, res) => {
  const user = await User.findById(req.userId).select("id email username");
  res.json({ ok: true, user });
});

// --- Helper
function getCoinAddress(coin) {
  const addresses = {
    BTC: "bc1example...",
    ETH: "0xexample...",
    USDT: "TRexample..."
  };
  return addresses[coin] || "";
}

// --- Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

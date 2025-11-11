import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// CORS middleware
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// Body parsing
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || "your-secret-key-change-this",
  resave: false,
  saveUninitialized: true,  // Changed to true
  cookie: {
    secure: false,  // Set to false for localhost/testing
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000
}).then(() => {
  console.log('✓ Connected to MongoDB');
}).catch(err => {
  console.error('✗ MongoDB connection error:', err.message);
  process.exit(1);
});

// User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  vip: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Transaction Schema
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['DEPOSIT', 'WITHDRAW', 'TRANSFER'], required: true },
  coin: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, default: 'PENDING' },
  meta: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model('Transaction', transactionSchema);

// Fix the needAuth middleware
const needAuth = (req, res, next) => {
  console.log('🔐 Auth check:');
  console.log('   Session ID:', req.sessionID);
  console.log('   Session userId:', req.session?.userId);
  console.log('   All session:', req.session);
  
  if (!req.session || !req.session.userId) {
    console.log('❌ Not authenticated');
    return res.status(401).json({ error: "Please login" });
  }
  
  console.log('✓ Authenticated - userId:', req.session.userId);
  next();
};

// Register endpoint
app.post('/api/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const exists = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (exists) {
      return res.status(400).json({ error: 'Email or username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      email,
      username,
      password: hashedPassword
    });

    await user.save();

    req.session.userId = user._id;
    req.session.username = user.username;
    
    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ error: 'Session error' });
      }
      res.json({ ok: true, user: { id: user._id, email, username } });
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Login endpoint
app.post("/api/login", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const userOrEmail = username || email;

    if (!userOrEmail || !password) {
      return res.status(400).json({ error: "Username/Email and password required" });
    }

    const user = await User.findOne({
      $or: [
        { username: userOrEmail },
        { email: userOrEmail }
      ]
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    req.session.userId = user._id;
    req.session.username = user.username;
    
    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ error: 'Session error' });
      }
      res.json({ 
        ok: true, 
        user: {
          id: user._id,
          username: user.username,
          email: user.email
        }
      });
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Deposit endpoint
app.post("/api/deposit", needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;

    if (!coin || !amount) {
      return res.status(400).json({ error: "Coin and amount required" });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }

    const tx = new Transaction({
      userId: req.session.userId,
      type: "DEPOSIT",
      coin: coin.toUpperCase(),
      amount: numAmount,
      status: "PENDING"
    });

    const savedTx = await tx.save();

    res.json({ 
      ok: true, 
      txId: savedTx._id,
      message: "Deposit request received"
    });
  } catch (err) {
    console.error("Deposit error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Withdraw endpoint
app.post("/api/withdraw", needAuth, async (req, res) => {
  try {
    const { coin, amount, address } = req.body;

    if (!coin || !amount || !address) {
      return res.status(400).json({ error: "Coin, amount, and address required" });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }

    const tx = new Transaction({
      userId: req.session.userId,
      type: "WITHDRAW",
      coin: coin.toUpperCase(),
      amount: numAmount,
      status: "PENDING",
      meta: { address }
    });

    const savedTx = await tx.save();

    res.json({ 
      ok: true, 
      txId: savedTx._id,
      message: "Withdrawal request submitted"
    });
  } catch (err) {
    console.error("Withdraw error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Get transactions
app.get("/api/transactions", needAuth, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.session.userId }).sort({ createdAt: -1 });
    res.json({ ok: true, transactions });
  } catch (err) {
    console.error("Transactions error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Payment verification endpoint
app.post("/api/verify-payment", needAuth, async (req, res) => {
  try {
    const { txId, coin } = req.body;

    if (!txId || !coin) {
      return res.status(400).json({ error: "Transaction ID and coin required" });
    }

    const tx = await Transaction.findById(txId);

    if (!tx || tx.userId.toString() !== req.session.userId.toString()) {
      return res.status(403).json({ error: "Transaction not found" });
    }

    // Here you would integrate with blockchain APIs to verify payment
    // For now, we'll use a manual admin verification system
    
    res.json({ 
      ok: true, 
      status: tx.status,
      amount: tx.amount,
      coin: tx.coin
    });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Get single transaction details
app.get("/api/transaction/:id", needAuth, async (req, res) => {
  try {
    const tx = await Transaction.findById(req.params.id);

    if (!tx || tx.userId.toString() !== req.session.userId.toString()) {
      return res.status(403).json({ error: "Transaction not found" });
    }

    res.json({ ok: true, transaction: tx });
  } catch (err) {
    console.error("Get transaction error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Admin endpoint to mark payment as confirmed (webhook from blockchain or manual)
app.post("/api/admin/confirm-payment", async (req, res) => {
  try {
    // In production, add proper admin authentication
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { txId } = req.body;

    const tx = await Transaction.findByIdAndUpdate(
      txId,
      { status: "CONFIRMED" },
      { new: true }
    );

    if (!tx) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    console.log("✓ Payment confirmed for transaction:", txId);

    res.json({ 
      ok: true, 
      message: "Payment confirmed",
      transaction: tx
    });
  } catch (err) {
    console.error("Confirm payment error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Get user balance (sum of confirmed deposits minus withdrawals)
app.get("/api/balance", needAuth, async (req, res) => {
  try {
    const deposits = await Transaction.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(req.session.userId),
          type: "DEPOSIT",
          status: "CONFIRMED"
        }
      },
      {
        $group: {
          _id: "$coin",
          total: { $sum: "$amount" }
        }
      }
    ]);

    const withdrawals = await Transaction.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(req.session.userId),
          type: "WITHDRAW",
          status: "CONFIRMED"
        }
      },
      {
        $group: {
          _id: "$coin",
          total: { $sum: "$amount" }
        }
      }
    ]);

    const balance = {};
    
    deposits.forEach(dep => {
      balance[dep._id] = (balance[dep._id] || 0) + dep.total;
    });

    withdrawals.forEach(wit => {
      balance[wit._id] = (balance[wit._id] || 0) - wit.total;
    });

    res.json({ ok: true, balance });
  } catch (err) {
    console.error("Balance error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Server is running" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));

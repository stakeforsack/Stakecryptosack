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

// Middleware
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || "your-secret-key-change-this",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/'
  }
}));

// Auth middleware
const needAuth = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Please login" });
  }
  next();
};

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Server is running" });
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    await connectDB();
    
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

    req.session.userId = user._id.toString();
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

// Register
app.post('/api/register', async (req, res) => {
  try {
    await connectDB();
    
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

    req.session.userId = user._id.toString();
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

// Get profile
app.get("/api/profile", needAuth, async (req, res) => {
  try {
    await connectDB();
    
    const user = await User.findById(req.session.userId).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = new mongoose.Types.ObjectId(req.session.userId);

    const deposits = await Transaction.aggregate([
      {
        $match: {
          userId: userId,
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
          userId: userId,
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

    res.json({ 
      ok: true, 
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        vip: user.vip,
        createdAt: user.createdAt
      },
      balance 
    });
  } catch (err) {
    console.error("Profile error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Deposit
app.post("/api/deposit", needAuth, async (req, res) => {
  try {
    await connectDB();
    
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

// Withdraw
app.post("/api/withdraw", needAuth, async (req, res) => {
  try {
    await connectDB();
    
    const { coin, amount, wallet } = req.body;

    if (!coin || !amount || !wallet) {
      return res.status(400).json({ error: "Coin, amount, and wallet required" });
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
      meta: { wallet }
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
    await connectDB();
    
    const transactions = await Transaction.find({ userId: req.session.userId }).sort({ createdAt: -1 }).limit(100);
    res.json({ ok: true, transactions });
  } catch (err) {
    console.error("Transactions error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Logout failed" });
    }
    res.json({ ok: true, message: "Logged out successfully" });
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Export for Vercel
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`✓ Server running on port ${PORT}`);
  });
}

export default app;

import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// CORS middleware - MUST be before session
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// Body parsing
app.use(express.json());
app.use(express.static("public"));

// Session configuration - Updated for production
app.use(session({
  secret: process.env.SESSION_SECRET || "your-secret-key-change-this",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',  // true for HTTPS only
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    domain: process.env.NODE_ENV === 'production' ? '.vercel.app' : undefined
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

// Auth middleware
const needAuth = (req, res, next) => {
  console.log("🔐 Auth check - Session:", req.session);
  console.log("🔐 Auth check - userId:", req.session?.userId);
  
  if (!req.session || !req.session.userId) {
    console.log("❌ Not authenticated");
    return res.status(401).json({ error: "Please login" });
  }
  
  console.log("✓ Authenticated - userId:", req.session.userId);
  next();
};

// Register endpoint
app.post('/api/register', async (req, res) => {
  try {
    console.log('📝 Register endpoint hit');
    console.log('Body received:', req.body);
    
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      console.log('❌ Missing fields');
      return res.status(400).json({ error: 'All fields required' });
    }

    console.log('✓ Fields validated');

    const exists = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (exists) {
      console.log('❌ User already exists');
      return res.status(400).json({ error: 'Email or username already exists' });
    }

    console.log('✓ User does not exist');

    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('✓ Password hashed');

    const user = new User({
      email,
      username,
      password: hashedPassword
    });

    await user.save();
    console.log('✓ User saved to database:', user._id);

    // Set session and save it
    req.session.userId = user._id;
    req.session.username = user.username;
    
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Session error' });
      }
      
      console.log('✓ Session created and saved');
      res.json({ ok: true, user: { id: user._id, email, username } });
    });
  } catch (err) {
    console.error('❌ Register error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Login endpoint
app.post("/api/login", async (req, res) => {
  try {
    console.log("Login request received:", req.body);

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

    console.log("User found:", user ? user.username : "Not found");

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    console.log("Password match:", passwordMatch);

    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Set session and save it
    req.session.userId = user._id;
    req.session.username = user.username;
    
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Session error' });
      }
      
      console.log("✓ Login successful for:", user.username);
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
    console.error("❌ Login error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Deposit endpoint
app.post("/api/deposit", needAuth, async (req, res) => {
  try {
    console.log("💰 Deposit request received");
    console.log("User ID:", req.session.userId);
    console.log("Body:", req.body);

    if (!req.session.userId) {
      console.log("❌ No session userId");
      return res.status(401).json({ error: "Please login first" });
    }

    const { coin, amount } = req.body;

    if (!coin || !amount) {
      console.log("❌ Missing coin or amount");
      return res.status(400).json({ error: "Coin and amount required" });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      console.log("❌ Invalid amount");
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }

    console.log("✓ Validation passed, creating transaction...");

    const tx = new Transaction({
      userId: new mongoose.Types.ObjectId(req.session.userId),
      type: "DEPOSIT",
      coin: coin.toUpperCase(),
      amount: numAmount,
      status: "PENDING"
    });

    const savedTx = await tx.save();
    console.log("✓ Deposit transaction saved:", savedTx._id);

    res.json({ 
      ok: true, 
      txId: savedTx._id,
      message: "Deposit request received"
    });
  } catch (err) {
    console.error("❌ Deposit error:", err);
    console.error("Error message:", err.message);
    console.error("Error type:", err.name);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Withdraw endpoint
app.post("/api/withdraw", needAuth, async (req, res) => {
  try {
    console.log("💸 Withdraw request received");
    console.log("User ID:", req.session.userId);
    console.log("Body:", req.body);

    const { coin, amount, address } = req.body;

    if (!coin || !amount || !address) {
      console.log("❌ Missing coin, amount, or address");
      return res.status(400).json({ error: "Coin, amount, and address required" });
    }

    if (isNaN(amount) || parseFloat(amount) <= 0) {
      console.log("❌ Invalid amount");
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }

    console.log("✓ Validation passed");

    const tx = new Transaction({
      userId: req.session.userId,
      type: "WITHDRAW",
      coin: coin.toUpperCase(),
      amount: parseFloat(amount),
      status: "PENDING",
      meta: { address }
    });

    await tx.save();
    console.log("✓ Withdraw transaction saved:", tx._id);

    res.json({ 
      ok: true, 
      txId: tx._id,
      message: "Withdrawal request submitted. Processing..."
    });
  } catch (err) {
    console.error("❌ Withdraw error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Get transactions
app.get("/api/transactions", needAuth, async (req, res) => {
  try {
    console.log("📋 Fetching transactions for user:", req.session.userId);

    const transactions = await Transaction.find({ userId: req.session.userId }).sort({ createdAt: -1 });
    console.log("✓ Found", transactions.length, "transactions");

    res.json({ ok: true, transactions });
  } catch (err) {
    console.error("❌ Transactions error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Server is running" });
});

// Add this middleware to log all requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Error handling middleware - ADD THIS at the end before listen
app.use((err, req, res, next) => {
  console.error('❌ Global error handler:', err);
  console.error('Error message:', err.message);
  console.error('Error stack:', err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  console.log('❌ 404 Not Found:', req.url);
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));

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

// ✅ Make sure this matches your deployed frontend
const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";

// ✅ CORS configuration (critical for Vercel)
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// ✅ Body parsers
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// ✅ Serve static files (for local testing)
app.use(express.static(path.join(__dirname, "public")));

// ✅ Session configuration (important for Vercel + HTTPS)
app.set("trust proxy", 1);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "your-secret-key-change-this",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // true on Vercel
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
      path: "/",
    },
  })
);

// ✅ Auth middleware
const needAuth = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Please login" });
  }
  next();
};

// ✅ Health check route
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Server is running" });
});

// ✅ Register route
app.post("/api/register", async (req, res) => {
  try {
    await connectDB();
    const { email, username, password } = req.body;

    if (!email || !username || !password)
      return res.status(400).json({ error: "All fields required" });

    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists)
      return res.status(400).json({ error: "Email or username already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, username, password: hashedPassword });
    await user.save();

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Session error" });
      res.json({
        ok: true,
        user: { id: user._id, email, username },
      });
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ✅ Login route
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

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) return res.status(401).json({ error: "Invalid credentials" });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Session error" });
      res.json({
        ok: true,
        user: { id: user._id, username: user.username, email: user.email },
      });
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ✅ Profile route (protected)
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
    deposits.forEach((dep) => {
      balance[dep._id] = (balance[dep._id] || 0) + dep.total;
    });
    withdrawals.forEach((wit) => {
      balance[wit._id] = (balance[wit._id] || 0) - wit.total;
    });

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

// ✅ Logout route
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

// ✅ 404 fallback
app.use((req, res) => res.status(404).json({ error: "Endpoint not found" }));

// ✅ Error handler
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// ✅ Export for Vercel / start locally
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));
}

export default app;

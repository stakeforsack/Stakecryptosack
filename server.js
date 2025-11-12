import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { connectDB, User, Transaction } from "./db.js";
import MongoStore from "connect-mongo"; // ✅ persistent sessions

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// ✅ Your frontend domain (update this to match actual deployed frontend)
const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";

// ✅ CORS setup (MUST match the frontend domain exactly)
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// ✅ Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Serve static (optional for local)
app.use(express.static(path.join(__dirname, "public")));

// ✅ Trust proxy for secure cookies on Vercel
app.set("trust proxy", 1);

// ✅ Persistent sessions using MongoStore (important for Vercel)
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    store:
      process.env.NODE_ENV === "production"
        ? MongoStore.create({
            mongoUrl: process.env.MONGO_URI,
            dbName: "godstake",
            ttl: 24 * 60 * 60, // 1 day
          })
        : undefined,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // only HTTPS
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
      path: "/",
    },
  })
);

// ✅ Auth middleware
const needAuth = (req, res, next) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Please login" });
  }
  next();
};

// ✅ Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Server is healthy ✅" });
});

// ✅ Register route
app.post("/api/register", async (req, res) => {
  try {
    await connectDB();
    const { email, username, password } = req.body;

    if (!email || !username || !password)
      return res.status(400).json({ error: "All fields required" });

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing)
      return res.status(400).json({ error: "Email or username already exists" });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, username, password: hash });

    req.session.userId = user._id.toString();
    req.session.username = user.username;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Session save failed" });
      res.json({ ok: true, user: { id: user._id, email, username } });
    });
  } catch (err) {
    console.error("❌ Register error:", err);
    res.status(500).json({ error: "Internal server error" });
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

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: "Invalid credentials" });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    req.session.save((err) => {
      if (err) {
        console.error("Session save failed:", err);
        return res.status(500).json({ error: "Session error" });
      }
      res.json({
        ok: true,
        user: { id: user._id, username: user.username, email: user.email },
      });
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    // ✅ Always return JSON — never plain text
    res.status(500).json({ error: "Server error during login" });
  }
});

// ✅ Profile route
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
    console.error("❌ Profile error:", err);
    res.status(500).json({ error: "Server error loading profile" });
  }
});

// ✅ Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).json({ error: "Logout failed" });
    }
    res.clearCookie("connect.sid", {
      path: "/",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
    });
    res.json({ ok: true, message: "Logged out successfully" });
  });
});

// ✅ Fallback for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: "API route not found" });
});

// ✅ Global error handler (always return JSON)
app.use((err, req, res, next) => {
  console.error("⚠️ Uncaught error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ✅ Start server locally
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
}

export default app;

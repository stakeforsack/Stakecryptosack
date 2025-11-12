import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { connectDB, User, Transaction } from "./db.js";
import MongoStore from "connect-mongo"; // ✅ helps sessions persist in production

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ✅ Your frontend domain
const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";

// ✅ CORS setup
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// ✅ Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// ✅ Static (optional for local)
app.use(express.static(path.join(__dirname, "public")));

// ✅ Trust proxy (important for secure cookies on Vercel)
app.set("trust proxy", 1);

// ✅ Use MongoStore for production session storage
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    store:
      process.env.NODE_ENV === "production"
        ? MongoStore.create({
            mongoUrl: process.env.MONGO_URI,
            ttl: 24 * 60 * 60, // 1 day
          })
        : undefined,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // HTTPS only in prod
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
    if (exists)
      return res.status(400).json({ error: "Email or username already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, username, password: hashedPassword });
    await user.save();

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Session save failed" });
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

// ✅ Profile (Protected)
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

// ✅ Fallback
app.use((req, res) => res.status(404).json({ error: "Endpoint not found" }));

// ✅ Error Handler
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// ✅ Start server (local)
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`✓ Server running on http://localhost:${PORT}`));
}

export default app;

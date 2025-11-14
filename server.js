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
connectDB();

// =========================
//   CONFIG + CONSTANTS
// =========================
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";

const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
];

const isProd = process.env.NODE_ENV === "production";

// =========================
//   CORS (FIXED)
// =========================

// =========================
//   CORS & SESSION (production-ready for Vercel)
// =========================
const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";
const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  "https://stakecryptosack.vercel.app"
];

const isProd = process.env.NODE_ENV === "production";

app.use(
  cors({
    origin: (origin, callback) => {
      // allow server-to-server requests or same-origin (no origin)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("CORS blocked: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.options("*", cors({ origin: ALLOWED_ORIGINS, credentials: true }));

app.set("trust proxy", isProd ? 1 : 0);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "your-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,            // secure cookies only in production (HTTPS)
      sameSite: isProd ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
      path: "/",
    },
  })
);

// ensure responses include credentials header
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});
// =========================
//   AUTH MIDDLEWARE
// =========================
const needAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Please login" });
  }
  next();
};

// =========================
//   ROUTES
// =========================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// Register
app.post("/api/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ error: "All fields required" });

    const exists = await User.findOne({
      $or: [{ email }, { username }],
    });
    if (exists) return res.status(400).json({ error: "User already exists" });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, username, password: hash });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    req.session.save((err) =>
      err
        ? res.status(500).json({ error: "Session save failed" })
        : res.json({
            ok: true,
            user: {
              id: user._id,
              email: user.email,
              username: user.username,
            },
          })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const input = username || email;

    const user = await User.findOne({
      $or: [{ username: input }, { email: input }],
    });

    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.userId = user._id.toString();
    req.session.username = user.username;

    req.session.save((err) =>
      err
        ? res.status(500).json({ error: "Session save failed" })
        : res.json({
            ok: true,
            user: {
              id: user._id,
              username: user.username,
              email: user.email,
            },
          })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Profile (protected)
app.get("/api/profile", needAuth, async (req, res) => {
  const user = await User.findById(req.session.userId).select("-password");
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({
    ok: true,
    user,
  });
});

// Logout
app.post("/api/logout", (req, res) => {
  const isProd = process.env.NODE_ENV === "production";

  req.session.destroy(() => {
    res.clearCookie("connect.sid", { path: "/", httpOnly: true, sameSite: isProd ? "none" : "lax", secure: isProd });
    res.json({ ok: true });
  });
});

// =========================
//   START SERVER
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

export default app;

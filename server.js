import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { connectDB, User, Transaction, Deposit, Membership } from "./db.js";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
await connectDB(); // connect to DB

const FRONTEND_URL = process.env.FRONTEND_URL || "https://stakecryptosack.vercel.app";
const ALLOWED_ORIGINS = [FRONTEND_URL, "http://localhost:3000", "http://127.0.0.1:3000"];
const isProd = process.env.NODE_ENV === "production";

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("CORS blocked: " + origin));
  },
  credentials: true,
  methods: ["GET","POST","PUT","DELETE","OPTIONS"]
}));

app.set("trust proxy", isProd ? 1 : 0);

app.use(session({
  secret: process.env.SESSION_SECRET || "your-secret-key",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProd, sameSite: isProd ? "none" : "lax", maxAge: 24*60*60*1000, path: "/" }
}));

app.use((req,res,next)=>{ res.header("Access-Control-Allow-Credentials","true"); next(); });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// AUTH
const needAuth = (req,res,next)=>{
  if(!req.session || !req.session.userId) return res.status(401).json({ error: "Please login" });
  next();
};
const requireAdmin = (req,res,next)=>{
  const key = req.header('x-admin-key') || req.query.admin_key || req.query.key;
  if(!key || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  next();
};

// Health
app.get("/api/health", (req,res)=> res.json({ ok: true }));

// Register
app.post("/api/register", async (req,res)=>{
  try{
    const { email, username, password } = req.body;
    if(!email || !username || !password) return res.status(400).json({ error: "All fields required" });
    const exists = await User.findOne({ $or:[{ email }, { username }] });
    if(exists) return res.status(400).json({ error: "User exists" });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, username, password: hash });
    req.session.userId = user._id.toString();
    req.session.username = user.username;
    req.session.save(()=>{});
    res.json({ ok: true, user: { id: user._id, email: user.email, username: user.username } });
  }catch(err){ console.error(err); res.status(500).json({ error: err.message }); }
});

// Login
app.post("/api/login", async (req,res)=>{
  try{
    const { username, email, password } = req.body;
    const input = username || email;
    const user = await User.findOne({ $or:[{ username: input }, { email: input }] });
    if(!user) return res.status(401).json({ error: "Invalid credentials" });
    const match = await bcrypt.compare(password, user.password);
    if(!match) return res.status(401).json({ error: "Invalid credentials" });
    req.session.userId = user._id.toString();
    req.session.username = user.username;
    req.session.save(()=>{});
    res.json({ ok: true, user: { id: user._id, username: user.username, email: user.email } });
  }catch(err){ console.error(err); res.status(500).json({ error: err.message }); }
});

// Profile
app.get("/api/profile", needAuth, async (req,res)=>{
  const user = await User.findById(req.session.userId).select("-password");
  if(!user) return res.status(404).json({ error: "User not found" });
  // balance from transactions (confirmed)
  const userId = new mongoose.Types.ObjectId(req.session.userId);
  const deposits = await Transaction.aggregate([{ $match:{ userId, type:"DEPOSIT", status:"CONFIRMED" } }, { $group:{ _id:"$coin", total:{ $sum:"$amount" } } }]);
  const withdrawals = await Transaction.aggregate([{ $match:{ userId, type:"WITHDRAW", status:"CONFIRMED" } }, { $group:{ _id:"$coin", total:{ $sum:"$amount" } } }]);
  const balance = {};
  deposits.forEach(d=> balance[d._id] = (balance[d._1d] || 0) + d.total);
  withdrawals.forEach(w=> balance[w._id] = (balance[w._id] || 0) - w.total);
  res.json({ ok: true, user, balance });
});

// Logout
app.post("/api/logout", (req,res)=>{
  req.session.destroy(()=>{
    res.clearCookie("connect.sid", { path: "/", httpOnly: true, sameSite: isProd ? "none" : "lax", secure: isProd });
    res.json({ ok: true });
  });
});

// Deposit - create pending tx
app.post("/api/deposit", needAuth, async (req,res)=>{
  try{
    const { coin, amount } = req.body;
    if(!coin || !amount || amount <= 0) return res.status(400).json({ error: "Invalid deposit data" });
    const deposit = await Transaction.create({ userId: req.session.userId, type: "DEPOSIT", coin, amount, status: "PENDING" });
    res.json({ ok: true, txId: deposit._id.toString(), coin, amount });
  }catch(err){ console.error(err); res.status(500).json({ error: "Deposit failed" }); }
});

// Verify-payment (admin or user check)
app.post("/api/verify-payment", needAuth, async (req,res)=>{
  try{
    const { txId } = req.body;
    const tx = await Transaction.findById(txId);
    if(!tx) return res.status(404).json({ status: "NOT_FOUND" });
    if(tx.status !== "CONFIRMED"){ tx.status = "CONFIRMED"; await tx.save(); }
    res.json({ status: tx.status, coin: tx.coin, amount: tx.amount });
  }catch(err){ console.error(err); res.status(500).json({ error: "Could not verify payment" }); }
});

// Withdraw request
app.post("/api/withdraw", needAuth, async (req,res)=>{
  try{
    const { coin, amount } = req.body;
    if(!coin || !amount || amount <= 0) return res.status(400).json({ error: "Invalid withdraw data" });
    // check balance (simple aggregate)
    const userId = new mongoose.Types.ObjectId(req.session.userId);
    const deposits = await Transaction.aggregate([{ $match:{ userId, type:"DEPOSIT", status:"CONFIRMED" } }, { $group:{ _id:"$coin", total:{ $sum:"$amount" } } }]);
    const withdrawals = await Transaction.aggregate([{ $match:{ userId, type:"WITHDRAW", status:"CONFIRMED" } }, { $group:{ _id:"$coin", total:{ $sum:"$amount" } } }]);
    const balance = {}; deposits.forEach(d=> balance[d._id] = (balance[d._id] || 0) + d.total); withdrawals.forEach(w=> balance[w._id] = (balance[w._id] || 0) - w.total);
    const currentBalance = balance[coin] || 0;
    if(amount > currentBalance) return res.status(400).json({ error: "Insufficient balance" });
    const withdrawal = await Transaction.create({ userId: req.session.userId, type: "WITHDRAW", coin, amount, status: "PENDING" });
    res.json({ ok: true, txId: withdrawal._id.toString() });
  }catch(err){ console.error(err); res.status(500).json({ error: "Withdraw failed" }); }
});

// Admin endpoints
app.get("/api/admin/users", requireAdmin, async (req,res)=>{
  const users = await User.find().select("-password").limit(500);
  res.json({ ok: true, users });
});
app.get("/api/admin/transactions", requireAdmin, async (req,res)=>{
  const tx = await Transaction.find().sort({ createdAt: -1 }).limit(500);
  res.json({ ok: true, tx });
});
app.post("/api/admin/approve-deposit", requireAdmin, async (req,res)=>{
  const { txId } = req.body;
  const tx = await Transaction.findById(txId);
  if(!tx) return res.status(404).json({ error: "Not found" });
  tx.status = "CONFIRMED"; await tx.save();
  res.json({ ok: true, txId: tx._id.toString() });
});
app.post("/api/admin/approve-withdraw", requireAdmin, async (req,res)=>{
  const { txId, tx_hash } = req.body;
  const tx = await Transaction.findById(txId);
  if(!tx) return res.status(404).json({ error: "Not found" });
  tx.status = "CONFIRMED"; tx.meta = { ...(tx.meta||{}), tx_hash }; await tx.save();
  res.json({ ok: true, txId: tx._id.toString() });
});

// Membership: grant by admin or upgrade by user
app.post("/api/admin/grant-membership", requireAdmin, async (req,res)=>{
  const { userId, tier } = req.body;
  if(!userId || !tier) return res.status(400).json({ error: "userId & tier required" });
  const tiers = { V1:{daily:10,duration:5,bonus:50}, V2:{daily:20,duration:7,bonus:100}, V3:{daily:30,duration:10,bonus:150}, V4:{daily:50,duration:15,bonus:250}, V5:{daily:100,duration:30,bonus:500} };
  if(!tiers[tier]) return res.status(400).json({ error: "Invalid tier" });
  const t = tiers[tier];
  const m = await Membership.create({ userId, tier, startDate:new Date(), durationDays:t.duration, dailyAmount:t.daily, bonusAtMonthEnd:t.bonus });
  res.json({ ok: true, membership: m });
});

app.post("/api/membership/upgrade", needAuth, async (req,res)=>{
  const { tier } = req.body;
  const tiers = { V1:{daily:10,duration:5,bonus:50}, V2:{daily:20,duration:7,bonus:100}, V3:{daily:30,duration:10,bonus:150}, V4:{daily:50,duration:15,bonus:250}, V5:{daily:100,duration:30,bonus:500} };
  if(!tiers[tier]) return res.status(400).json({ error: "Invalid tier" });
  const t = tiers[tier];
  const m = await Membership.create({ userId: req.session.userId, tier, startDate:new Date(), durationDays:t.duration, dailyAmount:t.daily, bonusAtMonthEnd:t.bonus });
  res.json({ ok: true, membership: m });
});

// Cron Payout Endpoint (protected by admin key) - run daily via scheduler
app.post("/api/cron/payouts", requireAdmin, async (req,res)=>{
  try{
    const memberships = await Membership.find({ status: "ACTIVE" });
    const results = [];
    for(const m of memberships){
      // don't double pay same day
      if(m.lastPayout && new Date(m.lastPayout).toDateString() === new Date().toDateString()){
        results.push({ membership: m._id, skipped: "already paid today" });
        continue;
      }
      if(m.daysPaid >= m.durationDays){ results.push({ membership: m._id, skipped: "completed" }); continue; }
      // create confirmed deposit transaction crediting USD
      const tx = await Transaction.create({ userId: m.userId, type:"DEPOSIT", coin:"USD", amount: m.dailyAmount, status:"CONFIRMED" });
      m.daysPaid += 1; m.lastPayout = new Date();
      if(m.daysPaid >= m.durationDays) m.status = "COMPLETED";
      await m.save();
      results.push({ membership: m._id, txId: tx._id.toString() });
    }
    res.json({ ok: true, results });
  }catch(err){ console.error(err); res.status(500).json({ error: err.message }); }
});

// 404 for API
app.use("/api", (req,res)=> res.status(404).json({ error: "API endpoint not found" }));

// Serve static (fallback)
app.use((req,res)=>{
  const filePath = req.path === "/" ? "/index.html" : req.path;
  res.sendFile(path.join(__dirname, "public", filePath));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("Server running on", PORT));

export default app;

// db.js
import mongoose from "mongoose";

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URI || "mongodb+srv://user:pass@cluster.mongodb.net/godstake";
    await mongoose.connect(uri);
    console.log("✅ MongoDB Connected");
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err);
    process.exit(1);
  }
};

// ===== SCHEMAS =====
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  email: { type: String, unique: true, required: true },
  password_hash: { type: String, required: true },
  bio: String,
  vip: { type: Number, default: 0 },
  twofa_enabled: { type: Boolean, default: false },
  twofa_secret: String,
  created_at: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  type: String,
  coin: String,
  amount: Number,
  status: { type: String, default: "PENDING" },
  meta: Object,
  created_at: { type: Date, default: Date.now }
});

const depositSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  coin: String,
  amount_expected: Number,
  amount_received: Number,
  address: String,
  tx_hash: String,
  status: { type: String, default: "PENDING" },
  confirmations: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now }
});

const paymentSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  type: String,
  details: String,
  created_at: { type: Date, default: Date.now }
});

const verificationSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  front_path: String,
  back_path: String,
  selfie_path: String,
  status: { type: String, default: "PENDING" },
  created_at: { type: Date, default: Date.now }
});

const ticketSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  subject: String,
  message: String,
  status: { type: String, default: "OPEN" },
  created_at: { type: Date, default: Date.now }
});

// ===== MODELS =====
const User = mongoose.model("User", userSchema);
const Transaction = mongoose.model("Transaction", transactionSchema);
const Deposit = mongoose.model("Deposit", depositSchema);
const Payment = mongoose.model("PaymentMethod", paymentSchema);
const Verification = mongoose.model("Verification", verificationSchema);
const Ticket = mongoose.model("Ticket", ticketSchema);

export { connectDB, User, Transaction, Deposit, Payment, Verification, Ticket };

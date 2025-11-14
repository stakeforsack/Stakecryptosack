import mongoose from "mongoose";

let isConnected = false;

/**
 * Connect to MongoDB Atlas
 */
export async function connectDB() {
  if (isConnected) return; // Prevent multiple connections in serverless environment
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: "godstake",
      autoIndex: true,
    });
    isConnected = true;
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    throw err;
  }
}

// ====== User Schema & Model ======
const userSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, required: true },
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    vip: { type: Boolean, default: false },
    bio: { type: String, default: "" },
    twofa_enabled: { type: Boolean, default: false },
    twofa_secret: { type: String, default: "" },
  },
  { timestamps: true }
);

export const User = mongoose.models.User || mongoose.model("User", userSchema);

// ====== Transaction Schema & Model ======
const transactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["DEPOSIT", "WITHDRAW"], required: true },
    coin: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, default: "PENDING" },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

export const Transaction =
  mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);

// ====== Deposit Schema & Model ======
const depositSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    coin: { type: String, required: true },
    amount_expected: { type: Number, required: true },
    amount_received: { type: Number, default: 0 },
    address: { type: String, required: true },
    tx_hash: { type: String, default: "" },
    status: { type: String, default: "PENDING" },
    confirmations: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Deposit =
  mongoose.models.Deposit || mongoose.model("Deposit", depositSchema);

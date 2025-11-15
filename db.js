import mongoose from "mongoose";
export async function connectDB(){
  if(process.env.MONGO_URI){
    await mongoose.connect(process.env.MONGO_URI, { dbName: "godstake" });
    console.log("MongoDB connected");
  } else {
    console.log("MONGO_URI not set; running without DB");
  }
}

// User schema
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, sparse: true },
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  vip: { type: Boolean, default: false },
  bio: { type: String, default: "" },
  membership: { type: String, default: "NONE" },
  membershipActivatedAt: { type: Date, default: null }
},{ timestamps: true });
export const User = mongoose.models.User || mongoose.model("User", userSchema);

// Transaction schema
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["DEPOSIT","WITHDRAW","PAYOUT"], required: true },
  coin: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, default: "PENDING" },
  meta: { type: Object, default: {} }
},{ timestamps: true });
export const Transaction = mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);

// Deposit schema (optional)
const depositSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  coin: String,
  amount_expected: Number,
  amount_received: { type: Number, default: 0 },
  address: String,
  tx_hash: String,
  status: { type: String, default: "PENDING" },
  confirmations: { type: Number, default: 0 }
},{ timestamps: true });
export const Deposit = mongoose.models.Deposit || mongoose.model("Deposit", depositSchema);

// Membership schema
const membershipSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  tier: { type: String, enum: ["V1","V2","V3","V4","V5"], required: true },
  startDate: { type: Date, default: Date.now },
  status: { type: String, enum: ["ACTIVE","COMPLETED","CANCELLED"], default: "ACTIVE" },
  durationDays: { type: Number, default: 5 },
  daysPaid: { type: Number, default: 0 },
  dailyAmount: { type: Number, required: true },
  bonusAtMonthEnd: { type: Number, default: 0 },
  lastPayout: { type: Date, default: null }
},{ timestamps: true });
export const Membership = mongoose.models.Membership || mongoose.model("Membership", membershipSchema);

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();

// ===== Middleware =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // change to true when using HTTPS
}));

// ===== Auth helper =====
function needAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ===== Initialize DB =====
db.init().catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});

// ===== Auth Routes =====

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });

    const existing = await db.getUserByEmail(email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const id = await db.createUser({ username, email, password_hash: hash });
    req.session.userId = id;
    return res.json({ ok: true, user: { id, username, email } });
  } catch (err) {
    console.error('register error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, identifier, password } = req.body;
    const ident = (identifier || email || '').toString().trim();
    if (!ident || !password) return res.status(400).json({ error: 'Missing credentials' });

    let user = await db.getUserByEmail(ident);
    if (!user) user = await db.getUserByUsername(ident);
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const hash = user.password_hash || '';
    const ok = await bcrypt.compare(password, hash);
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

    req.session.userId = user.id;
    return res.json({ ok: true, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error('login error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('logout error', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    return res.json({ ok: true });
  });
});

// ===== Protected Routes =====

// Get current user
app.get('/api/me', needAuth, async (req, res) => {
  const user = await db.getUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user: { id: user.id, username: user.username, email: user.email } });
});

// Get user profile
app.get('/api/user-profile', needAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      username: user.username,
      email: user.email,
      bio: user.bio || ''
    });
  } catch (err) {
    console.error('profile fetch error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update profile
app.post('/api/update-profile', needAuth, async (req, res) => {
  try {
    const { username, email, bio } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'Missing fields' });

    await db.updateUser(req.session.userId, { username, email, bio });
    res.json({ ok: true });
  } catch (err) {
    console.error('update-profile error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Deposit Route =====
app.post('/deposit', needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;
    if (!coin || !amount) return res.status(400).json({ error: 'Missing coin or amount' });

    // Map of deposit addresses - replace with your actual addresses
    const depositAddresses = {
      USDTBINANCE: 'bnb1yourbinanceaddress',
      BTC: 'bc1yourbtcaddress',
      ETH: '0xyourethaddress',
      TRX: 'TYourtronaddress',
      USDTETH: '0xyourusdtethaddress',
      USDTTRON: 'TYourusdttronaddress'
    };

    const address = depositAddresses[coin];
    if (!address) return res.status(400).json({ error: 'Invalid coin selected' });

    // Create deposit record in DB
    const txId = await db.addTransaction({
      user_id: req.session.userId,
      type: 'DEPOSIT',
      coin,
      amount,
      status: 'PENDING'
    });

    return res.json({
      ok: true,
      coin,
      address,
      amount,
      txId
    });

  } catch (err) {
    console.error('deposit error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ===== Withdraw Route =====
app.post('/withdraw', needAuth, async (req, res) => {
  try {
    const { coin, amount, address } = req.body;
    if (!coin || !amount || !address) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Optional: Validate address format based on coin
    const isValidAddress = true; // Add your address validation logic
    if (!isValidAddress) {
      return res.status(400).json({ error: 'Invalid withdrawal address' });
    }

    // Create withdrawal record
    const txId = await db.addTransaction({
      user_id: req.session.userId,
      type: 'WITHDRAW',
      coin,
      amount,
      status: 'PENDING',
      meta: JSON.stringify({ address })
    });

    return res.json({
      ok: true,
      txId,
      message: 'Withdrawal request submitted'
    });

  } catch (err) {
    console.error('withdraw error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));

async function submitDeposit(coin, amount) {
  try {
    const res = await fetch('/api/deposit', {
      method: 'POST',
      credentials: 'same-origin', // important to include session cookie
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin, amount })
    });
    const j = await res.json().catch(()=>null);
    if (!res.ok) {
      console.error('Deposit failed', j || res.status);
      alert(j?.error || `Deposit failed (${res.status})`);
      return;
    }
    console.log('Deposit OK', j);
    // show deposit address etc.
  } catch (err) {
    console.error('Network error', err);
    alert('Network error — make sure server is running and you are logged in');
  }
}

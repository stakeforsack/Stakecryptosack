const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');

const prisma = new PrismaClient();
const app = express();

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(express.json());

// JWT secret key
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

// Middleware: verify JWT
const needAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ----------- AUTH ROUTES -----------

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const exists = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (exists) {
      return res.status(400).json({ error: 'Email or username already taken' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, username, password: hashedPassword },
    });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token, user: { id: user.id, email, username } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token, user: { id: user.id, email, username: user.username } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ----------- TRANSACTIONS -----------

// Deposit
app.post('/api/deposit', needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;
    const tx = await prisma.transaction.create({
      data: {
        userId: req.userId,
        type: 'DEPOSIT',
        coin,
        amount: parseFloat(amount),
        status: 'PENDING'
      }
    });

    res.json({
      ok: true,
      address: getCoinAddress(coin),
      txId: tx.id
    });
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Withdraw
app.post('/api/withdraw', needAuth, async (req, res) => {
  try {
    const { coin, amount, address } = req.body;
    const tx = await prisma.transaction.create({
      data: {
        userId: req.userId,
        type: 'WITHDRAW',
        coin,
        amount: parseFloat(amount),
        status: 'PENDING',
        meta: JSON.stringify({ address })
      }
    });

    res.json({ ok: true, txId: tx.id });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Transactions list
app.get('/api/transactions', needAuth, async (req, res) => {
  try {
    const transactions = await prisma.transaction.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ ok: true, transactions });
  } catch (err) {
    console.error('Transaction history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// User session info (via token)
app.get('/api/session', needAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, username: true }
  });
  res.json({ ok: true, user });
});

// ----------- HELPERS -----------

function getCoinAddress(coin) {
  const addresses = {
    BTC: 'bc1example...',
    ETH: '0xexample...',
    USDT: 'TRexample...'
  };
  return addresses[coin] || '';
}

// ----------- START SERVER -----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

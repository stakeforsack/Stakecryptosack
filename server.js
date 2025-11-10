const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');

const prisma = new PrismaClient();
const app = express();

// CORS middleware
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// Handle preflight requests
app.options('*', cors());

// Parse JSON bodies
app.use(express.json());

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'none',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Auth middleware
const needAuth = async (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please login' });
  }
  next();
};

// Update route to include /api prefix
app.post('/api/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    
    // Validate input
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if user exists
    const exists = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username }
        ]
      }
    });

    if (exists) {
      return res.status(400).json({ error: 'Email or username already taken' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = await prisma.user.create({
      data: {
        email,
        username,
        password: hashedPassword
      }
    });

    // Set session
    req.session.userId = user.id;
    res.json({ ok: true });
    
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Update login endpoint with better error handling
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({ 
      where: { email } 
    });

    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.userId = user.id;
    res.json({ ok: true });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Update deposit endpoint to include /api prefix
app.post('/api/deposit', needAuth, async (req, res) => {
  try {
    const { coin, amount } = req.body;
    const userId = req.session.userId;

    const tx = await prisma.transaction.create({
      data: {
        userId,
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

// Update withdraw endpoint to include /api prefix
app.post('/api/withdraw', needAuth, async (req, res) => {
  try {
    const { coin, amount, address } = req.body;
    const userId = req.session.userId;

    const tx = await prisma.transaction.create({
      data: {
        userId,
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

// Update transactions endpoint to include /api prefix
app.get('/api/transactions', needAuth, async (req, res) => {
  try {
    const transactions = await prisma.transaction.findMany({
      where: { userId: req.session.userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ ok: true, transactions });
  } catch (err) {
    console.error('Transaction history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add session check endpoint
app.get('/api/session', async (req, res) => {
  if (req.session.userId) {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: { id: true, email: true, username: true }
    });
    res.json({ ok: true, user });
  } else {
    res.status(401).json({ ok: false });
  }
});

// Helper function for coin addresses
function getCoinAddress(coin) {
  const addresses = {
    BTC: 'bc1example...',
    ETH: '0xexample...',
    USDT: 'TRexample...'
    // Add more coins as needed
  };
  return addresses[coin] || '';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

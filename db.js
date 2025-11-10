const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { PrismaClient } = require('@prisma/client')

const DB_PATH = path.join(__dirname, 'data.sqlite');
const needInit = !fs.existsSync(DB_PATH);
const db = new sqlite3.Database(DB_PATH);
const prisma = new PrismaClient()

// ===== Helpers for Promises =====
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// ===== Schema Init =====
async function init() {
  await run(`PRAGMA journal_mode=WAL;`);

  // USERS TABLE
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      email TEXT UNIQUE,
      bio TEXT,
      password_hash TEXT,
      twofa_enabled INTEGER DEFAULT 0,
      twofa_secret TEXT,
      vip INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // PAYMENT METHODS
  await run(`
    CREATE TABLE IF NOT EXISTS payment_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // TRANSACTIONS
  await run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT,
      coin TEXT,
      amount TEXT,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      meta TEXT
    )
  `);

  // DEPOSITS
  await run(`
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      coin TEXT,
      amount_expected TEXT,
      amount_received TEXT,
      address TEXT,
      tx_hash TEXT,
      status TEXT,
      confirmations INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // VERIFICATIONS
  await run(`
    CREATE TABLE IF NOT EXISTS verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      front_path TEXT,
      back_path TEXT,
      selfie_path TEXT,
      status TEXT,
      created_at TEXT
    )
  `);

  // SUPPORT TICKETS
  await run(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      subject TEXT,
      message TEXT,
      status TEXT,
      created_at TEXT
    )
  `);

  // Seed a test user if empty
  const existingUser = await get(`SELECT id FROM users LIMIT 1`);
  if (!existingUser) {
    await run(
      `INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, datetime('now'))`,
      ['tester', 'tester@example.com', '']
    );
  }
}

// ===== PUBLIC API =====
module.exports = {
  init,
  getUserById: id => get(`SELECT * FROM users WHERE id = ?`, [id]),
  getUserByEmail: email => get(`SELECT * FROM users WHERE email = ? LIMIT 1`, [email]),
  getUserByUsername: username => get(`SELECT * FROM users WHERE username = ? LIMIT 1`, [username]),
  createUser: async ({ username, email, password_hash = '' }) => {
    const r = await run(
      `INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, datetime('now'))`,
      [username, email, password_hash]
    );
    return r.lastID;
  },
  updateUser: async (id, fields = {}) => {
    const validCols = ['username', 'email', 'bio', 'twofa_enabled', 'twofa_secret', 'vip'];
    const keys = Object.keys(fields).filter(k => validCols.includes(k));
    if (keys.length === 0) return;

    const sets = keys.map(k => `${k} = ?`).join(', ');
    const vals = keys.map(k => fields[k]);
    vals.push(id);

    return run(`UPDATE users SET ${sets} WHERE id = ?`, vals);
  },
  getPaymentMethods: userId => all(`SELECT * FROM payment_methods WHERE user_id = ? ORDER BY id DESC`, [userId]),
  addPaymentMethod: async ({ user_id, type, details }) => {
    const r = await run(
      `INSERT INTO payment_methods (user_id, type, details, created_at) VALUES (?, ?, ?, datetime('now'))`,
      [user_id, type, details]
    );
    return r.lastID;
  },
  getPaymentMethodById: id => get(`SELECT * FROM payment_methods WHERE id = ?`, [id]),
  removePaymentMethod: id => run(`DELETE FROM payment_methods WHERE id = ?`, [id]),
  getTransactions: (userId, page = 1, limit = 20) => {
    const offset = (Math.max(1, page) - 1) * limit;
    return all(
      `SELECT id, type, coin, amount, status, created_at
       FROM transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
  },
  addTransaction: async tx => {
    const { user_id, type, coin, amount, status = 'PENDING', meta = null } = tx;
    const r = await run(
      `INSERT INTO transactions (user_id, type, coin, amount, status, meta, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [user_id, type, coin, amount, status, meta]
    );
    return r.lastID;
  },
  createVerification: async record => {
    const { user_id, front_path, back_path, selfie_path, status = 'PENDING', created_at = new Date().toISOString() } = record;
    const r = await run(
      `INSERT INTO verifications (user_id, front_path, back_path, selfie_path, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user_id, front_path, back_path, selfie_path, status, created_at]
    );
    return r.lastID;
  },
  createSupportTicket: async ticket => {
    const { user_id, subject, message, status = 'OPEN', created_at = new Date().toISOString() } = ticket;
    const r = await run(
      `INSERT INTO support_tickets (user_id, subject, message, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [user_id, subject, message, status, created_at]
    );
    return r.lastID;
  },

  // ===== DEPOSITS =====
  createDeposit: async ({ user_id, coin, amount_expected, address }) => {
    const r = await run(
      `INSERT INTO deposits (user_id, coin, amount_expected, address, status, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [user_id, coin, amount_expected, address, 'PENDING']
    );
    return r.lastID;
  },

  confirmDeposit: async (depositId, amount_received, tx_hash, confirmations = 0) => {
    await run(
      `UPDATE deposits SET status = ?, amount_received = ?, tx_hash = ?, confirmations = ? WHERE id = ?`,
      ['COMPLETED', amount_received, tx_hash, confirmations, depositId]
    );

    const deposit = await get(`SELECT * FROM deposits WHERE id = ?`, [depositId]);
    if (deposit) {
      await run(
        `INSERT INTO transactions (user_id, type, coin, amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [deposit.user_id, 'DEPOSIT', deposit.coin, amount_received, 'COMPLETED']
      );
    }
  },

  // Helper to get deposits for a user
  getDeposits: userId => all(`SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC`, [userId]),

  async createUser({ email, username, password }) {
    return prisma.user.create({
      data: { email, username, password }
    })
  },

  async getUserById(id) {
    return prisma.user.findUnique({ where: { id } })
  },

  async getUserByEmail(email) {
    return prisma.user.findUnique({ where: { email } })
  },

  async addTransaction({ user_id, type, coin, amount, status = 'PENDING', meta = null }) {
    return prisma.transaction.create({
      data: {
        userId: user_id,
        type,
        coin,
        amount,
        status,
        meta: meta ? JSON.stringify(meta) : null
      }
    })
  },

  async getTransactions(userId) {
    return prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    })
  }
};

// Auto-init DB schema
init().catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});

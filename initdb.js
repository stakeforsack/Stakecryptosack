const path = require('path');
const sqlite3 = require('sqlite3').verbose();

try {
    console.log('Starting database initialization...');
    
    const dbPath = path.join(__dirname, 'data.sqlite');
    const db = new sqlite3.Database(dbPath);

    console.log(`Creating database at: ${dbPath}`);

    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE,
                username TEXT UNIQUE,
                password TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        db.run(`
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
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
        `);
    });

    console.log('Database schema created successfully!');
    db.close();
    console.log('Database connection closed.');

} catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
}
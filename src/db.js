const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(path.join(dbDir, 'waged.db'));

// Enable WAL mode for high concurrent performance and reliability
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize core schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    phone TEXT,
    telegram_chat_id TEXT,
    telegram_link_token TEXT UNIQUE,
    plan_id TEXT DEFAULT 'free',
    subscription_status TEXT DEFAULT 'active',
    subscription_expires_at DATETIME,
    webhook_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    public_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'car',
    custom_message TEXT,
    status TEXT DEFAULT 'active',
    require_location INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    accuracy REAL,
    ip_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    unread_owner INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
    UNIQUE(item_id, session_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender_type TEXT NOT NULL CHECK(sender_type IN ('scanner', 'owner', 'system')),
    message TEXT NOT NULL,
    lat REAL,
    lng REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subscription_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_id TEXT NOT NULL,
    amount REAL DEFAULT 0,
    currency TEXT DEFAULT 'EGP',
    billing_cycle TEXT DEFAULT 'monthly',
    status TEXT DEFAULT 'paid',
    reference_code TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_items_code ON items(public_code);
  CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);
  CREATE INDEX IF NOT EXISTS idx_chats_item_session ON chats(item_id, session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_sub_user ON subscription_logs(user_id);
`);

// Safe migrations for existing databases
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('plan_id')) {
  db.exec("ALTER TABLE users ADD COLUMN plan_id TEXT DEFAULT 'free'");
}
if (!userCols.includes('subscription_status')) {
  db.exec("ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'active'");
}
if (!userCols.includes('subscription_expires_at')) {
  db.exec("ALTER TABLE users ADD COLUMN subscription_expires_at DATETIME");
}
if (!userCols.includes('webhook_url')) {
  db.exec("ALTER TABLE users ADD COLUMN webhook_url TEXT");
}

const chatCols = db.prepare("PRAGMA table_info(chats)").all().map(c => c.name);
if (!chatCols.includes('unread_owner')) {
  db.exec("ALTER TABLE chats ADD COLUMN unread_owner INTEGER DEFAULT 0");
}

module.exports = db;

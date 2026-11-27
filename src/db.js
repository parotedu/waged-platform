const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');

const DATABASE_URL = process.env.DATABASE_URL || '';
const isPostgres = Boolean(DATABASE_URL && /^postgres(ql)?:\/\//i.test(DATABASE_URL));

let sqliteDb = null;
let pgPool = null;

function convertPlaceholders(sql) {
  let index = 0;
  let inSingleQuote = false;
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inSingleQuote && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      out += ch;
    } else if (ch === '?' && !inSingleQuote) {
      index += 1;
      out += `$${index}`;
    } else {
      out += ch;
    }
  }
  return out;
}

if (isPostgres) {
  const { Pool } = require('pg');
  const useSsl = process.env.DB_SSL !== 'false' && !/localhost|127\.0\.0\.1/i.test(DATABASE_URL);
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  });
  console.log('🗄️ Database Mode: PostgreSQL');
} else {
  const Database = require('better-sqlite3');
  const dbDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const dbPath = path.join(dbDir, 'waged.db');
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
  sqliteDb.pragma('busy_timeout = 5000');
  console.log(`🗄️ Database Mode: SQLite (${dbPath})`);
}

function makeRunner(pgClient) {
  return {
    async get(sql, params = []) {
      if (isPostgres) {
        const res = await pgClient.query(convertPlaceholders(sql), params);
        return res.rows[0] || null;
      }
      return sqliteDb.prepare(sql).get(...params) || null;
    },

    async all(sql, params = []) {
      if (isPostgres) {
        const res = await pgClient.query(convertPlaceholders(sql), params);
        return res.rows;
      }
      return sqliteDb.prepare(sql).all(...params);
    },

    async run(sql, params = []) {
      if (isPostgres) {
        let q = convertPlaceholders(sql).trim();
        const isInsert = /^insert\s+/i.test(q);
        if (isInsert && !/\breturning\b/i.test(q)) {
          q += ' RETURNING id';
        }
        const res = await pgClient.query(q, params);
        return {
          lastInsertRowid: isInsert && res.rows[0] ? res.rows[0].id : null,
          changes: res.rowCount || 0
        };
      }
      const info = sqliteDb.prepare(sql).run(...params);
      return {
        lastInsertRowid: info.lastInsertRowid,
        changes: info.changes
      };
    }
  };
}

const baseRunner = makeRunner(pgPool);

async function tx(fn) {
  if (isPostgres) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(makeRunner(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    sqliteDb.exec('BEGIN');
    try {
      const result = await fn(baseRunner);
      sqliteDb.exec('COMMIT');
      return result;
    } catch (err) {
      sqliteDb.exec('ROLLBACK');
      throw err;
    }
  }
}

async function initDb() {
  const idCol = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const tsCol = isPostgres ? 'TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';
  const tsNullCol = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME';
  const realCol = isPostgres ? 'DOUBLE PRECISION' : 'REAL';

  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id ${idCol},
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      phone TEXT,
      role TEXT DEFAULT 'user',
      telegram_chat_id TEXT,
      telegram_link_token TEXT UNIQUE,
      plan_id TEXT DEFAULT 'free',
      subscription_status TEXT DEFAULT 'active',
      subscription_expires_at ${tsNullCol},
      webhook_url TEXT,
      created_at ${tsCol}
    )`,
    `CREATE TABLE IF NOT EXISTS items (
      id ${idCol},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'car',
      custom_message TEXT,
      status TEXT DEFAULT 'active',
      require_location INTEGER DEFAULT 1,
      created_at ${tsCol}
    )`,
    `CREATE TABLE IF NOT EXISTS scans (
      id ${idCol},
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      latitude ${realCol},
      longitude ${realCol},
      accuracy ${realCol},
      ip_hash TEXT,
      created_at ${tsCol}
    )`,
    `CREATE TABLE IF NOT EXISTS chats (
      id ${idCol},
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      unread_owner INTEGER DEFAULT 0,
      created_at ${tsCol},
      updated_at ${tsCol},
      UNIQUE(item_id, session_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id ${idCol},
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL CHECK(sender_type IN ('scanner', 'owner', 'system')),
      message TEXT NOT NULL,
      lat ${realCol},
      lng ${realCol},
      created_at ${tsCol}
    )`,
    `CREATE TABLE IF NOT EXISTS subscription_logs (
      id ${idCol},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL,
      amount ${realCol} DEFAULT 0,
      currency TEXT DEFAULT 'EGP',
      billing_cycle TEXT DEFAULT 'monthly',
      status TEXT DEFAULT 'paid',
      reference_code TEXT NOT NULL,
      created_at ${tsCol}
    )`,
    `CREATE TABLE IF NOT EXISTS subscription_requests (
      id ${idCol},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL,
      billing_cycle TEXT DEFAULT 'monthly',
      amount ${realCol} NOT NULL,
      currency TEXT DEFAULT 'EGP',
      payment_method TEXT DEFAULT 'instapay',
      target_number TEXT NOT NULL,
      sender_account TEXT NOT NULL,
      reference_note TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      admin_note TEXT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at ${tsNullCol},
      created_at ${tsCol}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_items_code ON items(public_code)`,
    `CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chats_item_session ON chats(item_id, session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_user ON subscription_logs(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_req_status ON subscription_requests(status)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_req_user ON subscription_requests(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_tg_token ON users(telegram_link_token)`
  ];

  for (const stmt of statements) {
    if (isPostgres) {
      await pgPool.query(stmt);
    } else {
      sqliteDb.exec(stmt);
    }
  }

  // Safe migrations for existing SQLite or Postgres schemas
  if (isPostgres) {
    await pgPool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'");
    await pgPool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_id TEXT DEFAULT 'free'");
    await pgPool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active'");
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ');
    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS webhook_url TEXT');
    await pgPool.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS unread_owner INTEGER DEFAULT 0');
  } else {
    const userCols = sqliteDb.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    if (!userCols.includes('role')) sqliteDb.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
    if (!userCols.includes('plan_id')) sqliteDb.exec("ALTER TABLE users ADD COLUMN plan_id TEXT DEFAULT 'free'");
    if (!userCols.includes('subscription_status')) sqliteDb.exec("ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'active'");
    if (!userCols.includes('subscription_expires_at')) sqliteDb.exec('ALTER TABLE users ADD COLUMN subscription_expires_at DATETIME');
    if (!userCols.includes('webhook_url')) sqliteDb.exec('ALTER TABLE users ADD COLUMN webhook_url TEXT');

    const chatCols = sqliteDb.prepare('PRAGMA table_info(chats)').all().map(c => c.name);
    if (!chatCols.includes('unread_owner')) sqliteDb.exec('ALTER TABLE chats ADD COLUMN unread_owner INTEGER DEFAULT 0');
  }

  // Seed the single dedicated Super Admin account if none exists
  const existingSuper = await baseRunner.get("SELECT id, email FROM users WHERE role = 'super_admin' LIMIT 1");
  if (!existingSuper) {
    const existingByEmail = await baseRunner.get('SELECT id FROM users WHERE email = ?', [config.SUPER_ADMIN_EMAIL]);
    const passwordHash = bcrypt.hashSync(config.SUPER_ADMIN_PASSWORD, 12);
    if (existingByEmail) {
      await baseRunner.run(
        "UPDATE users SET role = 'super_admin', plan_id = 'business', subscription_status = 'active' WHERE id = ?",
        [existingByEmail.id]
      );
    } else {
      const linkToken = crypto.randomBytes(16).toString('hex');
      await baseRunner.run(
        `INSERT INTO users (name, email, password_hash, role, telegram_link_token, plan_id, subscription_status)
         VALUES (?, ?, ?, 'super_admin', ?, 'business', 'active')`,
        [config.SUPER_ADMIN_NAME, config.SUPER_ADMIN_EMAIL, passwordHash, linkToken]
      );
    }
    console.log(`🛡️ Dedicated Super Admin ready: ${config.SUPER_ADMIN_EMAIL}`);
  }
}

async function closeDb() {
  if (isPostgres && pgPool) {
    await pgPool.end();
  } else if (sqliteDb) {
    sqliteDb.close();
  }
}

module.exports = {
  isPostgres,
  get: baseRunner.get,
  all: baseRunner.all,
  run: baseRunner.run,
  tx,
  initDb,
  closeDb
};

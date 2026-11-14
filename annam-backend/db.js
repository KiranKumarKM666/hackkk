let Database;
try {
  Database = require('better-sqlite3');
} catch {
  const { DatabaseSync } = require('node:sqlite');
  Database = class BetterSqlite3Compat {
    constructor(file) {
      this.raw = new DatabaseSync(file);
      this.inTx = 0;
    }
    exec(sql) {
      return this.raw.exec(sql);
    }
    pragma(cmd) {
      try {
        return this.raw.exec(`PRAGMA ${cmd};`);
      } catch (e) {
        return null;
      }
    }
    prepare(sql) {
      const stmt = this.raw.prepare(sql);
      const sanitize = v => (v === undefined ? null : v);
      return {
        run: (...params) => {
          const res = stmt.run(...params.map(sanitize));
          return {
            changes: res.changes,
            lastInsertRowid: Number(res.lastInsertRowid)
          };
        },
        get: (...params) => stmt.get(...params.map(sanitize)),
        all: (...params) => stmt.all(...params.map(sanitize))
      };
    }
    transaction(fn) {
      return (...args) => {
        const isOuter = (this.inTx === 0);
        const sp = `tx_${this.inTx++}`;
        if (isOuter) this.raw.exec('BEGIN'); else this.raw.exec(`SAVEPOINT ${sp}`);
        try {
          const res = fn(...args);
          if (isOuter) this.raw.exec('COMMIT'); else this.raw.exec(`RELEASE SAVEPOINT ${sp}`);
          return res;
        } catch (err) {
          if (isOuter) this.raw.exec('ROLLBACK'); else this.raw.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw err;
        } finally {
          this.inTx--;
        }
      };
    }
  };
}
const path = require('path');
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'annam.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS donors (
  donor_id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, node INTEGER NOT NULL, contact TEXT);
CREATE TABLE IF NOT EXISTS receivers (
  receiver_id INTEGER PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, node INTEGER NOT NULL,
  capacity_portions INTEGER NOT NULL, diet_rules TEXT NOT NULL DEFAULT 'any', -- 'any' | 'veg_only'
  can_collect INTEGER NOT NULL DEFAULT 0, need_level INTEGER NOT NULL DEFAULT 3, contact TEXT);
CREATE TABLE IF NOT EXISTS volunteers (
  volunteer_id INTEGER PRIMARY KEY, name TEXT NOT NULL, vehicle TEXT, capacity INTEGER NOT NULL,
  shift_start REAL NOT NULL, shift_end REAL NOT NULL); -- hours; end may exceed 24 for overnight
CREATE TABLE IF NOT EXISTS safety_rules (
  food_type TEXT NOT NULL, holding_method TEXT NOT NULL, safe_minutes INTEGER NOT NULL,
  PRIMARY KEY (food_type, holding_method));
CREATE TABLE IF NOT EXISTS posts (
  post_id INTEGER PRIMARY KEY AUTOINCREMENT, donor_id INTEGER NOT NULL REFERENCES donors(donor_id),
  portions INTEGER NOT NULL, kg_estimate REAL NOT NULL, diet_type TEXT NOT NULL,
  food_type TEXT NOT NULL, holding_method TEXT NOT NULL, packaging TEXT,
  cooked_at INTEGER NOT NULL, ready_at INTEGER NOT NULL, safe_until INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open|matched|in_transit|delivered|expired
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS routes (
  route_id INTEGER PRIMARY KEY AUTOINCREMENT, volunteer_id INTEGER, receiver_id INTEGER NOT NULL,
  stops TEXT NOT NULL, etas TEXT NOT NULL, total_minutes REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned', -- planned|in_transit|completed|cancelled
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS matches (
  match_id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES posts(post_id),
  receiver_id INTEGER NOT NULL REFERENCES receivers(receiver_id), route_id INTEGER,
  score REAL, reason TEXT, status TEXT NOT NULL DEFAULT 'proposed', -- proposed|accepted|declined|cancelled
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS handovers (
  handover_id INTEGER PRIMARY KEY AUTOINCREMENT, match_id INTEGER NOT NULL UNIQUE REFERENCES matches(match_id),
  otp_hash TEXT NOT NULL, photo TEXT, donor_confirmed INTEGER NOT NULL DEFAULT 0,
  receiver_confirmed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, completed_at INTEGER);
CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, type TEXT NOT NULL, detail TEXT, timestamp INTEGER NOT NULL);
-- Legacy NGO OTP portal (meals / ration / biogas) used by the existing front end
CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, phone TEXT NOT NULL, ngo TEXT NOT NULL, payload TEXT NOT NULL,
  otp TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', created_month TEXT NOT NULL,
  served_at TEXT, served_month TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_matches_post ON matches(post_id);
`);
module.exports = db;

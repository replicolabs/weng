import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  croo_order_id      TEXT UNIQUE,
  croo_negotiation_id TEXT NOT NULL,
  service            TEXT NOT NULL CHECK (service IN ('open_position', 'close_position')),
  exposure           TEXT NOT NULL CHECK (exposure IN ('bonds', 'sp500')),
  state              TEXT NOT NULL,
  position_id        TEXT,
  amount_usdc        TEXT NOT NULL,
  requirements_json  TEXT NOT NULL,
  tx_refs_json       TEXT NOT NULL DEFAULT '{}',
  error              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id                    TEXT PRIMARY KEY,
  exposure              TEXT NOT NULL CHECK (exposure IN ('bonds', 'sp500')),
  open_order_id         TEXT NOT NULL REFERENCES orders(id),
  requester_agent_id    TEXT NOT NULL,
  -- Populated at open time from the CROO order's own requesterWalletAddress
  -- (not derivable from the negotiation object). Needed so the liquidation
  -- guard can pay a requester back without a CROO order to look it up from —
  -- its emergency auto-close isn't triggered by any negotiation.
  requester_wallet_address TEXT,
  status                TEXT NOT NULL CHECK (status IN ('open', 'closing', 'closed')),
  amount_deployed_usdc  TEXT NOT NULL,
  bond_token            TEXT,
  bond_units            TEXT,
  venue                 TEXT,
  venue_reason          TEXT,
  entry_price           TEXT,
  position_size         TEXT,
  -- 'auto_close': liquidation guard closes + refunds automatically at the ACT
  -- threshold. 'warn_only': guard only ever logs/marks state, never moves
  -- funds — requester's own choice per section 2.4's ACT-tier design.
  liquidation_action    TEXT NOT NULL DEFAULT 'auto_close' CHECK (liquidation_action IN ('auto_close', 'warn_only')),
  -- 'at_risk': past the ACT threshold but liquidation_action='warn_only', so
  -- the guard didn't act. Distinct from 'warn' (past WARN, not yet ACT).
  guard_status          TEXT CHECK (guard_status IN ('ok', 'warn', 'at_risk', 'acted')),
  guard_last_checked_at TEXT,
  guard_action_tx_hashes_json TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
`;

// Additive migrations for DBs created before these columns existed — plain
// CREATE TABLE IF NOT EXISTS above is a no-op against an already-existing
// table, so new columns need an explicit, idempotent ALTER TABLE here.
const MIGRATIONS = [
  `ALTER TABLE positions ADD COLUMN liquidation_action TEXT NOT NULL DEFAULT 'auto_close'`,
  `ALTER TABLE positions ADD COLUMN guard_action_tx_hashes_json TEXT`,
  `ALTER TABLE positions ADD COLUMN requester_wallet_address TEXT`,
];

export function openDb(filePath: string): Db {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("duplicate column")) throw err;
    }
  }
  return db;
}

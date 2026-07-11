import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { Exposure } from "./orderStateMachine.js";

export type LiquidationAction = "auto_close" | "warn_only";
export type GuardStatus = "ok" | "warn" | "at_risk" | "acted";

export interface PositionRow {
  id: string;
  exposure: Exposure;
  open_order_id: string;
  requester_agent_id: string;
  requester_wallet_address: string | null;
  status: "open" | "closing" | "closed";
  amount_deployed_usdc: string;
  bond_token: string | null;
  bond_units: string | null;
  venue: string | null;
  venue_reason: string | null;
  entry_price: string | null;
  position_size: string | null;
  liquidation_action: LiquidationAction;
  guard_status: GuardStatus | null;
  guard_last_checked_at: string | null;
  guard_action_tx_hashes_json: string | null;
  created_at: string;
  updated_at: string;
}

export function createPosition(
  db: Db,
  args: {
    exposure: Exposure;
    openOrderId: string;
    requesterAgentId: string;
    requesterWalletAddress?: string;
    amountDeployedUsdc: string;
    bondToken?: string;
    bondUnits?: string;
    venue?: string;
    venueReason?: string;
    entryPrice?: string;
    positionSize?: string;
    liquidationAction?: LiquidationAction;
  }
): PositionRow {
  const now = new Date().toISOString();
  const row: PositionRow = {
    id: randomUUID(),
    exposure: args.exposure,
    open_order_id: args.openOrderId,
    requester_agent_id: args.requesterAgentId,
    requester_wallet_address: args.requesterWalletAddress ?? null,
    status: "open",
    amount_deployed_usdc: args.amountDeployedUsdc,
    bond_token: args.bondToken ?? null,
    bond_units: args.bondUnits ?? null,
    venue: args.venue ?? null,
    venue_reason: args.venueReason ?? null,
    entry_price: args.entryPrice ?? null,
    position_size: args.positionSize ?? null,
    liquidation_action: args.liquidationAction ?? "auto_close",
    guard_status: null,
    guard_last_checked_at: null,
    guard_action_tx_hashes_json: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO positions (id, exposure, open_order_id, requester_agent_id, requester_wallet_address, status,
       amount_deployed_usdc, bond_token, bond_units, venue, venue_reason, entry_price, position_size,
       liquidation_action, guard_status, guard_last_checked_at, guard_action_tx_hashes_json, created_at, updated_at)
     VALUES (@id, @exposure, @open_order_id, @requester_agent_id, @requester_wallet_address, @status,
       @amount_deployed_usdc, @bond_token, @bond_units, @venue, @venue_reason, @entry_price, @position_size,
       @liquidation_action, @guard_status, @guard_last_checked_at, @guard_action_tx_hashes_json, @created_at, @updated_at)`
  ).run(row);
  return row;
}

export function getPosition(db: Db, id: string): PositionRow | undefined {
  return db.prepare(`SELECT * FROM positions WHERE id = ?`).get(id) as PositionRow | undefined;
}

export function getOpenPositions(db: Db, exposure?: Exposure): PositionRow[] {
  if (exposure) {
    return db.prepare(`SELECT * FROM positions WHERE status = 'open' AND exposure = ?`).all(exposure) as PositionRow[];
  }
  return db.prepare(`SELECT * FROM positions WHERE status = 'open'`).all() as PositionRow[];
}

export function setPositionStatus(db: Db, id: string, status: PositionRow["status"]): void {
  db.prepare(`UPDATE positions SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    id
  );
}

export function setGuardStatus(
  db: Db,
  id: string,
  status: GuardStatus,
  opts: { actionTxHashes?: Record<string, string> } = {}
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE positions SET guard_status = ?, guard_last_checked_at = ?, updated_at = ?,
       guard_action_tx_hashes_json = COALESCE(?, guard_action_tx_hashes_json)
     WHERE id = ?`
  ).run(status, now, now, opts.actionTxHashes ? JSON.stringify(opts.actionTxHashes) : null, id);
}

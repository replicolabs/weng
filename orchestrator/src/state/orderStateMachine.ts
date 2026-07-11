import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

export type Exposure = "bonds" | "sp500";
export type Service = "open_position" | "close_position";

// Linear pipelines. "failed" is reachable from any non-terminal state and is
// not listed per-pipeline. Terminal state is always the last entry.
const PIPELINES: Record<Service, Record<Exposure, readonly string[]>> = {
  open_position: {
    bonds: ["received", "swapping", "swapped", "delivered"],
    sp500: ["received", "bridging", "bridged", "opening", "open", "delivered"],
  },
  close_position: {
    bonds: ["received", "selling", "sold", "delivered"],
    sp500: ["received", "closing_position", "closed_position", "bridging_back", "bridged_back", "delivered"],
  },
};

export interface OrderRow {
  id: string;
  croo_order_id: string | null;
  croo_negotiation_id: string;
  service: Service;
  exposure: Exposure;
  state: string;
  position_id: string | null;
  amount_usdc: string;
  requirements_json: string;
  tx_refs_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class InvalidTransitionError extends Error {
  constructor(orderId: string, from: string, to: string) {
    super(`order ${orderId}: cannot transition ${from} -> ${to}`);
  }
}

export function pipelineFor(service: Service, exposure: Exposure): readonly string[] {
  return PIPELINES[service][exposure];
}

export function createOrder(
  db: Db,
  args: {
    crooNegotiationId: string;
    service: Service;
    exposure: Exposure;
    amountUsdc: string;
    requirements: unknown;
  }
): OrderRow {
  const now = new Date().toISOString();
  const row: OrderRow = {
    id: randomUUID(),
    croo_order_id: null,
    croo_negotiation_id: args.crooNegotiationId,
    service: args.service,
    exposure: args.exposure,
    state: pipelineFor(args.service, args.exposure)[0]!,
    position_id: null,
    amount_usdc: args.amountUsdc,
    requirements_json: JSON.stringify(args.requirements),
    tx_refs_json: "{}",
    error: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO orders (id, croo_order_id, croo_negotiation_id, service, exposure, state, position_id,
       amount_usdc, requirements_json, tx_refs_json, error, created_at, updated_at)
     VALUES (@id, @croo_order_id, @croo_negotiation_id, @service, @exposure, @state, @position_id,
       @amount_usdc, @requirements_json, @tx_refs_json, @error, @created_at, @updated_at)`
  ).run(row);
  return row;
}

export function getOrder(db: Db, id: string): OrderRow | undefined {
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
}

export function getOrderByCrooOrderId(db: Db, crooOrderId: string): OrderRow | undefined {
  return db.prepare(`SELECT * FROM orders WHERE croo_order_id = ?`).get(crooOrderId) as OrderRow | undefined;
}

export function attachCrooOrderId(db: Db, id: string, crooOrderId: string): void {
  db.prepare(`UPDATE orders SET croo_order_id = ?, updated_at = ? WHERE id = ?`).run(
    crooOrderId,
    new Date().toISOString(),
    id
  );
}

/**
 * Idempotent, checkpointed transition. If the order is already at `toState`
 * this is a no-op (safe to call again after a crash/restart). Moving to
 * "failed" is always allowed as an abort path. Any other transition must be
 * exactly the next step in the pipeline for this service+exposure, or it
 * throws rather than silently skipping steps.
 */
export function transition(
  db: Db,
  id: string,
  toState: string,
  opts: { txRef?: { step: string; hash: string }; error?: string } = {}
): OrderRow {
  const run = db.transaction(() => {
    const order = getOrder(db, id);
    if (!order) throw new Error(`order ${id} not found`);

    if (order.state === toState) {
      if (opts.txRef) mergeTxRef(db, order, opts.txRef);
      return getOrder(db, id)!;
    }

    if (toState !== "failed") {
      const pipeline = pipelineFor(order.service, order.exposure);
      const fromIdx = pipeline.indexOf(order.state);
      const toIdx = pipeline.indexOf(toState);
      if (fromIdx === -1 || toIdx !== fromIdx + 1) {
        throw new InvalidTransitionError(id, order.state, toState);
      }
    }

    const now = new Date().toISOString();
    db.prepare(`UPDATE orders SET state = ?, error = ?, updated_at = ? WHERE id = ?`).run(
      toState,
      opts.error ?? null,
      now,
      id
    );
    if (opts.txRef) mergeTxRef(db, { ...order, state: toState }, opts.txRef);
    return getOrder(db, id)!;
  });
  return run();
}

function mergeTxRef(db: Db, order: OrderRow, txRef: { step: string; hash: string }): void {
  const refs = JSON.parse(order.tx_refs_json) as Record<string, string>;
  refs[txRef.step] = txRef.hash;
  db.prepare(`UPDATE orders SET tx_refs_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(refs),
    new Date().toISOString(),
    order.id
  );
}

export function isTerminal(order: OrderRow): boolean {
  const pipeline = pipelineFor(order.service, order.exposure);
  return order.state === "failed" || order.state === pipeline[pipeline.length - 1];
}

/** Orders that were mid-flight when the process last stopped — the crash-recovery entry point. */
export function listResumable(db: Db): OrderRow[] {
  const rows = db.prepare(`SELECT * FROM orders`).all() as OrderRow[];
  return rows.filter((r) => !isTerminal(r));
}

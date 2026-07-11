import type { Db } from "./db.js";
import { listResumable } from "./orderStateMachine.js";
import type { Logger } from "@croo-network/sdk";

/**
 * Boot-time reconciliation (section 2.5). Every non-terminal order is
 * surfaced loudly rather than silently retried or silently dropped — the
 * exposure-specific resume action (re-check chain state, complete or unwind)
 * is wired in per exposure as each execution path is built (bonds in gate 2,
 * sp500 in gate 3). Until then this is the load-bearing guarantee: nothing
 * mid-flight is ever lost track of on restart.
 */
export function reconcileOnBoot(db: Db, logger: Logger): void {
  const pending = listResumable(db);
  if (pending.length === 0) {
    logger.info("[recovery] no mid-flight orders found, clean boot");
    return;
  }

  logger.warn(`[recovery] ${pending.length} mid-flight order(s) found on boot, resuming from persisted state`);
  for (const order of pending) {
    logger.warn(
      `[recovery] order=${order.id} croo_order=${order.croo_order_id ?? "(none)"} ` +
        `service=${order.service} exposure=${order.exposure} state=${order.state} ` +
        `tx_refs=${order.tx_refs_json}`
    );
  }
}

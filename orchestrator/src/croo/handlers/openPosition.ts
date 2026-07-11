import type { AgentClient, Logger } from "@croo-network/sdk";
import type { Config } from "../../config.js";
import type { Db } from "../../state/db.js";
import { attachCrooOrderId, createOrder } from "../../state/orderStateMachine.js";
import { OpenPositionRequirements, parseRequirements } from "../schemas.js";

function minOrderFor(config: Config, exposure: "bonds" | "sp500"): number {
  return exposure === "bonds" ? config.MIN_ORDER_USDC_BONDS : config.MIN_ORDER_USDC_SP500;
}

/**
 * Handles an incoming Open Position negotiation: validates the requirements
 * this service committed to in the CROO Dashboard (section 2.1), enforcing
 * the enum/conditional-required rules the Dashboard's schema builder can't
 * express itself, then accepts (creating the on-chain order + a persisted
 * order record at state "received") or rejects with a clear reason.
 *
 * Execution (the actual bond purchase / sp500 open) is intentionally not
 * triggered here yet — it lands with the bonds path (gate 2) and sp500 path
 * (gate 3). An accepted order currently persists at "received" and advances
 * no further until that code exists. Do not point this handler at a live
 * negotiation stream until gate 2 is done, or accepted orders will run out
 * their SLA unfulfilled.
 */
export async function handleOpenPositionNegotiation(
  db: Db,
  client: AgentClient,
  config: Config,
  logger: Logger,
  negotiationId: string,
  fundAddress: string
): Promise<void> {
  const negotiation = await client.getNegotiation(negotiationId);

  const parsed = parseRequirements(OpenPositionRequirements, negotiation.requirements);
  if (!parsed.ok) {
    logger.warn(`[open_position] rejecting ${negotiationId}: ${parsed.reason}`);
    await client.rejectNegotiation(negotiationId, parsed.reason);
    return;
  }

  const req = parsed.data;
  const floor = minOrderFor(config, req.target_exposure);
  if (req.amount_usdc < floor) {
    const reason = `amount_usdc ${req.amount_usdc} is below the ${req.target_exposure} minimum of ${floor} USDC`;
    logger.warn(`[open_position] rejecting ${negotiationId}: ${reason}`);
    await client.rejectNegotiation(negotiationId, reason);
    return;
  }

  const result = await client.acceptNegotiationWithFundAddress(negotiationId, fundAddress);
  logger.info(`[open_position] accepted ${negotiationId} -> order ${result.order.orderId}`);

  const order = createOrder(db, {
    crooNegotiationId: negotiationId,
    service: "open_position",
    exposure: req.target_exposure,
    amountUsdc: String(req.amount_usdc),
    requirements: req,
  });
  attachCrooOrderId(db, order.id, result.order.orderId);
  logger.info(`[open_position] order ${order.id} persisted at state ${order.state}`);
}

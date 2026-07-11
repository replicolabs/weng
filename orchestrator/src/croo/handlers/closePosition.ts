import type { AgentClient, Logger } from "@croo-network/sdk";
import type { Db } from "../../state/db.js";
import { attachCrooOrderId, createOrder } from "../../state/orderStateMachine.js";
import { getPosition, setPositionStatus } from "../../state/positions.js";
import { ClosePositionRequirements, parseRequirements } from "../schemas.js";

/**
 * Handles an incoming Close Position negotiation. Unlike Open Position, this
 * service does not enable require_fund_transfer: the requester isn't sending
 * Weng additional principal, and the SDK's fund-transfer fields are
 * documented as inbound-only (requester -> providerFundAddress). Returning
 * capital to the requester on Close is a Weng-initiated on-chain payment,
 * separate from CAP's escrow — so this uses plain acceptNegotiation.
 *
 * As with openPosition, execution (redeem/close + pay the requester back) is
 * not triggered here yet — it lands with the bonds (gate 2) and sp500 (gate 3)
 * paths. This handler validates, authorizes against the caller's own
 * position, and creates the persisted order at "received".
 */
export async function handleClosePositionNegotiation(
  db: Db,
  client: AgentClient,
  logger: Logger,
  negotiationId: string
): Promise<void> {
  const negotiation = await client.getNegotiation(negotiationId);

  const parsed = parseRequirements(ClosePositionRequirements, negotiation.requirements);
  if (!parsed.ok) {
    logger.warn(`[close_position] rejecting ${negotiationId}: ${parsed.reason}`);
    await client.rejectNegotiation(negotiationId, parsed.reason);
    return;
  }

  const position = getPosition(db, parsed.data.position_id);
  if (!position) {
    const reason = `no position found with id ${parsed.data.position_id}`;
    logger.warn(`[close_position] rejecting ${negotiationId}: ${reason}`);
    await client.rejectNegotiation(negotiationId, reason);
    return;
  }
  if (position.status !== "open") {
    const reason = `position ${position.id} is not open (status: ${position.status})`;
    logger.warn(`[close_position] rejecting ${negotiationId}: ${reason}`);
    await client.rejectNegotiation(negotiationId, reason);
    return;
  }
  if (position.requester_agent_id !== negotiation.requesterAgentId) {
    const reason = `position ${position.id} does not belong to requester ${negotiation.requesterAgentId}`;
    logger.warn(`[close_position] rejecting ${negotiationId}: ${reason}`);
    await client.rejectNegotiation(negotiationId, reason);
    return;
  }

  const result = await client.acceptNegotiation(negotiationId);
  logger.info(`[close_position] accepted ${negotiationId} -> order ${result.order.orderId}`);

  setPositionStatus(db, position.id, "closing");
  const order = createOrder(db, {
    crooNegotiationId: negotiationId,
    service: "close_position",
    exposure: position.exposure,
    amountUsdc: position.amount_deployed_usdc,
    requirements: parsed.data,
  });
  attachCrooOrderId(db, order.id, result.order.orderId);
  logger.info(`[close_position] order ${order.id} persisted at state ${order.state}`);
}

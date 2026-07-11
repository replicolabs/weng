import { DeliverableType, type AgentClient, type Logger } from "@croo-network/sdk";
import { loadOstiumConfig, type Config } from "../../config.js";
import type { Db } from "../../state/db.js";
import { getOrderByCrooOrderId, transition, type OrderRow } from "../../state/orderStateMachine.js";
import { createPosition, getPosition, setPositionStatus } from "../../state/positions.js";
import { swapUsdcToCetes, sellCetesToUsdc } from "../../bonds/aerodrome.js";
import { openOstiumPosition, SPX_USD_PAIR_ID } from "../../sp500/ostium.js";
import { payFromAaWallet } from "../../wallet/aaSelfSubmit.js";
import { fundMainnetOstiumWallet } from "../../sp500/mainnetFunding.js";
import { closeSp500Position } from "../../sp500/closeSp500Position.js";
import { BASE_MAINNET_USDC } from "../../constants.js";
import { OpenPositionRequirements, ClosePositionRequirements } from "../schemas.js";

/**
 * Routes a paid order to its exposure-specific execution path. Dispatches
 * only — the actual swap/open/close logic lives in the handle* functions
 * below.
 */
export async function handleOrderPaid(
  db: Db,
  client: AgentClient,
  config: Config,
  logger: Logger,
  crooOrderId: string,
  ownerPrivateKey: `0x${string}`
): Promise<void> {
  const order = getOrderByCrooOrderId(db, crooOrderId);
  if (!order) {
    logger.warn(`[order_paid] no local order for croo order ${crooOrderId}, ignoring`);
    return;
  }
  if (order.state !== "received") {
    logger.info(`[order_paid] ${order.id}: already past 'received' (state=${order.state}), ignoring duplicate event`);
    return;
  }

  if (order.service === "close_position") {
    await handleClosePositionOrderPaid(db, client, config, logger, order, ownerPrivateKey);
    return;
  }

  if (order.exposure === "bonds") {
    await handleBondsOrderPaid(db, client, config, logger, order, ownerPrivateKey);
  } else {
    await handleSp500OrderPaid(db, client, config, logger, order, ownerPrivateKey);
  }
}

async function handleBondsOrderPaid(
  db: Db,
  client: AgentClient,
  config: Config,
  logger: Logger,
  order: OrderRow,
  ownerPrivateKey: `0x${string}`
): Promise<void> {
  const requirements = JSON.parse(order.requirements_json) as OpenPositionRequirements;
  const amountUsdc = Number(order.amount_usdc);

  transition(db, order.id, "swapping");
  logger.info(`[order_paid] ${order.id}: swapping ${amountUsdc} USDC -> CETES`);

  const swap = await swapUsdcToCetes({
    ownerPrivateKey,
    aaWallet: config.CROO_AGENT_AA_WALLET_ADDRESS as `0x${string}`,
    amountUsdc,
  });

  transition(db, order.id, "swapped", { txRef: { step: "swap", hash: swap.swapTxHash } });
  logger.info(`[order_paid] ${order.id}: swapped, got ~${swap.amountOutCetes} CETES (tx ${swap.swapTxHash})`);

  const crooOrder = await client.getOrder(order.croo_order_id!);
  const position = createPosition(db, {
    exposure: "bonds",
    openOrderId: order.id,
    requesterAgentId: crooOrder.requesterAgentId,
    requesterWalletAddress: crooOrder.requesterWalletAddress,
    amountDeployedUsdc: String(amountUsdc),
    bondToken: "CETES",
    bondUnits: String(swap.amountOutCetes),
  });

  const deliverable = {
    exposure: "bonds",
    position_id: position.id,
    amount_deployed_usdc: amountUsdc,
    proof_tx_hashes: {
      transfer: swap.transferTxHash,
      approve: swap.approveTxHash,
      swap: swap.swapTxHash,
    },
    bond_token: requirements.bond_selection ?? "CETES",
    bond_units: swap.amountOutCetes,
  };

  const result = await client.deliverOrder(order.croo_order_id!, {
    deliverableType: DeliverableType.Schema,
    deliverableSchema: JSON.stringify(deliverable),
  });

  transition(db, order.id, "delivered", { txRef: { step: "deliver", hash: result.txHash } });
  logger.info(`[order_paid] ${order.id}: delivered (tx ${result.txHash})`);
}

/**
 * sp500 path, Ostium only (Hyperliquid deferred — its testnet faucet gates on
 * a real mainnet deposit, see .env comments). venue_preference "hyperliquid"
 * is rejected rather than silently rerouted to Ostium.
 *
 * TRADING_MODE=testnet: the pipeline's bridging/bridged states are no-ops —
 * the position is opened directly from the dedicated Ostium testnet
 * account's own faucet-funded balance, not the real CROO principal.
 *
 * TRADING_MODE=mainnet: bridging is real. Principal moves AA wallet -> Owner
 * EOA -> (LI.FI) -> the dedicated mainnet Ostium wallet on Arbitrum, per
 * src/sp500/mainnetFunding.ts, before the position is opened for real.
 */
async function handleSp500OrderPaid(
  db: Db,
  client: AgentClient,
  config: Config,
  logger: Logger,
  order: OrderRow,
  ownerPrivateKey: `0x${string}`
): Promise<void> {
  const requirements = JSON.parse(order.requirements_json) as OpenPositionRequirements;
  if (requirements.venue_preference === "hyperliquid") {
    const reason = "Hyperliquid venue not yet available (testnet funding blocked — see .env), and no auto-fallback to a different venue than requested";
    logger.warn(`[order_paid] ${order.id}: rejecting, ${reason}`);
    transition(db, order.id, "failed", { error: reason });
    return;
  }
  const ostiumConfig = loadOstiumConfig(config); // fails closed here, not at boot — see config.ts

  const amountUsdc = Number(order.amount_usdc);
  const mode = config.TRADING_MODE;
  let openCollateralUsdc = amountUsdc;
  const proofTxHashes: Record<string, string> = {};

  transition(db, order.id, "bridging");
  if (mode === "mainnet") {
    const { OSTIUM_MAINNET_PRIVATE_KEY, OSTIUM_MAINNET_RPC_URL } = ostiumConfig as {
      OSTIUM_MAINNET_PRIVATE_KEY: `0x${string}`;
      OSTIUM_MAINNET_RPC_URL: string;
    };
    const { privateKeyToAccount } = await import("viem/accounts");
    const ostiumWallet = privateKeyToAccount(OSTIUM_MAINNET_PRIVATE_KEY).address;

    logger.info(`[order_paid] ${order.id}: bridging ${amountUsdc} USDC Base -> Arbitrum (${ostiumWallet}) via LI.FI`);
    const funding = await fundMainnetOstiumWallet({
      ownerPrivateKey,
      aaWallet: config.CROO_AGENT_AA_WALLET_ADDRESS as `0x${string}`,
      ostiumWallet,
      amountUsdc,
      arbitrumRpcUrl: OSTIUM_MAINNET_RPC_URL,
    });
    proofTxHashes.transferOut = funding.transferOutTxHash;
    if (funding.gasTopUpBridgeTxHash) proofTxHashes.gasTopUpBridge = funding.gasTopUpBridgeTxHash;
    proofTxHashes.principalBridge = funding.principalBridgeTxHash;
    openCollateralUsdc = funding.amountLandedUsdc;
    logger.info(`[order_paid] ${order.id}: bridged, ${openCollateralUsdc} USDC landed on Arbitrum`);
  } else {
    logger.warn(`[order_paid] ${order.id}: TESTNET MODE — skipping real Base->Arbitrum bridge, opening from pre-funded Ostium testnet account instead`);
  }
  transition(db, order.id, "bridged");

  transition(db, order.id, "opening");
  logger.info(`[order_paid] ${order.id}: opening near-1x SPX-USD position, ${openCollateralUsdc} USDC (${mode})`);

  const open = await openOstiumPosition(mode, openCollateralUsdc, SPX_USD_PAIR_ID, 1);
  proofTxHashes.open = open.txHash;

  transition(db, order.id, "open", { txRef: { step: "open", hash: open.txHash } });
  logger.info(`[order_paid] ${order.id}: opened, entry ${open.entryPrice}, tradeIndex ${open.tradeIndex} (tx ${open.txHash})`);

  const crooOrder = await client.getOrder(order.croo_order_id!);
  const position = createPosition(db, {
    exposure: "sp500",
    openOrderId: order.id,
    requesterAgentId: crooOrder.requesterAgentId,
    requesterWalletAddress: crooOrder.requesterWalletAddress,
    amountDeployedUsdc: String(amountUsdc),
    venue: "ostium",
    venueReason: "Ostium selected: Hyperliquid testnet funding is currently blocked (mainnet-deposit gate), Ostium's testnet faucet has no such gate.",
    entryPrice: String(open.entryPrice),
    positionSize: String(open.tradeIndex ?? ""),
    liquidationAction: requirements.liquidation_action,
  });

  const deliverable = {
    exposure: "sp500",
    position_id: position.id,
    amount_deployed_usdc: amountUsdc,
    proof_tx_hashes: proofTxHashes,
    venue: "ostium",
    venue_reason: "Ostium selected: Hyperliquid testnet funding is currently blocked (mainnet-deposit gate), Ostium's testnet faucet has no such gate.",
    entry_price: open.entryPrice,
    position_size: open.tradeIndex,
  };

  const result = await client.deliverOrder(order.croo_order_id!, {
    deliverableType: DeliverableType.Schema,
    deliverableSchema: JSON.stringify(deliverable),
  });

  transition(db, order.id, "delivered", { txRef: { step: "deliver", hash: result.txHash } });
  logger.info(`[order_paid] ${order.id}: delivered (tx ${result.txHash})`);
}

function humanDuration(fromIso: string): string {
  const ms = Date.now() - new Date(fromIso).getTime();
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

/**
 * Closes an existing position and pays the requester back. Unlike open,
 * there's no fund-transfer step here — Weng already holds the position;
 * the only prerequisite is the service fee being paid (this handler is
 * itself triggered by that payment).
 *
 * sp500 close in TRADING_MODE=testnet matches the open-side simplification:
 * the real principal for an sp500 order lands in Weng's Base wallet on open
 * but is never touched (the position is opened on Ostium's separate testnet
 * account instead — see handleSp500OrderPaid). So on close, that same real
 * principal — which has been sitting untouched in Weng's Base wallet the
 * whole time — is exactly what gets returned; the Ostium testnet position is
 * still really closed first, to prove that half of the mechanism too.
 *
 * sp500 close in TRADING_MODE=mainnet bridges real proceeds back from
 * Arbitrum via bridgeProceedsAndPayRequester, which also performs the
 * requester payout itself (bridging and paying out are one combined step
 * there, unlike bonds/testnet-sp500) — payoutHandled short-circuits the
 * shared payout call below for that case.
 */
async function handleClosePositionOrderPaid(
  db: Db,
  client: AgentClient,
  config: Config,
  logger: Logger,
  order: OrderRow,
  ownerPrivateKey: `0x${string}`
): Promise<void> {
  const requirements = JSON.parse(order.requirements_json) as ClosePositionRequirements;
  const position = getPosition(db, requirements.position_id);
  if (!position) {
    logger.error(`[order_paid] ${order.id}: position ${requirements.position_id} not found, cannot close`);
    transition(db, order.id, "failed", { error: `position ${requirements.position_id} not found` });
    return;
  }

  const crooOrder = await client.getOrder(order.croo_order_id!);
  const requesterWallet = crooOrder.requesterWalletAddress as `0x${string}`;
  const aaWallet = config.CROO_AGENT_AA_WALLET_ADDRESS as `0x${string}`;
  const deployedUsdc = Number(position.amount_deployed_usdc);

  let amountReturnedUsdc: number;
  const proofTxHashes: Record<string, string> = {};
  const extra: Record<string, unknown> = {};

  if (position.exposure === "bonds") {
    transition(db, order.id, "selling");
    logger.info(`[order_paid] ${order.id}: selling ${position.bond_units} CETES -> USDC`);

    const sell = await sellCetesToUsdc({
      ownerPrivateKey,
      aaWallet,
      amountCetes: Number(position.bond_units),
    });
    amountReturnedUsdc = sell.amountOutUsdc;
    proofTxHashes.transfer = sell.transferTxHash;
    proofTxHashes.approve = sell.approveTxHash;
    proofTxHashes.swap = sell.swapTxHash;
    extra.yield_earned_usdc = amountReturnedUsdc - deployedUsdc;

    transition(db, order.id, "sold", { txRef: { step: "sell", hash: sell.swapTxHash } });

    const payout = await payFromAaWallet({
      ownerPrivateKey,
      aaWallet,
      token: BASE_MAINNET_USDC,
      to: requesterWallet,
      amount: BigInt(Math.round(amountReturnedUsdc * 1e6)),
    });
    if (!payout.success) {
      throw new Error(`handleClosePositionOrderPaid: payout to requester failed (tx ${payout.txHash})`);
    }
    proofTxHashes.payout = payout.txHash;
  } else {
    transition(db, order.id, "closing_position");
    logger.info(`[order_paid] ${order.id}: closing Ostium position, tradeIndex ${position.position_size} (${config.TRADING_MODE})`);

    const closed = await closeSp500Position({ config, ownerPrivateKey, aaWallet, requesterWallet, position });
    amountReturnedUsdc = closed.amountReturnedUsdc;
    Object.assign(proofTxHashes, closed.proofTxHashes);
    extra.entry_price = closed.entryPrice;
    extra.exit_price = closed.exitPrice;

    transition(db, order.id, "closed_position", { txRef: { step: "close", hash: closed.proofTxHashes.close! } });
    transition(db, order.id, "bridging_back");
    transition(db, order.id, "bridged_back");
  }

  setPositionStatus(db, position.id, "closed");

  const deliverable = {
    exposure: position.exposure,
    amount_returned_usdc: amountReturnedUsdc,
    realized_pnl_usdc: amountReturnedUsdc - deployedUsdc,
    duration_held: humanDuration(position.created_at),
    proof_tx_hashes: proofTxHashes,
    ...extra,
  };

  const result = await client.deliverOrder(order.croo_order_id!, {
    deliverableType: DeliverableType.Schema,
    deliverableSchema: JSON.stringify(deliverable),
  });

  transition(db, order.id, "delivered", { txRef: { step: "deliver", hash: result.txHash } });
  logger.info(`[order_paid] ${order.id}: delivered (tx ${result.txHash})`);
}
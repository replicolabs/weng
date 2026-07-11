import type { Logger } from "@croo-network/sdk";
import type { Db } from "../state/db.js";
import type { Config } from "../config.js";
import { getOpenPositions, setGuardStatus, setPositionStatus, type PositionRow } from "../state/positions.js";
import { getOstiumTradeMetrics, SPX_USD_PAIR_ID } from "../sp500/ostium.js";
import { closeSp500Position } from "../sp500/closeSp500Position.js";

/**
 * Section 2.4's liquidation guard. sp500-only — bonds (CETES) is a plain
 * spot holding with no leverage or liquidation mechanism.
 *
 * Two-tier response per position, driven by GUARD_WARN_LIQUIDATION_DISTANCE_PCT
 * and GUARD_ACT_LIQUIDATION_DISTANCE_PCT:
 *   - WARN: logged and recorded (guard_status), no funds move. Weng has no
 *     channel to push a notification to the requester — this is an internal
 *     record, visible if they later query the position.
 *   - ACT: behavior is the requester's own choice, set at open time
 *     (liquidation_action on Open Position — defaults to auto_close):
 *       - auto_close: emergency-closes the position and pays the requester
 *         back immediately, via the exact same closeSp500Position() used by
 *         a normal requester-initiated close — no separate code path to
 *         drift out of sync. No CROO order exists for this (nothing
 *         triggered it), so there's no deliverOrder call; the audit trail is
 *         the on-chain tx hashes recorded in guard_action_tx_hashes_json.
 *       - warn_only: never moves funds automatically, only marks 'at_risk'.
 *
 * Note from real testing: a near-1x position (Weng's design) can report
 * liquidation_price = 0 from Ostium — effectively no meaningful liquidation
 * risk at this leverage. Positions with no computable liquidation price are
 * treated as 'ok' rather than divided-by-zero into a false alarm.
 */
export function startLiquidationGuard(
  db: Db,
  config: Config,
  logger: Logger,
  ownerPrivateKey: `0x${string}`
): () => void {
  const intervalMs = config.guard.pollIntervalSeconds * 1000;
  logger.info(`[guard] starting, poll interval ${config.guard.pollIntervalSeconds}s`);

  const timer = setInterval(() => {
    checkAllPositions(db, config, logger, ownerPrivateKey).catch((err) => {
      logger.error("[guard] poll cycle failed:", err);
    });
  }, intervalMs);

  return () => clearInterval(timer);
}

async function checkAllPositions(db: Db, config: Config, logger: Logger, ownerPrivateKey: `0x${string}`): Promise<void> {
  const positions = getOpenPositions(db, "sp500");
  for (const position of positions) {
    try {
      await checkOnePosition(db, config, logger, ownerPrivateKey, position);
    } catch (err) {
      logger.error(`[guard] error checking position ${position.id}:`, err);
    }
  }
}

async function checkOnePosition(
  db: Db,
  config: Config,
  logger: Logger,
  ownerPrivateKey: `0x${string}`,
  position: PositionRow
): Promise<void> {
  const tradeIndex = Number(position.position_size);
  if (!Number.isFinite(tradeIndex)) return;

  const metrics = await getOstiumTradeMetrics(config.TRADING_MODE, SPX_USD_PAIR_ID, tradeIndex);
  const liquidationPrice = Number(metrics.liquidation_price ?? 0);
  const currentPrice = Number(metrics.mid ?? 0);

  if (!liquidationPrice || liquidationPrice <= 0 || !currentPrice) {
    setGuardStatus(db, position.id, "ok");
    return;
  }

  const distancePct = ((currentPrice - liquidationPrice) / currentPrice) * 100;

  if (distancePct <= config.guard.actLiquidationDistancePct) {
    if (position.liquidation_action !== "auto_close") {
      logger.warn(`[guard] position ${position.id} at ${distancePct.toFixed(2)}% from liquidation — AT RISK, liquidation_action=warn_only, not acting`);
      setGuardStatus(db, position.id, "at_risk");
      return;
    }
    if (!position.requester_wallet_address) {
      logger.error(`[guard] position ${position.id} needs emergency close but has no stored requester wallet address, cannot act`);
      setGuardStatus(db, position.id, "at_risk");
      return;
    }

    logger.warn(`[guard] position ${position.id} at ${distancePct.toFixed(2)}% from liquidation — AUTO-CLOSING`);
    const closed = await closeSp500Position({
      config,
      ownerPrivateKey,
      aaWallet: config.CROO_AGENT_AA_WALLET_ADDRESS as `0x${string}`,
      requesterWallet: position.requester_wallet_address as `0x${string}`,
      position,
    });
    setPositionStatus(db, position.id, "closed");
    setGuardStatus(db, position.id, "acted", { actionTxHashes: closed.proofTxHashes });
    logger.warn(`[guard] position ${position.id} emergency-closed, returned ${closed.amountReturnedUsdc} USDC to requester`);
  } else if (distancePct <= config.guard.warnLiquidationDistancePct) {
    logger.warn(`[guard] position ${position.id} at ${distancePct.toFixed(2)}% from liquidation`);
    setGuardStatus(db, position.id, "warn");
  } else {
    setGuardStatus(db, position.id, "ok");
  }
}

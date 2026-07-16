import { config as loadDotenv } from "dotenv";
import { EventType } from "@croo-network/sdk";

// .env lives at the repo root (shared with a future frontend workspace),
// not inside orchestrator/, so dotenv's default cwd-relative lookup misses it.
loadDotenv({ path: new URL("../../.env", import.meta.url).pathname });
import { loadConfig } from "./config.js";
import { buildCrooClient } from "./croo/client.js";
import { openDb } from "./state/db.js";
import { reconcileOnBoot } from "./state/recovery.js";
import { handleOpenPositionNegotiation } from "./croo/handlers/openPosition.js";
import { handleClosePositionNegotiation } from "./croo/handlers/closePosition.js";
import { handleOrderPaid } from "./croo/handlers/orderPaid.js";
import { startLiquidationGuard } from "./guard/liquidationGuard.js";

const logger = console;

async function main() {
  const config = loadConfig();
  logger.info(`[weng] TRADING_MODE=${config.TRADING_MODE} fund_address=${config.CROO_AGENT_AA_WALLET_ADDRESS}`);

  // On Railway the local filesystem is wiped on every redeploy unless this
  // points at a mounted Volume path (e.g. /data/weng.db via DB_PATH).
  const dbPath = process.env.DB_PATH ?? new URL("../data/weng.db", import.meta.url).pathname;
  const db = openDb(dbPath);
  reconcileOnBoot(db, logger);

  const client = buildCrooClient(config, logger);
  const stream = await client.connectWebSocket();

  stream.on(EventType.NegotiationCreated, async (e) => {
    if (!e.negotiation_id || !e.service_id) return;
    try {
      if (e.service_id === config.CROO_OPEN_POSITION_SERVICE_ID) {
        await handleOpenPositionNegotiation(
          db,
          client,
          config,
          logger,
          e.negotiation_id,
          config.CROO_AGENT_AA_WALLET_ADDRESS
        );
      } else if (e.service_id === config.CROO_CLOSE_POSITION_SERVICE_ID) {
        await handleClosePositionNegotiation(db, client, logger, e.negotiation_id);
      }
    } catch (err) {
      logger.error(`[weng] error handling negotiation ${e.negotiation_id}:`, err);
    }
  });

  stream.on(EventType.OrderPaid, async (e) => {
    if (!e.order_id) return;
    try {
      await handleOrderPaid(db, client, config, logger, e.order_id, config.CROO_AGENT_OWNER_PRIVATE_KEY as `0x${string}`);
    } catch (err) {
      logger.error(`[weng] error handling order_paid ${e.order_id}:`, err);
    }
  });

  const stopGuard = startLiquidationGuard(db, config, logger, config.CROO_AGENT_OWNER_PRIVATE_KEY as `0x${string}`);

  process.on("SIGINT", () => {
    stopGuard();
    stream.close();
    db.close();
    process.exit(0);
  });

  logger.info("[weng] listening for CROO negotiations");
}

main().catch((err) => {
  logger.error("[weng] fatal:", err);
  process.exit(1);
});

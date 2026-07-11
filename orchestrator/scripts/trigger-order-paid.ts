import { config as loadDotenv } from "dotenv";
loadDotenv({ path: new URL("../../.env", import.meta.url).pathname });

import { loadConfig } from "../src/config.js";
import { buildCrooClient } from "../src/croo/client.js";
import { openDb } from "../src/state/db.js";
import { handleOrderPaid } from "../src/croo/handlers/orderPaid.js";

const CROO_ORDER_ID = process.argv[2];
if (!CROO_ORDER_ID) {
  console.error("usage: tsx scripts/trigger-order-paid.ts <crooOrderId>");
  process.exit(1);
}

async function main() {
  const config = loadConfig();
  const db = openDb(new URL("../data/weng.db", import.meta.url).pathname);
  const client = buildCrooClient(config, console);
  await handleOrderPaid(db, client, config, console, CROO_ORDER_ID!, config.CROO_AGENT_OWNER_PRIVATE_KEY as `0x${string}`);
  db.close();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

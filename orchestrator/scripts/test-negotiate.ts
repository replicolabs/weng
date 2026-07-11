import { config as loadDotenv } from "dotenv";
loadDotenv({ path: new URL("../../.env", import.meta.url).pathname });

import { AgentClient } from "@croo-network/sdk";
import { BASE_MAINNET_USDC, USDC_DECIMALS } from "../src/constants.js";

/**
 * Free/no-cost test of the Open Position negotiation flow, using a second
 * throwaway agent as requester. Negotiates and waits for Weng's orchestrator
 * (must be running separately: `npm run dev:orchestrator`) to accept — then
 * inspects the resulting order's fund-transfer fields and prints the
 * on-chain reference needed to decode the real OrderCreated event.
 *
 * Deliberately stops before payOrder — this script never moves real funds.
 */

const REQUESTER_SDK_KEY = process.env.CROO_REQUESTER_SDK_KEY;
const API_URL = process.env.CROO_API_URL;
const WS_URL = process.env.CROO_WS_URL;
const OPEN_POSITION_SERVICE_ID = process.env.CROO_OPEN_POSITION_SERVICE_ID;

if (!REQUESTER_SDK_KEY || !API_URL || !WS_URL || !OPEN_POSITION_SERVICE_ID) {
  console.error(
    "Missing one of CROO_REQUESTER_SDK_KEY / CROO_API_URL / CROO_WS_URL / CROO_OPEN_POSITION_SERVICE_ID in .env"
  );
  process.exit(1);
}

async function main() {
  const client = new AgentClient({ baseURL: API_URL!, wsURL: WS_URL! }, REQUESTER_SDK_KEY!);

  // Deliberately small ($0.50, not $5): this test never calls payOrder, so
  // the order amount costs nothing either way — no principal moves at
  // Negotiate/Accept. Kept small anyway so that if accept fails, the error
  // itself tells us whether CROO enforces its own order-size floor
  // (a different error than PIMLICO_ERROR) or not (same error regardless of
  // amount) — isolates amount as a variable from the gas-sponsorship issue.
  // Requires MIN_ORDER_USDC_BONDS temporarily lowered to 0.5 in .env, since
  // Weng's own validation would otherwise reject this before CROO does.
  const amountUsdc = 0.5;
  const requirements = JSON.stringify({
    amount_usdc: amountUsdc,
    target_exposure: "bonds",
    bond_selection: "CETES",
  });
  // Required for fund-transfer services — confirmed by the API itself
  // rejecting negotiateOrder without these ("fund_amount and fund_token are
  // required for fund services"). Base units: USDC has 6 decimals.
  const fundAmount = String(Math.round(amountUsdc * 10 ** USDC_DECIMALS));
  const fundToken = BASE_MAINNET_USDC;

  console.log("[test] negotiating with requirements:", requirements);
  console.log("[test] fundAmount:", fundAmount, "fundToken:", fundToken);
  const negotiation = await client.negotiateOrder({
    serviceId: OPEN_POSITION_SERVICE_ID!,
    requirements,
    fundAmount,
    fundToken,
  });
  console.log(`[test] negotiation ${negotiation.negotiationId} created, status: ${negotiation.status}`);
  console.log("[test] make sure `npm run dev:orchestrator` is running in another terminal to accept this.");

  let finalNegotiation = negotiation;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    finalNegotiation = await client.getNegotiation(negotiation.negotiationId);
    console.log(`[test] poll ${i + 1}/20: status = ${finalNegotiation.status}`);
    if (finalNegotiation.status === "rejected") {
      console.error("[test] negotiation was rejected. Reason:", finalNegotiation.rejectReason);
      process.exit(1);
    }
    if (finalNegotiation.status === "accepted") break;
  }

  console.log("[test] final negotiation state:", JSON.stringify(finalNegotiation, null, 2));

  if (finalNegotiation.status !== "accepted") {
    console.error("[test] timed out waiting for acceptance — is the orchestrator running and connected?");
    process.exit(1);
  }

  if (finalNegotiation.fundAmount || finalNegotiation.fundToken || finalNegotiation.providerFundAddress) {
    console.log("[test] fund-transfer fields present on the negotiation:");
    console.log("  fundAmount:", finalNegotiation.fundAmount);
    console.log("  fundToken:", finalNegotiation.fundToken);
    console.log("  providerFundAddress:", finalNegotiation.providerFundAddress);
  } else {
    console.log("[test] no fund-transfer fields present on the negotiation object.");
  }

  // The SDK's own naming suggests "requester", but the live API actually
  // validates role as 'buyer' or 'provider' (confirmed by a real 400:
  // "role must be 'buyer' or 'provider'") — a genuine SDK/backend mismatch.
  const orders = await client.listOrders({ role: "buyer" });
  const order = orders.find((o) => o.negotiationId === negotiation.negotiationId);

  if (!order) {
    console.log("[test] no matching order found yet via listOrders — try `getOrder` manually once you have the ID.");
    return;
  }

  console.log("[test] order found:", JSON.stringify(order, null, 2));
  console.log(
    `[test] look up createTxHash ${order.createTxHash} (chainOrderId ${order.chainOrderId}) on BaseScan and decode ` +
      "the OrderCreated event's isFundOrder/fundParams fields directly — that's the authoritative answer."
  );
  console.log("[test] STOPPING HERE — not calling payOrder. This was the free/no-cost part of the test.");
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(1);
});

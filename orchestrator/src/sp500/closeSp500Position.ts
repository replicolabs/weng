import type { Address, Hex } from "viem";
import type { Config } from "../config.js";
import { loadOstiumConfig } from "../config.js";
import type { PositionRow } from "../state/positions.js";
import { closeOstiumPosition, SPX_USD_PAIR_ID } from "./ostium.js";
import { bridgeProceedsAndPayRequester } from "./mainnetFunding.js";
import { payFromAaWallet } from "../wallet/aaSelfSubmit.js";
import { BASE_MAINNET_USDC } from "../constants.js";

export interface Sp500CloseResult {
  amountReturnedUsdc: number;
  proofTxHashes: Record<string, string>;
  entryPrice: number;
  exitPrice: number;
}

/**
 * Closes an sp500 position and pays the requester — shared by both the
 * normal, requester-initiated Close Position flow (handleClosePositionOrderPaid)
 * and the liquidation guard's emergency auto-close, so the two paths can
 * never drift apart. Same TESTNET SIMPLIFICATION as the rest of the sp500
 * mainnet work: in TRADING_MODE=testnet, returns the real principal that was
 * never bridged out on open, since the testnet Ostium position is funded
 * separately — see handleSp500OrderPaid.
 */
export async function closeSp500Position(args: {
  config: Config;
  ownerPrivateKey: Hex;
  aaWallet: Address;
  requesterWallet: Address;
  position: PositionRow;
}): Promise<Sp500CloseResult> {
  const { config, position } = args;
  const mode = config.TRADING_MODE;
  const deployedUsdc = Number(position.amount_deployed_usdc);
  const proofTxHashes: Record<string, string> = {};

  const close = await closeOstiumPosition(mode, SPX_USD_PAIR_ID, Number(position.position_size));
  proofTxHashes.close = close.txHash;

  let amountReturnedUsdc: number;
  if (mode === "mainnet") {
    const ostiumConfig = loadOstiumConfig(config) as {
      OSTIUM_MAINNET_PRIVATE_KEY: `0x${string}`;
      OSTIUM_MAINNET_RPC_URL: string;
    };
    const { privateKeyToAccount } = await import("viem/accounts");
    const ostiumWallet = privateKeyToAccount(ostiumConfig.OSTIUM_MAINNET_PRIVATE_KEY).address;

    const bridged = await bridgeProceedsAndPayRequester({
      ownerPrivateKey: args.ownerPrivateKey,
      ostiumMainnetPrivateKey: ostiumConfig.OSTIUM_MAINNET_PRIVATE_KEY,
      aaWallet: args.aaWallet,
      ostiumWallet,
      requesterWallet: args.requesterWallet,
      amountUsdc: deployedUsdc,
      arbitrumRpcUrl: ostiumConfig.OSTIUM_MAINNET_RPC_URL,
    });
    proofTxHashes.bridgeBack = bridged.bridgeBackTxHash;
    proofTxHashes.payout = bridged.payoutTxHash;
    amountReturnedUsdc = bridged.amountReturnedUsdc;
  } else {
    amountReturnedUsdc = deployedUsdc;
    const payout = await payFromAaWallet({
      ownerPrivateKey: args.ownerPrivateKey,
      aaWallet: args.aaWallet,
      token: BASE_MAINNET_USDC,
      to: args.requesterWallet,
      amount: BigInt(Math.round(amountReturnedUsdc * 1e6)),
    });
    if (!payout.success) {
      throw new Error(`closeSp500Position: payout to requester failed (tx ${payout.txHash})`);
    }
    proofTxHashes.payout = payout.txHash;
  }

  return {
    amountReturnedUsdc,
    proofTxHashes,
    entryPrice: Number(position.entry_price),
    exitPrice: close.exitPrice,
  };
}

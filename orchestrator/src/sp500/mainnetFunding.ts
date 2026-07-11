import { createPublicClient, http, parseUnits, encodeFunctionData, type Address, type Hex } from "viem";
import { arbitrum } from "viem/chains";
import { bridgeErc20 } from "../bridge/lifi.js";
import { submitSelfFundedCall, payFromAaWallet } from "../wallet/aaSelfSubmit.js";
import { BASE_MAINNET_USDC, ARBITRUM_MAINNET_USDC, NATIVE_TOKEN_PLACEHOLDER, USDC_DECIMALS } from "../constants.js";

// Reserved once, the first time a mainnet sp500 order ever runs — the Ostium
// mainnet wallet starts with zero ETH, and Arbitrum gas is cheap enough that
// this covers many trades' worth of open/close calls afterward. Deducted
// from that first order's own principal rather than requiring a separate
// manual top-up, since there's no other source of real funds to draw from.
const GAS_TOPUP_USDC = 0.5;
const MIN_GAS_RESERVE_WEI = parseUnits("0.0003", 18);

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface OpenFundingResult {
  transferOutTxHash: Hex;
  gasTopUpBridgeTxHash: Hex | null;
  principalBridgeTxHash: Hex;
  amountLandedUsdc: number;
}

/**
 * Moves real order principal from Weng's Base AA wallet to the mainnet
 * Ostium trading wallet on Arbitrum, via LI.FI. Three legs, in order:
 *
 *   1. AA wallet --(Owner-signed, self-funded UserOp)--> transfer full
 *      principal to the Owner EOA (the only AA-wallet-level action
 *      available — same constraint as the Aerodrome swap).
 *   2. Owner EOA --(LI.FI, conditional)--> bridge a small USDC->ETH slice to
 *      the Ostium wallet, only if it doesn't already have enough gas. Skips
 *      itself on every trade after the first.
 *   3. Owner EOA --(LI.FI)--> bridge the remaining principal, USDC->USDC,
 *      landing directly at the Ostium wallet.
 */
export async function fundMainnetOstiumWallet(args: {
  ownerPrivateKey: Hex;
  aaWallet: Address;
  ostiumWallet: Address;
  amountUsdc: number;
  baseRpcUrl?: string;
  arbitrumRpcUrl?: string;
}): Promise<OpenFundingResult> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(args.ownerPrivateKey);
  const amountIn = parseUnits(args.amountUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  // 1. Move the full principal out of the AA wallet to the Owner EOA.
  const transferCalldata = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [account.address, amountIn],
  });
  const transferResult = await submitSelfFundedCall({
    ownerPrivateKey: args.ownerPrivateKey,
    aaWallet: args.aaWallet,
    target: BASE_MAINNET_USDC,
    calldata: transferCalldata,
    rpcUrl: args.baseRpcUrl,
  });
  if (!transferResult.success) {
    throw new Error(`fundMainnetOstiumWallet: transfer out of AA wallet failed (tx ${transferResult.txHash})`);
  }

  // 2. Top up gas on the Ostium wallet, only if it's actually low.
  const arbPublicClient = createPublicClient({ chain: arbitrum, transport: http(args.arbitrumRpcUrl) });
  const currentGas = await arbPublicClient.getBalance({ address: args.ostiumWallet });
  let gasTopUpBridgeTxHash: Hex | null = null;
  let remainingForPrincipal = args.amountUsdc;

  if (currentGas < MIN_GAS_RESERVE_WEI) {
    const gasBridge = await bridgeErc20({
      ownerPrivateKey: args.ownerPrivateKey,
      fromChain: 8453,
      toChain: 42161,
      fromToken: BASE_MAINNET_USDC,
      toToken: NATIVE_TOKEN_PLACEHOLDER,
      fromAmount: parseUnits(GAS_TOPUP_USDC.toFixed(USDC_DECIMALS), USDC_DECIMALS),
      toAddress: args.ostiumWallet,
      rpcUrl: args.baseRpcUrl,
    });
    gasTopUpBridgeTxHash = gasBridge.bridgeTxHash;
    remainingForPrincipal -= GAS_TOPUP_USDC;
  }

  // 3. Bridge the remaining principal as USDC.
  const principalBridge = await bridgeErc20({
    ownerPrivateKey: args.ownerPrivateKey,
    fromChain: 8453,
    toChain: 42161,
    fromToken: BASE_MAINNET_USDC,
    toToken: ARBITRUM_MAINNET_USDC,
    fromAmount: parseUnits(remainingForPrincipal.toFixed(USDC_DECIMALS), USDC_DECIMALS),
    toAddress: args.ostiumWallet,
    rpcUrl: args.baseRpcUrl,
  });

  const landedRaw = principalBridge.receivedAmount ?? principalBridge.quoteToAmountMin;
  const amountLandedUsdc = Number(landedRaw) / 10 ** USDC_DECIMALS;

  return {
    transferOutTxHash: transferResult.txHash,
    gasTopUpBridgeTxHash,
    principalBridgeTxHash: principalBridge.bridgeTxHash,
    amountLandedUsdc,
  };
}

export interface CloseFundingResult {
  bridgeBackTxHash: Hex;
  payoutTxHash: Hex;
  amountReturnedUsdc: number;
}

/**
 * Bridges Ostium close proceeds back from Arbitrum to Weng's Base AA wallet,
 * then pays the requester — the reverse of fundMainnetOstiumWallet. Submitted
 * directly from the Ostium mainnet wallet itself (not routed through the
 * Owner EOA), since that wallet already holds both the USDC and — thanks to
 * the gas top-up on open — the ETH needed to submit this transaction.
 */
export async function bridgeProceedsAndPayRequester(args: {
  ownerPrivateKey: Hex; // CROO Owner key — needed for the final AA-wallet payout
  ostiumMainnetPrivateKey: Hex;
  aaWallet: Address;
  ostiumWallet: Address;
  requesterWallet: Address;
  amountUsdc: number;
  baseRpcUrl?: string;
  arbitrumRpcUrl?: string;
}): Promise<CloseFundingResult> {
  const amountIn = parseUnits(args.amountUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  const bridgeBack = await bridgeErc20({
    ownerPrivateKey: args.ostiumMainnetPrivateKey,
    fromChain: 42161,
    toChain: 8453,
    fromToken: ARBITRUM_MAINNET_USDC,
    toToken: BASE_MAINNET_USDC,
    fromAmount: amountIn,
    toAddress: args.aaWallet,
    rpcUrl: args.arbitrumRpcUrl,
  });

  const landedRaw = bridgeBack.receivedAmount ?? bridgeBack.quoteToAmountMin;
  const amountReturnedUsdc = Number(landedRaw) / 10 ** USDC_DECIMALS;

  const payout = await payFromAaWallet({
    ownerPrivateKey: args.ownerPrivateKey,
    aaWallet: args.aaWallet,
    token: BASE_MAINNET_USDC,
    to: args.requesterWallet,
    amount: BigInt(landedRaw),
    rpcUrl: args.baseRpcUrl,
  });
  if (!payout.success) {
    throw new Error(`bridgeProceedsAndPayRequester: payout to requester failed (tx ${payout.txHash})`);
  }

  return {
    bridgeBackTxHash: bridgeBack.bridgeTxHash,
    payoutTxHash: payout.txHash,
    amountReturnedUsdc,
  };
}

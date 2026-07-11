import { createPublicClient, createWalletClient, http, encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_MAINNET_USDC, USDC_DECIMALS } from "../constants.js";
import { submitSelfFundedCall } from "../wallet/aaSelfSubmit.js";

// Verified 2026-07-05 against aerodrome-finance/slipstream (GitHub) and cross-checked
// on BaseScan. The CETES/USDC pool is an Aerodrome Slipstream (concentrated-liquidity,
// Uniswap-V3-style) pool, NOT a classic Router.sol AMM pool — confirmed via the pool's
// `dex` relationship on GeckoTerminal ("aerodrome-slipstream-2"). Using the classic
// Router/Route{stable,factory} interface against this pool would be wrong.
export const CETES_TOKEN = "0x834df4c1d8f51be24322e39e4766697be015512f" as const;
export const CETES_USDC_POOL = "0xbb0081ebd30d00c667efba251ec20af37bb03a31" as const;
// CORRECTED 2026-07-08: the address that was here (0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5)
// is aerodrome-finance/slipstream's "Initial Deployment" SwapRouter, wired to
// PoolFactory 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A — the SAME wrong factory
// that made the QuoterV2 below revert. Confirmed via router.factory(): this
// router derives pool addresses via CREATE2 from ITS OWN stored factory, gets
// the wrong address for a pool deployed by a different factory, and calls into
// empty bytecode — exactInputSingle reverts with no data at all (not a slippage
// failure; verified by simulating with amountOutMinimum=0, which still reverted).
// The pool's actual factory is 0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a (the
// "Gauge Caps Deployment" per aerodrome-finance/slipstream's README) — its
// paired SwapRouter, confirmed via router.factory() returning that exact
// address, is the one below.
export const SLIPSTREAM_SWAP_ROUTER = "0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D" as const;
// Read directly on-chain via tickSpacing() rather than assumed from the "0.05%" label.
export const CETES_USDC_TICK_SPACING = 10;
// Both USDC and CETES have 6 decimals (confirmed via decimals() on each contract),
// which is why the price formula below doesn't need a decimal-adjustment factor.

// NOTE: Aerodrome's public QuoterV2 (0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0,
// confirmed as "QuoterV2" on BaseScan) reverts with zero data for this pool. Root
// cause found by comparing on-chain state directly: the Quoter's stored `factory`
// (0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a) does not match this pool's actual
// `factory` (0xade65c38cd4849adba595a4323a8c7ddfe89716a) — the Quoter derives the
// pool address internally via CREATE2 from its own stored factory, computes the
// wrong address for a pool deployed by a different factory, and reverts on empty
// bytecode. Rather than hunt for a second, differently-wired Quoter deployment,
// this reads the pool's own slot0() directly — no factory-derivation involved,
// and it's a genuine `view` function (no revert-to-return-data fragility).
// Trade-off: this gives the current spot price, not a slippage-aware quote for a
// specific trade size. Fine for display/APY-adjacent purposes; a real swap still
// needs its own amountOutMinimum computed with an actual slippage tolerance.
const POOL_SLOT0_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

function getClient(rpcUrl?: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

/**
 * Current CETES-per-USDC spot price from the pool's own sqrtPriceX96, verified
 * against GeckoTerminal's independently-reported price (~14.9 CETES/USDC at
 * verification time) as a sanity check, not just derived from the formula alone.
 */
export async function getCetesPerUsdcSpotPrice(rpcUrl?: string): Promise<number> {
  const client = getClient(rpcUrl);
  const [sqrtPriceX96] = await client.readContract({
    address: CETES_USDC_POOL,
    abi: POOL_SLOT0_ABI,
    functionName: "slot0",
  });

  // USDC (0x8335...) < CETES (0x834d...) numerically, so USDC is token0, CETES is
  // token1. price = (sqrtPriceX96 / 2^96)^2 = token1/token0 = CETES per USDC, in
  // raw base units — decimals cancel out here since both tokens have 6 decimals.
  const price = sqrtPriceX96 ** 2n;
  const q192 = 2n ** 192n;
  // Scale by 1e12 before dividing to keep precision through integer math, then
  // convert to a float for display purposes only.
  const scaled = (price * 10n ** 12n) / q192;
  return Number(scaled) / 1e12;
}

/**
 * Rough (spot-price, non-slippage-adjusted) estimate of CETES received for a
 * given USDC input. A real swap must compute its own amountOutMinimum against
 * the actual trade size at execution time — this is for display/estimation only.
 */
export async function estimateUsdcToCetes(amountUsdc: number, rpcUrl?: string): Promise<number> {
  const cetesPerUsdc = await getCetesPerUsdcSpotPrice(rpcUrl);
  return amountUsdc * cetesPerUsdc;
}

const ERC20_ABI = [
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
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface SwapResult {
  transferTxHash: Hex;
  approveTxHash: Hex;
  swapTxHash: Hex;
  amountInUsdc: number;
  amountOutCetes: number;
}

/**
 * Converts USDC already sitting in Weng's AA wallet into CETES, landing back
 * in the same AA wallet. Three on-chain steps, not one, because
 * CROOValidationModule's selector whitelist (see constants.ts) never permits
 * the AA wallet itself to call a DEX router — only transfer/approve on
 * whitelisted tokens:
 *
 *   1. AA wallet --(Owner-signed, self-funded UserOp)--> transfer USDC to the
 *      Owner EOA. This is the only AA-wallet-level action available to us.
 *   2. Owner EOA --(plain tx)--> approve the Slipstream SwapRouter.
 *   3. Owner EOA --(plain tx)--> exactInputSingle, with `recipient` set back
 *      to the AA wallet — Uniswap-V3-style routers pull tokenIn from
 *      msg.sender (the EOA) and can push tokenOut to any address, so the
 *      CETES lands directly in Weng's custody without a fourth step.
 *
 * Slippage: 2% off the current spot price. Fine for the tiny sizes this
 * project trades (a real production system moving meaningful size would want
 * a proper slippage-aware quote, not spot price — see the Quoter note above).
 */
export async function swapUsdcToCetes(args: {
  ownerPrivateKey: Hex;
  aaWallet: Address;
  amountUsdc: number;
  rpcUrl?: string;
  slippageBps?: number;
}): Promise<SwapResult> {
  const slippageBps = args.slippageBps ?? 200; // 2%
  const account = privateKeyToAccount(args.ownerPrivateKey);
  const publicClient = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(args.rpcUrl) });

  const amountIn = parseUnits(args.amountUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  // 1. Move USDC out of the AA wallet — the only whitelisted way to touch it.
  const transferCalldata = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [account.address, amountIn],
  });
  const transferResult = await submitSelfFundedCall({
    ownerPrivateKey: args.ownerPrivateKey,
    aaWallet: args.aaWallet,
    target: BASE_MAINNET_USDC,
    calldata: transferCalldata,
    rpcUrl: args.rpcUrl,
  });
  if (!transferResult.success) {
    throw new Error(`swapUsdcToCetes: transfer out of AA wallet failed (tx ${transferResult.txHash})`);
  }

  // 2. Approve the router from the EOA that now holds the USDC.
  const approveTxHash = await walletClient.writeContract({
    address: BASE_MAINNET_USDC,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [SLIPSTREAM_SWAP_ROUTER, amountIn],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTxHash });

  // 3. Swap, with output routed directly back to the AA wallet.
  const spotPrice = await getCetesPerUsdcSpotPrice(args.rpcUrl);
  const expectedOut = args.amountUsdc * spotPrice;
  const minOut = expectedOut * (1 - slippageBps / 10000);
  const amountOutMinimum = parseUnits(minOut.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  const swapTxHash = await walletClient.writeContract({
    address: SLIPSTREAM_SWAP_ROUTER,
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: BASE_MAINNET_USDC,
        tokenOut: CETES_TOKEN,
        tickSpacing: CETES_USDC_TICK_SPACING,
        recipient: args.aaWallet,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapTxHash });
  if (swapReceipt.status !== "success") {
    throw new Error(`swapUsdcToCetes: swap failed (tx ${swapTxHash})`);
  }

  return {
    transferTxHash: transferResult.txHash,
    approveTxHash,
    swapTxHash,
    amountInUsdc: args.amountUsdc,
    amountOutCetes: expectedOut,
  };
}

/**
 * Current USDC-per-CETES spot price — the inverse of getCetesPerUsdcSpotPrice,
 * needed to estimate proceeds when selling CETES back to USDC on close.
 */
export async function getUsdcPerCetesSpotPrice(rpcUrl?: string): Promise<number> {
  const cetesPerUsdc = await getCetesPerUsdcSpotPrice(rpcUrl);
  return 1 / cetesPerUsdc;
}

export interface SellResult {
  transferTxHash: Hex;
  approveTxHash: Hex;
  swapTxHash: Hex;
  amountInCetes: number;
  amountOutUsdc: number;
}

/**
 * The reverse of swapUsdcToCetes: sells CETES sitting in Weng's AA wallet
 * back into USDC, landing back in the same AA wallet — same three-step
 * shape and the same reason (the AA wallet can never call the DEX router
 * directly, only transfer/approve on whitelisted tokens).
 */
export async function sellCetesToUsdc(args: {
  ownerPrivateKey: Hex;
  aaWallet: Address;
  amountCetes: number;
  rpcUrl?: string;
  slippageBps?: number;
}): Promise<SellResult> {
  const slippageBps = args.slippageBps ?? 200; // 2%
  const account = privateKeyToAccount(args.ownerPrivateKey);
  const publicClient = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(args.rpcUrl) });

  const amountIn = parseUnits(args.amountCetes.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  // 1. Move CETES out of the AA wallet.
  const transferCalldata = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [account.address, amountIn],
  });
  const transferResult = await submitSelfFundedCall({
    ownerPrivateKey: args.ownerPrivateKey,
    aaWallet: args.aaWallet,
    target: CETES_TOKEN,
    calldata: transferCalldata,
    rpcUrl: args.rpcUrl,
  });
  if (!transferResult.success) {
    throw new Error(`sellCetesToUsdc: transfer out of AA wallet failed (tx ${transferResult.txHash})`);
  }

  // 2. Approve the router from the EOA that now holds the CETES.
  const approveTxHash = await walletClient.writeContract({
    address: CETES_TOKEN,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [SLIPSTREAM_SWAP_ROUTER, amountIn],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTxHash });

  // 3. Swap CETES -> USDC, output routed directly back to the AA wallet.
  const spotPrice = await getUsdcPerCetesSpotPrice(args.rpcUrl);
  const expectedOut = args.amountCetes * spotPrice;
  const minOut = expectedOut * (1 - slippageBps / 10000);
  const amountOutMinimum = parseUnits(minOut.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  const swapTxHash = await walletClient.writeContract({
    address: SLIPSTREAM_SWAP_ROUTER,
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: CETES_TOKEN,
        tokenOut: BASE_MAINNET_USDC,
        tickSpacing: CETES_USDC_TICK_SPACING,
        recipient: args.aaWallet,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapTxHash });
  if (swapReceipt.status !== "success") {
    throw new Error(`sellCetesToUsdc: swap failed (tx ${swapTxHash})`);
  }

  return {
    transferTxHash: transferResult.txHash,
    approveTxHash,
    swapTxHash,
    amountInCetes: args.amountCetes,
    amountOutUsdc: expectedOut,
  };
}

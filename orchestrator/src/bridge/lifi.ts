import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { base, arbitrum } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// LI.FI's public aggregator API — confirmed 2026-07-10 to require no API key
// or signup for basic quote+execute usage (tested live against our exact
// Base->Arbitrum USDC route). Replaces Across, whose partner-registration
// form hit an unresolved "already generated" account-recovery error.
const LIFI_API = "https://li.quest/v1";

const ERC20_ABI = [
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
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface LifiQuote {
  tool: string;
  estimate: {
    approvalAddress: Address;
    toAmount: string;
    toAmountMin: string;
  };
  transactionRequest: {
    to: Address;
    data: Hex;
    value: Hex;
    gasLimit: Hex;
    gasPrice: Hex;
  };
}

async function getQuote(params: {
  fromChain: number;
  toChain: number;
  fromToken: Address;
  toToken: Address;
  fromAmount: bigint;
  fromAddress: Address;
  toAddress: Address;
}): Promise<LifiQuote> {
  const qs = new URLSearchParams({
    fromChain: String(params.fromChain),
    toChain: String(params.toChain),
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount.toString(),
    fromAddress: params.fromAddress,
    toAddress: params.toAddress,
  });
  const resp = await fetch(`${LIFI_API}/quote?${qs}`);
  if (!resp.ok) {
    throw new Error(`LI.FI quote failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()) as LifiQuote;
}

function chainConfig(chainId: number) {
  if (chainId === 8453) return base;
  if (chainId === 42161) return arbitrum;
  throw new Error(`lifi.ts: unsupported chainId ${chainId} — only Base (8453) and Arbitrum (42161) are wired`);
}

export interface BridgeResult {
  quoteToAmountMin: bigint;
  approveTxHash: Hex | null;
  bridgeTxHash: Hex;
  finalStatus: string;
  receivedAmount: bigint | null;
}

/**
 * Bridges an ERC-20 from one chain to another via LI.FI's aggregator,
 * submitted from a plain EOA (never Weng's AA wallet directly —
 * CROOValidationModule's selector whitelist doesn't permit the AA wallet to
 * call an arbitrary bridge contract; funds must already be sitting in the
 * EOA before calling this, same pattern as the Aerodrome swap detour).
 *
 * Polls LI.FI's status endpoint until the bridge actually completes on the
 * destination chain — this is a real cross-chain transfer with its own
 * (short, ~seconds for the "eco" route) settlement time, not instant like a
 * same-chain swap.
 */
export async function bridgeErc20(args: {
  ownerPrivateKey: Hex;
  fromChain: number;
  toChain: number;
  fromToken: Address;
  toToken: Address;
  fromAmount: bigint;
  toAddress: Address;
  rpcUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<BridgeResult> {
  const account = privateKeyToAccount(args.ownerPrivateKey);
  const chain = chainConfig(args.fromChain);
  const publicClient = createPublicClient({ chain, transport: http(args.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(args.rpcUrl) });

  const quote = await getQuote({
    fromChain: args.fromChain,
    toChain: args.toChain,
    fromToken: args.fromToken,
    toToken: args.toToken,
    fromAmount: args.fromAmount,
    fromAddress: account.address,
    toAddress: args.toAddress,
  });

  const allowance = (await publicClient.readContract({
    address: args.fromToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, quote.estimate.approvalAddress],
  })) as bigint;

  let approveTxHash: Hex | null = null;
  if (allowance < args.fromAmount) {
    approveTxHash = await walletClient.writeContract({
      address: args.fromToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [quote.estimate.approvalAddress, args.fromAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
  }

  const bridgeTxHash = await walletClient.sendTransaction({
    to: quote.transactionRequest.to,
    data: quote.transactionRequest.data,
    value: BigInt(quote.transactionRequest.value),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: bridgeTxHash });
  if (receipt.status !== "success") {
    throw new Error(`bridgeErc20: source-chain bridge tx failed (tx ${bridgeTxHash})`);
  }

  // Poll the destination side — a successful source tx just means the
  // bridge accepted the deposit, not that funds have landed yet.
  const pollIntervalMs = args.pollIntervalMs ?? 3000;
  const timeoutMs = args.timeoutMs ?? 120000;
  const deadline = Date.now() + timeoutMs;
  let finalStatus = "PENDING";
  let receivedAmount: bigint | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const statusResp = await fetch(
      `${LIFI_API}/status?bridge=${quote.tool}&fromChain=${args.fromChain}&toChain=${args.toChain}&txHash=${bridgeTxHash}`
    );
    if (!statusResp.ok) continue;
    const statusData = (await statusResp.json()) as { status: string; receiving?: { amount?: string } };
    finalStatus = statusData.status;
    if (finalStatus === "DONE") {
      receivedAmount = statusData.receiving?.amount ? BigInt(statusData.receiving.amount) : null;
      break;
    }
    if (finalStatus === "FAILED") {
      throw new Error(`bridgeErc20: LI.FI reports bridge FAILED (source tx ${bridgeTxHash})`);
    }
  }

  if (finalStatus !== "DONE") {
    throw new Error(`bridgeErc20: timed out waiting for bridge completion (source tx ${bridgeTxHash}, last status ${finalStatus})`);
  }

  return {
    quoteToAmountMin: BigInt(quote.estimate.toAmountMin),
    approveTxHash,
    bridgeTxHash,
    finalStatus,
    receivedAmount,
  };
}

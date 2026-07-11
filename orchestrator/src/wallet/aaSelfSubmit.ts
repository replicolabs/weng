import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  encodePacked,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { CROO_VALIDATION_MODULE, ENTRYPOINT_V07 } from "../constants.js";

/**
 * Submits a single call from a CROO agent's AA wallet directly to EntryPoint's
 * handleOps, bypassing CROO's Pimlico paymaster entirely — the wallet pays its
 * own gas from its own ETH balance. Exists because CROOValidationModule's
 * selector whitelist only covers a handful of protocol functions (see
 * constants.ts); this is the mechanism used to move funds out of the AA wallet
 * via Owner-authorized transfer/approve calls that don't go through CROO's
 * backend at all.
 *
 * The Owner key both signs the UserOp (per CROO's Security & Trust Model doc:
 * "Owner ... used for: withdrawals, AA wallet deployment signatures") and pays
 * for the outer handleOps transaction as a plain EOA — anyone can call
 * EntryPoint.handleOps directly, no bundler service required.
 */

const ENTRYPOINT_ABI = [
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
  {
    type: "function",
    name: "handleOps",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "ops",
        type: "tuple[]",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "beneficiary", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getUserOpHash",
    stateMutability: "view",
    inputs: [
      {
        name: "userOp",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "mode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

function packGasLimits(hi: bigint, lo: bigint): Hex {
  return `0x${((hi << 128n) | lo).toString(16).padStart(64, "0")}` as Hex;
}

export interface SelfSubmitResult {
  txHash: Hex;
  success: boolean;
}

/**
 * Calls `target.<calldata>` from `aaWallet`, self-funded (no paymaster),
 * signed by `ownerPrivateKey`. Gas limits are fixed, generous constants —
 * fine on Base given how cheap gas is; not worth dynamic estimation for the
 * handful of calls this project makes.
 */
export async function submitSelfFundedCall(args: {
  ownerPrivateKey: Hex;
  aaWallet: Address;
  target: Address;
  calldata: Hex;
  rpcUrl?: string;
}): Promise<SelfSubmitResult> {
  const account = privateKeyToAccount(args.ownerPrivateKey);
  const publicClient = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(args.rpcUrl) });

  const executionCalldata = encodePacked(["address", "uint256", "bytes"], [args.target, 0n, args.calldata]);
  const callData = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: [zeroHash, executionCalldata],
  });

  const nonceKey = BigInt(CROO_VALIDATION_MODULE);
  const nonce = (await publicClient.readContract({
    address: ENTRYPOINT_V07,
    abi: ENTRYPOINT_ABI,
    functionName: "getNonce",
    args: [args.aaWallet, nonceKey],
  })) as bigint;

  const accountGasLimits = packGasLimits(300000n, 150000n);
  const gasFees = packGasLimits(2000000n, 50000000n); // 0.002 / 0.05 gwei, in wei

  const userOp = {
    sender: args.aaWallet,
    nonce,
    initCode: "0x" as Hex,
    callData,
    accountGasLimits,
    preVerificationGas: 100000n,
    gasFees,
    paymasterAndData: "0x" as Hex,
    signature: "0x" as Hex,
  };

  const userOpHash = (await publicClient.readContract({
    address: ENTRYPOINT_V07,
    abi: ENTRYPOINT_ABI,
    functionName: "getUserOpHash",
    args: [userOp],
  })) as Hex;

  userOp.signature = await account.signMessage({ message: { raw: userOpHash } });

  const txHash = await walletClient.writeContract({
    address: ENTRYPOINT_V07,
    abi: ENTRYPOINT_ABI,
    functionName: "handleOps",
    args: [[userOp], account.address],
    maxFeePerGas: 50000000n,
    maxPriorityFeePerGas: 2000000n,
    gas: 900000n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, success: receipt.status === "success" };
}

const TRANSFER_ABI = [
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

/**
 * Pays an ERC-20 amount directly out of a CROO agent wallet — used on close
 * to return proceeds to the requester. transfer(address,uint256) is one of
 * the few selectors CROOValidationModule actually whitelists for Owner, so
 * unlike a DEX swap this needs only the one self-funded call, no detour
 * through the Owner EOA.
 */
export async function payFromAaWallet(args: {
  ownerPrivateKey: Hex;
  aaWallet: Address;
  token: Address;
  to: Address;
  amount: bigint;
  rpcUrl?: string;
}): Promise<SelfSubmitResult> {
  const calldata = encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [args.to, args.amount] });
  return submitSelfFundedCall({
    ownerPrivateKey: args.ownerPrivateKey,
    aaWallet: args.aaWallet,
    target: args.token,
    calldata,
    rpcUrl: args.rpcUrl,
  });
}

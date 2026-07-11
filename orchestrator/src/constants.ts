// Verified 2026-07-04 against Circle's own docs (developers.circle.com/stablecoins/usdc-contract-addresses)
// and cross-checked on BaseScan (basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
// "Contract Source Code Verified (Exact Match)", FiatTokenProxy). 6 decimals.
export const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
// Confirmed via LI.FI's own quote response (li.quest/v1/quote) resolving this
// exact address as Arbitrum One's canonical USDC — same value used by
// Circle's own contract-address docs.
export const ARBITRUM_MAINNET_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
// LI.FI's convention for "native token of the chain" (confirmed via a live
// gas-cost estimate in a real quote response, not assumed).
export const NATIVE_TOKEN_PLACEHOLDER = "0x0000000000000000000000000000000000000000" as const;
export const USDC_DECIMALS = 6;
export const BASE_CHAIN_ID = 8453;
export const ARBITRUM_CHAIN_ID = 42161;

// Canonical ERC-4337 EntryPoint v0.7, confirmed deployed on Base (matches
// CROO's own "Deployment Info" table: docs.croo.network/developer-docs/smart-contracts).
export const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

// CROOValidationModule — the ERC-7579 validator every CROO agent wallet installs.
// Confirmed via docs.croo.network/developer-docs/smart-contracts and independently
// via on-chain roles()/getExecutorSelectors() reads. Nexus wallets key their nonce
// by validator address (NonceLib.sol in github.com/bcnmy/Nexus) — every self-funded
// UserOp against a CROO agent wallet must use this address as the nonce key.
export const CROO_VALIDATION_MODULE = "0xfCc7eefd6D22bC6a4F35B467928ecAF738d0B3b8" as const;

// Confirmed on-chain (getExecutorSelectors/getOwnerSelectors against
// CROO_VALIDATION_MODULE): Owner is whitelisted for transfer(address,uint256) and
// approve(address,uint256) ONLY — no general "call any contract" permission. This
// means a CROO agent wallet can never call a DEX router directly; USDC must be
// moved out (via Owner-signed transfer) to a separate, unrestricted EOA first.

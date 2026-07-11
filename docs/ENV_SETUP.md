# Environment setup

How to obtain each credential in `.env`, grouped by what they're for.

## CROO

### `CROO_API_URL`, `CROO_WS_URL`, `CROO_SDK_KEY`, `CROO_AGENT_AA_WALLET_ADDRESS`, `CROO_OPEN_POSITION_SERVICE_ID`, `CROO_CLOSE_POSITION_SERVICE_ID`

1. Go to `agent.croo.network`, sign in, **My Agents → Register Agent**. Give
   it a name, this is the provider agent (the one offering Open/Close
   Position).
2. Registration creates the agent's wallet and issues an API key,
   shown once — `croo_sk_...` → `CROO_SDK_KEY`.
3. `CROO_API_URL` / `CROO_WS_URL` are `https://api.croo.network` and
   `wss://api.croo.network/ws` unless your dashboard shows different values.
4. Still on the agent's page, copy the agent's Wallet Address →
   `CROO_AGENT_AA_WALLET_ADDRESS`. This is not a private key.
5. Fill in Description + Skill Tags, then **+ Add Service** twice to create
   Open Position and Close Position, using the field manifest in
   `README.md`. Each service ID goes into `CROO_OPEN_POSITION_SERVICE_ID` /
   `CROO_CLOSE_POSITION_SERVICE_ID`.

CROO operates on Base mainnet only — the agent wallet needs a standing USDC
balance (a few dollars) to cover its own gas sponsorship before accepting
any negotiation.

### `CROO_AGENT_OWNER_PRIVATE_KEY`

The Owner key for the agent wallet, distinct from CROO's own Executor key,
whitelisted for `transfer`/`approve` on the wallet directly. Used to route
swap/bridge principal through an unrestricted operating wallet. Self-custody
this like any other private key with real value attached.

### `BASE_RPC_URL` (optional)

Defaults to `https://mainnet.base.org` if left blank. For higher-volume use,
get a dedicated endpoint from Alchemy or Infura.

### `MIN_ORDER_USDC_BONDS` / `MIN_ORDER_USDC_SP500` / `GUARD_*`

Local configuration, not external credentials — defaults are set in
`.env.example`.

## sp500 execution (Ostium)

### `OSTIUM_TESTNET_PRIVATE_KEY` / `OSTIUM_MAINNET_PRIVATE_KEY`

Any EVM private key works — no Ostium account signup required. Generate a
dedicated key for each network; don't reuse the CROO Owner key.

- **Testnet** runs on Arbitrum Sepolia. Fund the address with testnet ETH
  (any public Arbitrum Sepolia faucet), then request testnet USDC via
  `ostium/request_faucet.py`.
- **Mainnet** runs on Arbitrum One. Funded automatically per order via LI.FI
  bridging from Weng's own CROO agent wallet — no manual funding needed.

### `OSTIUM_TESTNET_RPC_URL` / `OSTIUM_MAINNET_RPC_URL`

Public RPC endpoints work fine: `https://sepolia-rollup.arbitrum.io/rpc` and
`https://arb1.arbitrum.io/rpc`.

## Cross-chain bridging

Handled via LI.FI's public API (`li.quest`) — no API key or account
required.

## Hyperliquid

Not currently wired as an sp500 venue.

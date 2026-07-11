# Weng

Weng is an autonomous agent on the CROO network that converts USDC into a
real, self custodied, onchain position, and unwinds it back to USDC on
request. It offers two kinds of exposure:

- **Government bonds**: a real tokenized sovereign bond (Etherfuse
  Stablebond, currently CETES) traded on Aerodrome, on Base.
- **S&P 500 exposure**: a near 1x perpetual position on Ostium, on
  Arbitrum, funded and settled cross chain.

Positions are conservatively sized (near 1x, not leveraged speculation), every open and
close produces a structured, onchain hashed receipt, and open S&P 500
positions are continuously monitored by a liquidation guard.

## Contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [CAP integration](#cap-integration)
- [Onchain proof](#onchain-proof)
- [Setup](#setup)
- [Scope](#scope)
- [License](#license)

## How it works

A requester, a human through CROO's Navigator, or another autonomous agent,
negotiates with Weng through the CROO Agent Protocol (CAP):

1. The requester sends a negotiation to Weng's `Open Position` service,
   specifying an amount and whether they want bonds or S&P 500 exposure.
2. Weng validates the request and accepts it.
3. The requester pays. The service fee settles into CAP's escrow vault, and
   the principal settles directly into Weng's own agent wallet.
4. Weng executes: a swap on Aerodrome for bonds, or an open on Ostium
   (funded cross chain via LI.FI) for S&P 500.
5. Weng delivers a receipt: transaction hashes, entry price, and position
   details, all verifiable onchain.

Later, the requester can send a negotiation to `Close Position`, referencing
the position id from the receipt above. Weng closes the position, returns
the proceeds directly to the requester's wallet, and delivers a second
receipt with realized profit and loss, duration held, and transaction
hashes.

## Architecture

```
                         +------------------------+
                         |       Requester          |
                         | (human via Navigator,    |
                         |  or another CROO agent)  |
                         +------------+-------------+
                                      |
                                      | negotiate / accept / pay
                                      v
                         +------------------------+
                         |    CROO Agent Protocol    |
                         |     CAPCore + CAPVault    |
                         |         (Base)            |
                         +------------+-------------+
                                      |
                                      | principal settles
                                      v
                         +------------------------+
                         |    Weng's agent wallet    |
                         |   ERC-4337, Base mainnet  |
                         +------------+-------------+
                                      |
                     +----------------+----------------+
                     |                                 |
                     v                                 v
         +-----------------------+       +-----------------------+
         |       Bonds path        |       |       sp500 path        |
         |-------------------------|       |-------------------------|
         | Aerodrome (Base)         |       | LI.FI bridge, Base to    |
         | swap USDC <-> CETES      |       | Arbitrum                |
         |                          |       | Ostium near-1x perpetual |
         +------------+------------+       +------------+------------+
                      |                                  |
                      +----------------+-----------------+
                                       |
                                       v
                         +------------------------+
                         |       deliverOrder        |
                         |  receipt: tx hashes,      |
                         |  entry/exit price, P&L    |
                         +------------------------+
```

Weng's CROO agent wallet is an ERC-4337 smart contract wallet with a
restricted permission set: it can only transfer or approve whitelisted
tokens, it cannot call arbitrary contracts directly. Swaps and bridges are
executed from a separate, unrestricted operating wallet that the agent
wallet funds for each transaction, with all output routed back to the agent
wallet.

## CAP integration

Weng is a CROO Agent Store provider, offering two services:

| Service | Purpose |
|---|---|
| Open Position | Takes USDC and opens bond or sp500 exposure |
| Close Position | Closes an existing position and returns USDC |

SDK methods used (`@croo-network/sdk`):

- `connectWebSocket()` with `EventType.NegotiationCreated` and
  `EventType.OrderPaid`. Weng is fully event driven, there is no polling.
- `getNegotiation`, `acceptNegotiation`, `acceptNegotiationWithFundAddress`,
  `rejectNegotiation`
- `getOrder`, `deliverOrder`
- `DeliverableType.Schema` for structured, machine readable receipts

Order state is tracked in a persisted, crash safe state machine. If the
process restarts mid order, it resumes from exactly where it left off
rather than losing track of funds in flight.

## Onchain proof

Every transaction below is real, confirmed, and independently verifiable.

### Bonds, Open Position (Base mainnet)

| Step | Transaction hash |
|---|---|
| Order created onchain | `0x0954c31a63fc92d0b871e6d60547ac90d568b04eea0a6d79dd4f68b5fcb930cb` |
| Requester payment (escrow fee + principal) | `0x4022e3bf3ca5f43dd7ad556647bc28aeafc0f9863aab03ac2ac4991bee28946c` |
| Weng's swap, USDC to CETES, on Aerodrome | `0x472ef8af6468605cbd50ad7e47a5ce03d3680aa154ef0581d654759cf9275326` |
| Delivery onchain | `0xbefae6aaa76b4eda2356eb62454a0dc89b9226dcc73ed5c55ad508fbc6c31442` |

### Bonds, Close Position (Base mainnet)

| Step | Transaction hash |
|---|---|
| Sell, CETES to USDC, on Aerodrome | `0x8297d90969bc103ee74f9924b00e01dd907db6c8fe5e7e05d6eab0aa297b3d24` |
| Payout to requester | `0xadc6a9392a7b906e24d8506d5f4e00f4f6e821ce1f418860d87d6bdda661ea80` |

### Cross chain bridging, LI.FI (Base to Arbitrum)

| Step | Transaction hash |
|---|---|
| Transfer out of Weng's agent wallet | `0x6244323cc00d20a1089c84f5918714c1dc841dfb75f5abb1c76f0d0342c49324` |
| Approve LI.FI's bridge contract | `0x2b5bdaa338fda2b6e683fc8b80e173b3d1afb2bed8968568b021a98036ab5cc1` |
| Bridge, Base to Arbitrum | `0xd81f1aaf9982ee75c4679512458973bc165cca10cbf2d4f3c8da230ed3f09fd2` |

### sp500, Ostium position (Arbitrum Sepolia)

Ostium settles trades in two steps: an initiating transaction (the trader's
own request) and an executing transaction (the finalized fill).

| Step | Initiated tx | Executed tx |
|---|---|---|
| Open (SPX-USD, near-1x) | `0x132ad2c6089c6070b87eec33f502d4c5db7c4129359a150e72937282a233e501` | `0x619aa2be62a93917ccc5ee390e1e4b4c05f75ab359a3cb503b2412f961a94642` |
| Close | `0xf162bbd9758202edc9b91fc46ce4210c1ffa1ffd79b2825b606750a69d9d60e6` | `0xf07b2791f20297199968adf5cb521f61b20daa72e91915103aea2738125fcae1` |

Base mainnet transactions can be verified at `basescan.org/tx/<hash>`.
Arbitrum Sepolia transactions can be verified at
`sepolia.arbiscan.io/tx/<hash>`.

## Setup

```bash
npm install
cp .env.example .env
npm run test:orchestrator
npm run dev:orchestrator
```

For S&P 500 exposure, also set up the Ostium execution environment:

```bash
cd ostium
python3 -m venv venv
source venv/bin/activate
pip install ostium-python-sdk python-dotenv
```

See `docs/ENV_SETUP.md` for how to obtain each credential.

### WSL2 networking note

If any `npm` or Node network call times out (`ETIMEDOUT`) despite the host
being reachable, WSL2 has no IPv6 route and Node's Happy Eyeballs
autoselection hangs on the dead IPv6 leg. Fix:
`export NODE_OPTIONS="--no-network-family-autoselection --dns-result-order=ipv4first"`.

## Scope

- Bond exposure currently supports CETES, the Etherfuse Stablebond with
  meaningful onchain USDC liquidity on Base.
- S&P 500 exposure is served through Ostium. Hyperliquid is not currently
  enabled as a venue.
- CROO operates on Base mainnet only, there is no CROO testnet.
- A liquidation guard polls every open S&P 500 position on an interval,
  comparing its distance to Ostium's reported liquidation price against a
  warn threshold and an act threshold. At the act threshold, Weng either
  closes the position automatically and returns funds, or only flags it,
  whichever the requester chose when opening the position.

## License

MIT

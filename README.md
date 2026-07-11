# Weng

Weng is a CROO-callable agent that converts USDC into a self-custodied,
onchain position and unwinds it back to USDC on request. It offers two
kinds of exposure:

- **Government bonds** — a real tokenized sovereign bond (Etherfuse
  Stablebond, currently CETES) via Aerodrome on Base.
- **S&P 500 exposure** — a near-1x perpetual position via Ostium on
  Arbitrum.

Every open and close produces a structured, onchain-hashed receipt with
a transaction proof. Positions are conservatively sized (near-1x, not leveraged
speculation) and continuously monitored by a liquidation guard.

## How it works

A requester (a human via CROO's Navigator, or another agent) negotiates with
Weng through the CROO Agent Protocol (CAP):

```
Requester → negotiate → Weng validates & accepts → requester pays →
principal settles onchain → Weng opens the position → Weng delivers a
receipt (transaction hashes, entry price, position details)

... later ...

Requester → negotiate a close, referencing the open position → Weng closes
it, returns the proceeds → Weng delivers a receipt (realized P&L, duration
held, transaction hashes)
```

Bond exposure settles entirely on Base. S&P 500 exposure settles on
Arbitrum, with principal and proceeds moved cross-chain via LI.FI.

A liquidation guard continuously monitors open S&P 500 positions. If a
position's distance to liquidation drops below a warning threshold, it's
flagged; if it drops below an action threshold, Weng either closes the
position and returns funds automatically, or only flags it — whichever the
requester chose when opening the position.

## CAP integration

Weng is a CROO Agent Store provider, offering two services:

| Service | Purpose |
|---|---|
| **Open Position** | Takes USDC and opens bond or sp500 exposure |
| **Close Position** | Closes an existing position and returns USDC |

SDK methods used (`@croo-network/sdk`):

- `connectWebSocket()` + `EventType.NegotiationCreated` / `EventType.OrderPaid` — event-driven, no polling
- `getNegotiation`, `acceptNegotiation`, `acceptNegotiationWithFundAddress`, `rejectNegotiation`
- `getOrder`, `deliverOrder`
- `DeliverableType.Schema` for structured receipts

Order state is tracked in a persisted, crash-safe state machine, if the
process restarts mid-order, it picks up exactly where it left off rather
than losing track of funds in flight.

## Architecture

```
CROO negotiate/accept/pay → principal settles at Weng's own CROO agent
wallet → Weng executes:

  bonds:  swap USDC <-> CETES on Aerodrome (Base)

  sp500:  bridge principal to a dedicated Arbitrum wallet (LI.FI) ->
          open/close a near-1x position on Ostium -> bridge proceeds back

→ deliverOrder with the position receipt (real tx hashes, entry/exit
  price, realized P&L)
```

Weng's CROO agent wallet is an ERC-4337 smart contract wallet with a
restricted permission set — it can only transfer/approve whitelisted
tokens, not call arbitrary contracts. Swaps and bridges are executed from a
separate, unrestricted operating wallet that the agent wallet funds for
each transaction, with output routed back to the agent wallet.

## Setup

```bash
npm install
cp .env.example .env   # fill in credentials, see docs/ENV_SETUP.md
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

If any `npm`/Node network call times out (`ETIMEDOUT`) despite the host
being reachable, WSL2 has no IPv6 route and Node's Happy Eyeballs
autoselection hangs on the dead IPv6 leg. Fix:
`export NODE_OPTIONS="--no-network-family-autoselection --dns-result-order=ipv4first"`.

## Scope

- Bond exposure currently supports CETES (the Etherfuse Stablebond with
  meaningful onchain USDC liquidity on Base).
- S&P 500 exposure is served via Ostium, with Hyperliquid still in the roadmap as a venue.
- CROO operates on Base mainnet.

## License

MIT

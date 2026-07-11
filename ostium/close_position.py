"""
Closes an existing Ostium position (full close only — Weng doesn't do
partial closes). Called as a subprocess by the Node orchestrator; prints a
single JSON line to stdout on success.

Usage: python3 close_position.py <testnet|mainnet> <pair_id> <trade_index>
"""
import asyncio
import json
import sys
from _sdk import build_sdk


async def main():
    if len(sys.argv) < 4:
        print("usage: close_position.py <testnet|mainnet> <pair_id> <trade_index>", file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1]
    pair_id = int(sys.argv[2])
    trade_index = int(sys.argv[3])

    sdk = build_sdk(mode)

    pairs = await sdk.subgraph.get_pairs()
    pair = next((p for p in pairs if int(p["id"]) == pair_id), None)
    if pair is None:
        print(f"pair_id {pair_id} not found", file=sys.stderr)
        sys.exit(1)
    from_symbol, to_symbol = pair["from"], pair["to"]

    latest_price, _, _ = await sdk.price.get_price(from_symbol, to_symbol)

    metrics = await sdk.get_open_trade_metrics(pair_id, trade_index)

    result = sdk.ostium.close_trade(pair_id, trade_index, latest_price)
    tx_hash = result["receipt"]["transactionHash"].hex()

    print(json.dumps({
        "txHash": tx_hash,
        "pairId": pair_id,
        "tradeIndex": trade_index,
        "exitPrice": latest_price,
        "metrics": {k: str(v) for k, v in metrics.items()} if metrics else {},
    }))


if __name__ == "__main__":
    asyncio.run(main())

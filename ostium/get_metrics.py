"""
Fetches live trade metrics (liquidation price, current PnL, etc.) for an open
Ostium position — used by the liquidation guard's polling loop. Read-only,
no transaction submitted.

Usage: python3 get_metrics.py <testnet|mainnet> <pair_id> <trade_index>
"""
import asyncio
import json
import sys
from _sdk import build_sdk


async def main():
    if len(sys.argv) < 4:
        print("usage: get_metrics.py <testnet|mainnet> <pair_id> <trade_index>", file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1]
    pair_id = int(sys.argv[2])
    trade_index = int(sys.argv[3])

    sdk = build_sdk(mode)
    metrics = await sdk.get_open_trade_metrics(pair_id, trade_index)

    print(json.dumps({k: str(v) for k, v in metrics.items()} if metrics else {}))


if __name__ == "__main__":
    asyncio.run(main())

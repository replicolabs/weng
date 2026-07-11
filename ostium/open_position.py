"""
Opens a near-1x long position on Ostium (default pair: SPX-USD, id 10) sized
to a USDC collateral amount. Called as a subprocess by the Node orchestrator;
prints a single JSON line to stdout on success, or exits non-zero with an
error message on stderr on failure.

Usage: python3 open_position.py <testnet|mainnet> <collateral_usdc> [pair_id] [leverage]
"""
import asyncio
import json
import sys
from _sdk import build_sdk


async def main():
    if len(sys.argv) < 3:
        print("usage: open_position.py <testnet|mainnet> <collateral_usdc> [pair_id] [leverage]", file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1]
    collateral_usdc = float(sys.argv[2])
    pair_id = int(sys.argv[3]) if len(sys.argv) > 3 else 10  # SPX-USD
    leverage = int(sys.argv[4]) if len(sys.argv) > 4 else 1  # near-1x exposure by design

    sdk = build_sdk(mode)

    pairs = await sdk.subgraph.get_pairs()
    pair = next((p for p in pairs if int(p["id"]) == pair_id), None)
    if pair is None:
        print(f"pair_id {pair_id} not found", file=sys.stderr)
        sys.exit(1)
    from_symbol, to_symbol = pair["from"], pair["to"]

    latest_price, is_market_open, is_day_trading_closed = await sdk.price.get_price(from_symbol, to_symbol)
    if not is_market_open or is_day_trading_closed:
        print(
            f"market for {from_symbol}-{to_symbol} is currently closed "
            f"(isMarketOpen={is_market_open}, isDayTradingClosed={is_day_trading_closed})",
            file=sys.stderr,
        )
        sys.exit(1)

    trade_params = {
        "collateral": collateral_usdc,
        "leverage": leverage,
        "asset_type": pair_id,
        "direction": True,  # long — Weng tracks the index, doesn't short it
        "order_type": "MARKET",
    }
    result = sdk.ostium.perform_trade(trade_params, at_price=latest_price)
    tx_hash = result["receipt"]["transactionHash"].hex()

    # Trade index isn't known until the tx is mined and indexed — poll briefly.
    address = sdk.ostium.get_public_address()
    trade_index = None
    for _ in range(10):
        await asyncio.sleep(2)
        open_trades = await sdk.subgraph.get_open_trades(address)
        match = next(
            (t for t in open_trades if int(t["pair"]["id"]) == pair_id and t.get("index") is not None),
            None,
        )
        if match:
            trade_index = match["index"]
            break

    print(json.dumps({
        "txHash": tx_hash,
        "pairId": pair_id,
        "pairSymbol": f"{from_symbol}-{to_symbol}",
        "entryPrice": latest_price,
        "collateralUsdc": collateral_usdc,
        "leverage": leverage,
        "tradeIndex": trade_index,
    }))


if __name__ == "__main__":
    asyncio.run(main())

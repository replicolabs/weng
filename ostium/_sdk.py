"""
Shared SDK instantiation for testnet vs mainnet, used by open_position.py,
close_position.py, and request_faucet.py. Mode is always passed explicitly by
the caller (the Node orchestrator, or a human running a script by hand) —
never inferred from TRADING_MODE here, so a script can never silently use the
wrong network's keys.
"""
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from ostium_python_sdk import OstiumSDK, NetworkConfig

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def build_sdk(mode: str) -> OstiumSDK:
    if mode not in ("testnet", "mainnet"):
        print(f"invalid mode '{mode}', must be 'testnet' or 'mainnet'", file=sys.stderr)
        sys.exit(1)

    key_var = "OSTIUM_MAINNET_PRIVATE_KEY" if mode == "mainnet" else "OSTIUM_TESTNET_PRIVATE_KEY"
    rpc_var = "OSTIUM_MAINNET_RPC_URL" if mode == "mainnet" else "OSTIUM_TESTNET_RPC_URL"
    private_key = os.getenv(key_var)
    rpc_url = os.getenv(rpc_var)
    if not private_key or not rpc_url:
        print(f"{key_var} / {rpc_var} missing from .env", file=sys.stderr)
        sys.exit(1)

    config = NetworkConfig.mainnet() if mode == "mainnet" else NetworkConfig.testnet()
    return OstiumSDK(config, private_key, rpc_url)

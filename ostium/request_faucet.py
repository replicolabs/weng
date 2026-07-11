"""
Requests testnet USDC from Ostium's own faucet (Arbitrum Sepolia only).
Needs OSTIUM_TESTNET_PRIVATE_KEY + OSTIUM_TESTNET_RPC_URL in the repo-root
.env, and the account needs a small amount of Arbitrum Sepolia ETH already —
the faucet call itself is a real transaction and needs gas to submit, same as
any other write operation on the SDK.
"""
import os
from pathlib import Path
from dotenv import load_dotenv
from ostium_python_sdk import OstiumSDK, NetworkConfig

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

private_key = os.getenv("OSTIUM_TESTNET_PRIVATE_KEY")
rpc_url = os.getenv("OSTIUM_TESTNET_RPC_URL")
if not private_key or not rpc_url:
    raise SystemExit("OSTIUM_TESTNET_PRIVATE_KEY / OSTIUM_TESTNET_RPC_URL missing from .env")

sdk = OstiumSDK(NetworkConfig.testnet(), private_key, rpc_url)
address = sdk.ostium.get_public_address()

eth_balance = sdk.ostium.web3.eth.get_balance(address)
print(f"address: {address}")
print(f"Arbitrum Sepolia ETH balance: {sdk.ostium.web3.from_wei(eth_balance, 'ether')}")

if eth_balance == 0:
    raise SystemExit(
        "No Arbitrum Sepolia ETH yet — fund this address from a faucet "
        "(e.g. https://www.alchemy.com/faucets/arbitrum-sepolia) before requesting testnet USDC."
    )

if sdk.faucet.can_request_tokens(address):
    amount = sdk.faucet.get_token_amount()
    print(f"requesting faucet tokens, will receive {amount} testnet USDC...")
    receipt = sdk.faucet.request_tokens()
    print(f"success, tx: {receipt['transactionHash'].hex()}")
else:
    next_time = sdk.faucet.get_next_request_time(address)
    print(f"cannot request yet, next allowed at: {next_time}")

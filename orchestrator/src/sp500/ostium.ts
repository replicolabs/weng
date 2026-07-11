import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Ostium's officially maintained SDK is Python-only (the community TS port
// isn't Ostium-maintained — see docs/ENV_SETUP.md) — real execution goes
// through the venv here, not a Node dependency.
const OSTIUM_DIR = join(__dirname, "../../../ostium");
const PYTHON_BIN = join(OSTIUM_DIR, "venv/bin/python3");

export const SPX_USD_PAIR_ID = 10;

function runPython(script: string, args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [join(OSTIUM_DIR, script), ...args], { cwd: OSTIUM_DIR });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${script} exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop()!));
      } catch (err) {
        reject(new Error(`${script}: could not parse output as JSON: ${stdout}`));
      }
    });
    proc.on("error", reject);
  });
}

export type OstiumMode = "testnet" | "mainnet";

export interface OpenPositionResult {
  txHash: string;
  pairId: number;
  pairSymbol: string;
  entryPrice: number;
  collateralUsdc: number;
  leverage: number;
  tradeIndex: number | null;
}

export interface ClosePositionResult {
  txHash: string;
  pairId: number;
  tradeIndex: number;
  exitPrice: number;
  metrics: Record<string, string>;
}

/** Opens a near-1x long position sized to `collateralUsdc`. Defaults to SPX-USD. */
export async function openOstiumPosition(
  mode: OstiumMode,
  collateralUsdc: number,
  pairId: number = SPX_USD_PAIR_ID,
  leverage = 1
): Promise<OpenPositionResult> {
  const result = await runPython("open_position.py", [mode, String(collateralUsdc), String(pairId), String(leverage)]);
  return result as unknown as OpenPositionResult;
}

export async function closeOstiumPosition(mode: OstiumMode, pairId: number, tradeIndex: number): Promise<ClosePositionResult> {
  const result = await runPython("close_position.py", [mode, String(pairId), String(tradeIndex)]);
  return result as unknown as ClosePositionResult;
}

/** Read-only — no transaction. Used by the liquidation guard's poll loop. */
export async function getOstiumTradeMetrics(
  mode: OstiumMode,
  pairId: number,
  tradeIndex: number
): Promise<Record<string, string>> {
  const result = await runPython("get_metrics.py", [mode, String(pairId), String(tradeIndex)]);
  return result as Record<string, string>;
}

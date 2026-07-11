import { z } from "zod";

const TradingMode = z.enum(["testnet", "mainnet"]);

const baseSchema = z.object({
  CROO_API_URL: z.string().url(),
  CROO_WS_URL: z.string().url(),
  CROO_SDK_KEY: z.string().min(1, "CROO_SDK_KEY is required (from CROO Dashboard)"),
  CROO_OPEN_POSITION_SERVICE_ID: z.string().min(1, "create the Open Position service in the CROO Dashboard first"),
  CROO_CLOSE_POSITION_SERVICE_ID: z.string().min(1, "create the Close Position service in the CROO Dashboard first"),
  // Empty string (unset in .env) must mean "not provided", not "invalid URL".
  BASE_RPC_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  TRADING_MODE: TradingMode,
  // Per docs.croo.network/developer-docs/core-concepts/account-and-wallet-architecture.md:
  // "the providerFundAddress should be the AA wallet address itself... there is
  // no separate developer-generated wallet in this architecture." This is the
  // Agent's own AA wallet address (visible in the Dashboard Configure page),
  // NOT a key Weng generates or holds — CROO's non-exportable Executor signs
  // for it. See docs/ENV_SETUP.md for the still-open question of how the
  // actual fund movement/swap execution is triggered.
  CROO_AGENT_AA_WALLET_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "CROO_AGENT_AA_WALLET_ADDRESS must be a 0x-prefixed 20-byte EVM address"),
  // Needed for gate 2: CROOValidationModule's selector whitelist never lets the
  // AA wallet call a DEX router directly, so moving swap principal out of the
  // wallet requires an Owner-signed, self-funded UserOp (src/wallet/aaSelfSubmit.ts).
  // Per CROO's Security & Trust Model doc, Owner is "self-custodied by the user"
  // and specifically used for "AA wallet deployment signatures" — this is that
  // same key, already treated as compromised-on-sight per its own .env comment.
  CROO_AGENT_OWNER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "CROO_AGENT_OWNER_PRIVATE_KEY must be a 0x-prefixed 32-byte private key"),
  MIN_ORDER_USDC_BONDS: z.coerce.number().positive(),
  MIN_ORDER_USDC_SP500: z.coerce.number().positive(),
  GUARD_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  GUARD_WARN_LIQUIDATION_DISTANCE_PCT: z.coerce.number().positive(),
  GUARD_ACT_LIQUIDATION_DISTANCE_PCT: z.coerce.number().positive(),
});

// Per-venue, not one monolithic sp500 schema — Hyperliquid and Ostium are
// independently usable (see .env: Hyperliquid deferred, its testnet faucet
// gates on a real mainnet deposit we're not paying for; Ostium has no such
// gate and is what gate 3 actually runs on right now). Requiring all venues'
// credentials at once would fail closed even when only one is in use.
const ostiumTestnetSchema = z.object({
  OSTIUM_TESTNET_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  OSTIUM_TESTNET_RPC_URL: z.string().url(),
});

const ostiumMainnetSchema = z.object({
  OSTIUM_MAINNET_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  OSTIUM_MAINNET_RPC_URL: z.string().url(),
});

const hyperliquidMainnetSchema = z.object({
  HYPERLIQUID_MAINNET_AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const hyperliquidTestnetSchema = z.object({
  HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export type Config = z.infer<typeof baseSchema> & {
  guard: {
    pollIntervalSeconds: number;
    warnLiquidationDistancePct: number;
    actLiquidationDistancePct: number;
  };
};

/**
 * Fails closed: throws with every missing/invalid var listed, rather than
 * starting half-configured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = baseSchema.safeParse(env);
  if (!base.success) {
    throw new Error(`Config error (base):\n${formatIssues(base.error)}`);
  }

  return {
    ...base.data,
    guard: {
      pollIntervalSeconds: base.data.GUARD_POLL_INTERVAL_SECONDS,
      warnLiquidationDistancePct: base.data.GUARD_WARN_LIQUIDATION_DISTANCE_PCT,
      actLiquidationDistancePct: base.data.GUARD_ACT_LIQUIDATION_DISTANCE_PCT,
    },
  };
}

/**
 * Fails closed right before Ostium is actually used, not at general boot —
 * gate 1/2 shouldn't refuse to start over sp500 credentials nothing has
 * touched yet.
 */
export function loadOstiumConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env
): z.infer<typeof ostiumTestnetSchema> | z.infer<typeof ostiumMainnetSchema> {
  const schema = config.TRADING_MODE === "mainnet" ? ostiumMainnetSchema : ostiumTestnetSchema;
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Config error (Ostium, TRADING_MODE=${config.TRADING_MODE}):\n${formatIssues(result.error)}`);
  }
  return result.data;
}

/** Same fail-closed pattern as loadOstiumConfig, for whenever Hyperliquid is unblocked. */
export function loadHyperliquidConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env
): z.infer<typeof hyperliquidTestnetSchema> | z.infer<typeof hyperliquidMainnetSchema> {
  const schema = config.TRADING_MODE === "mainnet" ? hyperliquidMainnetSchema : hyperliquidTestnetSchema;
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Config error (Hyperliquid, TRADING_MODE=${config.TRADING_MODE}):\n${formatIssues(result.error)}`);
  }
  return result.data;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

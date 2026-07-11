import { AgentClient, type Logger } from "@croo-network/sdk";
import type { Config } from "../config.js";

export function buildCrooClient(config: Config, logger: Logger): AgentClient {
  return new AgentClient(
    {
      baseURL: config.CROO_API_URL,
      wsURL: config.CROO_WS_URL,
      rpcURL: config.BASE_RPC_URL,
      logger,
    },
    config.CROO_SDK_KEY
  );
}

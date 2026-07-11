import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/state/db.js";
import {
  createOrder,
  transition,
  getOrder,
  listResumable,
  InvalidTransitionError,
} from "../src/state/orderStateMachine.js";

let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("order state machine", () => {
  it("creates an order at the first pipeline state", () => {
    const order = createOrder(db, {
      crooNegotiationId: "neg-1",
      service: "open_position",
      exposure: "bonds",
      amountUsdc: "25.00",
      requirements: { amount_usdc: 25, target_exposure: "bonds", bond_selection: "CETES" },
    });
    expect(order.state).toBe("received");
  });

  it("advances through the exact pipeline sequence", () => {
    const order = createOrder(db, {
      crooNegotiationId: "neg-2",
      service: "open_position",
      exposure: "bonds",
      amountUsdc: "25.00",
      requirements: {},
    });
    transition(db, order.id, "swapping");
    transition(db, order.id, "swapped");
    const final = transition(db, order.id, "delivered");
    expect(final.state).toBe("delivered");
  });

  it("rejects skipping a pipeline step", () => {
    const order = createOrder(db, {
      crooNegotiationId: "neg-3",
      service: "open_position",
      exposure: "bonds",
      amountUsdc: "25.00",
      requirements: {},
    });
    expect(() => transition(db, order.id, "swapped")).toThrow(InvalidTransitionError);
  });

  it("is idempotent: repeating the current state is a safe no-op (crash-resume simulation)", () => {
    const order = createOrder(db, {
      crooNegotiationId: "neg-4",
      service: "open_position",
      exposure: "sp500",
      amountUsdc: "50.00",
      requirements: {},
    });
    transition(db, order.id, "bridging", { txRef: { step: "bridge_out", hash: "0xabc" } });
    // Simulate a crash right after the bridge tx lands but before the orchestrator
    // moved on — restart calls the same transition again.
    const resumed = transition(db, order.id, "bridging");
    expect(resumed.state).toBe("bridging");
    const refs = JSON.parse(resumed.tx_refs_json);
    expect(refs.bridge_out).toBe("0xabc");
  });

  it("records tx refs across multiple steps without losing earlier ones", () => {
    const order = createOrder(db, {
      crooNegotiationId: "neg-5",
      service: "open_position",
      exposure: "sp500",
      amountUsdc: "50.00",
      requirements: {},
    });
    transition(db, order.id, "bridging", { txRef: { step: "bridge_out", hash: "0x1" } });
    transition(db, order.id, "bridged", { txRef: { step: "bridge_in", hash: "0x2" } });
    const order2 = getOrder(db, order.id)!;
    const refs = JSON.parse(order2.tx_refs_json);
    expect(refs).toEqual({ bridge_out: "0x1", bridge_in: "0x2" });
  });

  it("allows transition to failed from any non-terminal state", () => {
    const order = createOrder(db, {
      crooNegotiationId: "neg-6",
      service: "open_position",
      exposure: "sp500",
      amountUsdc: "50.00",
      requirements: {},
    });
    transition(db, order.id, "bridging");
    const failed = transition(db, order.id, "failed", { error: "bridge timeout" });
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("bridge timeout");
  });

  it("surfaces exactly the stranded-funds case via listResumable (the scariest state in section 2.5.4)", () => {
    const order = createOrder(db, {
      crooNegotiationId: "neg-7",
      service: "open_position",
      exposure: "sp500",
      amountUsdc: "50.00",
      requirements: {},
    });
    transition(db, order.id, "bridging");
    transition(db, order.id, "bridged"); // funds bridged, position not yet opened
    const resumable = listResumable(db);
    expect(resumable.map((o) => o.id)).toContain(order.id);
    expect(resumable.find((o) => o.id === order.id)!.state).toBe("bridged");
  });

  it("excludes delivered/failed orders from listResumable", () => {
    const a = createOrder(db, {
      crooNegotiationId: "neg-8",
      service: "open_position",
      exposure: "bonds",
      amountUsdc: "25.00",
      requirements: {},
    });
    transition(db, a.id, "swapping");
    transition(db, a.id, "swapped");
    transition(db, a.id, "delivered");

    const b = createOrder(db, {
      crooNegotiationId: "neg-9",
      service: "open_position",
      exposure: "bonds",
      amountUsdc: "25.00",
      requirements: {},
    });
    transition(db, b.id, "failed", { error: "insufficient liquidity" });

    const resumable = listResumable(db);
    expect(resumable.map((o) => o.id)).not.toContain(a.id);
    expect(resumable.map((o) => o.id)).not.toContain(b.id);
  });
});

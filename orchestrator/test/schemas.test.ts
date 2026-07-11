import { describe, it, expect } from "vitest";
import { OpenPositionRequirements, ClosePositionRequirements, parseRequirements } from "../src/croo/schemas.js";

describe("OpenPositionRequirements", () => {
  it("accepts a valid bonds request", () => {
    const result = parseRequirements(
      OpenPositionRequirements,
      JSON.stringify({ amount_usdc: 25, target_exposure: "bonds", bond_selection: "CETES" })
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a valid sp500 request with default venue_preference", () => {
    const result = parseRequirements(
      OpenPositionRequirements,
      JSON.stringify({ amount_usdc: 50, target_exposure: "sp500" })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.venue_preference).toBe("auto");
  });

  it("rejects bonds requests missing bond_selection (conditional-required, not expressible in the Dashboard builder)", () => {
    const result = parseRequirements(
      OpenPositionRequirements,
      JSON.stringify({ amount_usdc: 25, target_exposure: "bonds" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("bond_selection");
  });

  it("rejects an invalid target_exposure (enum, not expressible in the Dashboard builder)", () => {
    const result = parseRequirements(
      OpenPositionRequirements,
      JSON.stringify({ amount_usdc: 25, target_exposure: "stocks" })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-positive amount_usdc", () => {
    const result = parseRequirements(
      OpenPositionRequirements,
      JSON.stringify({ amount_usdc: 0, target_exposure: "sp500" })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects malformed JSON with a clear reason", () => {
    const result = parseRequirements(OpenPositionRequirements, "{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("requirements is not valid JSON");
  });

  it("rejects an invalid venue_preference", () => {
    const result = parseRequirements(
      OpenPositionRequirements,
      JSON.stringify({ amount_usdc: 50, target_exposure: "sp500", venue_preference: "binance" })
    );
    expect(result.ok).toBe(false);
  });
});

describe("ClosePositionRequirements", () => {
  it("accepts a valid request", () => {
    const result = parseRequirements(ClosePositionRequirements, JSON.stringify({ position_id: "abc-123" }));
    expect(result.ok).toBe(true);
  });

  it("rejects a missing position_id", () => {
    const result = parseRequirements(ClosePositionRequirements, JSON.stringify({}));
    expect(result.ok).toBe(false);
  });
});

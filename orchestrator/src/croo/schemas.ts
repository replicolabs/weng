import { z } from "zod";

// Mirrors section 2.1 of the build rules exactly. The CROO Dashboard's schema
// builder (per docs.croo.network/developer-docs/core-concepts/service-registration.md)
// only supports flat fields (name/type/required/description) — it has no enum
// constraint and no conditional-required support. Both are enforced here
// instead, at negotiation time, with a clear rejection reason.
export const OpenPositionRequirements = z
  .object({
    amount_usdc: z.number().positive(),
    target_exposure: z.enum(["bonds", "sp500"]),
    bond_selection: z.string().min(1).optional(),
    venue_preference: z.enum(["auto", "hyperliquid", "ostium"]).optional().default("auto"),
    // sp500 only — ignored for bonds (no liquidation risk on a spot holding).
    // Section 2.4's ACT tier defaults to protecting the requester's capital,
    // but it's their call whether Weng may move funds without an explicit
    // request — "warn_only" means the guard only ever logs/marks state.
    liquidation_action: z.enum(["auto_close", "warn_only"]).optional().default("auto_close"),
  })
  .superRefine((val, ctx) => {
    if (val.target_exposure === "bonds" && !val.bond_selection) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bond_selection"],
        message: "bond_selection is required when target_exposure is 'bonds'",
      });
    }
  });

export type OpenPositionRequirements = z.infer<typeof OpenPositionRequirements>;

export const ClosePositionRequirements = z.object({
  position_id: z.string().min(1),
});

export type ClosePositionRequirements = z.infer<typeof ClosePositionRequirements>;

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; reason: string };

export function parseRequirements<T>(schema: z.ZodType<T>, requirementsJson: string): ValidationResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(requirementsJson);
  } catch {
    return { ok: false, reason: "requirements is not valid JSON" };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const reason = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, reason };
  }
  return { ok: true, data: result.data };
}

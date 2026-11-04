import { describe, expect, it } from "vitest";
import { JOB_PATCH_COLUMNS, buildJobPatchSql } from "./job-patch";

/**
 * The patch allowlist, tested as a contract.
 *
 * The dangerous half of this feature is not what it writes — it is what it
 * must REFUSE to write. `contract_cents` is a cached SUM guarded by a trigger
 * (migration 0043); letting a PATCH touch it re-creates the data-loss bug that
 * migration exists to prevent. So the forbidden set gets a test of its own,
 * asserted by ABSENCE, the same way the crew profit view is.
 */

describe("the job patch allowlist", () => {
  it("⛔ never exposes a column that belongs to another mechanism", () => {
    const forbidden = [
      "contract_cents", // 0043 tie-out trigger: estimate approval + change orders own it
      "status",         // has its own route and transition rules
      "job_no",         // identity — the number the crew says out loud
      "customer_id",    // retargeting a job is a different act
      "tenant_id",      // never, under any circumstances
      "id",
    ];
    const written = Object.values(JOB_PATCH_COLUMNS);
    for (const col of forbidden) expect(written).not.toContain(col);
  });

  it("covers the three columns that previously had no writer at all", () => {
    const written = Object.values(JOB_PATCH_COLUMNS);
    expect(written).toContain("adjuster_name");
    expect(written).toContain("adjuster_phone");
    expect(written).toContain("deductible_cents");
    // and the two halves of the depreciation nudge
    expect(written).toContain("rcv_cents");
    expect(written).toContain("depreciation_invoiced");
  });
});

describe("buildJobPatchSql", () => {
  it("touches ONLY the keys that were provided", () => {
    const { sets, values } = buildJobPatchSql({ rcvCents: 812_500 });
    expect(sets).toEqual(["rcv_cents = $2"]);
    expect(values).toEqual([812_500]);
  });

  it("keeps parameter numbering aligned with value order across several keys", () => {
    // A mismatch here would write the right values into the wrong columns —
    // the kind of bug that looks fine until somebody's carrier becomes a phone
    // number. Assert the pairing, not just the count.
    const { sets, values } = buildJobPatchSql({
      claimNumber: "CLM-4471",
      adjusterName: "Dana Reyes",
      rcvCents: 1_240_000,
    });
    expect(sets).toEqual([
      "claim_number = $2",
      "adjuster_name = $3",
      "rcv_cents = $4",
    ]);
    expect(values).toEqual(["CLM-4471", "Dana Reyes", 1_240_000]);
  });

  it("⛔ distinguishes ABSENT from explicitly NULL", () => {
    // The whole reason this is a dynamic SET and not a COALESCE update:
    // clearing a wrong claim number is a real edit, and COALESCE cannot say it.
    const cleared = buildJobPatchSql({ claimNumber: null });
    expect(cleared.sets).toEqual(["claim_number = $2"]);
    expect(cleared.values).toEqual([null]);

    const absent = buildJobPatchSql({ claimNumber: undefined, carrier: "State Farm" });
    expect(absent.sets).toEqual(["carrier = $2"]);
    expect(absent.values).toEqual(["State Farm"]);
  });

  it("false is a value, not an absence", () => {
    // depreciationInvoiced: false must be writable — it is how a nudge that
    // fired wrongly gets put back. A truthiness check would swallow it.
    const { sets, values } = buildJobPatchSql({ depreciationInvoiced: false });
    expect(sets).toEqual(["depreciation_invoiced = $2"]);
    expect(values).toEqual([false]);
  });

  it("zero is a value too", () => {
    const { sets, values } = buildJobPatchSql({ budgetCents: 0 });
    expect(sets).toEqual(["budget_cents = $2"]);
    expect(values).toEqual([0]);
  });

  it("trims strings and treats whitespace-only as clearing the field", () => {
    const { values } = buildJobPatchSql({ carrier: "  Allstate  " });
    expect(values).toEqual(["Allstate"]);
    expect(buildJobPatchSql({ carrier: "   " }).values).toEqual([null]);
  });

  it("ignores a key that is not on the allowlist rather than injecting it", () => {
    // Defence in depth: the route's .strict() zod already 400s an unknown key.
    // If that ever regresses, this layer must still refuse to write it.
    const { sets } = buildJobPatchSql({
      rcvCents: 1,
      contractCents: 999_999,
    } as never);
    expect(sets).toEqual(["rcv_cents = $2"]);
  });

  it("an empty patch produces nothing to run", () => {
    expect(buildJobPatchSql({}).sets).toEqual([]);
  });
});

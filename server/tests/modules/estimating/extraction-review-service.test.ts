import { describe, expect, it, vi } from "vitest";
import {
  approveEstimateExtraction,
  rejectEstimateExtraction,
  updateEstimateExtraction,
} from "../../../src/modules/estimating/extraction-review-service.js";

describe("extraction-review-service", () => {
  /** The literal text of a drizzle `sql` expression. Its query chunks interleave string fragments with
   *  column references, and the column objects are circular (table -> column -> table), so the whole
   *  thing cannot simply be stringified. */
  function sqlTextOf(expression: any): string {
    return (expression?.queryChunks ?? [])
      .flatMap((chunk: any) => (chunk && typeof chunk === "object" && "value" in chunk ? chunk.value : []))
      .join(" ");
  }

  function editHarness(existing: Record<string, unknown>) {
    const selectLimit = vi.fn().mockResolvedValue([existing]);
    const updateSetCalls: any[] = [];
    const updateSet = vi.fn((values: any) => {
      updateSetCalls.push(values);
      return {
        where: vi.fn(() => ({
          // A CONCRETE status, because the event asserts what the row BECAME. Returning only an id let
          // the afterJson assertion pass on presence alone, which would survive the CASE resolving to
          // the wrong value.
          returning: vi.fn().mockResolvedValue([{ id: existing.id, status: "pending" }]),
        })),
      };
    });
    const eventValues: any[] = [];
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: selectLimit })),
            // The stale-decision sweep reads `.where(...).for("update")` with NO limit, where the
            // extraction load goes through `.limit(1).for("update")`. Two distinct shapes off one
            // builder, so this cannot hand the sweep the extraction row by accident.
            //
            // Empty on purpose. What the sweep does once it finds something is asserted against a real
            // database in extraction-review-quantity-correction.runtime.test.ts — a mock can say which
            // statement was sent but not whether it selects the right rows, which is the entire question.
            for: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
      update: vi.fn(() => ({ set: updateSet })),
      insert: vi.fn(() => ({
        values: vi.fn((values: any) => {
          eventValues.push(values);
          return { returning: vi.fn().mockResolvedValue([{ id: "evt", eventType: "edited" }]) };
        }),
      })),
    } as any;
    return { tenantDb, updateSetCalls, eventValues };
  }

  it("REQUEUES a needs_quantity row once the missing quantity is supplied", async () => {
    // THE TRAP THIS CLOSES. The generation job flags a quantity-less row `needs_quantity` and skips
    // pricing it. The candidate query then re-selects non-measurement rows ONLY at `status = 'pending'`,
    // so without this the estimator does exactly what the flag asks, the row keeps the flag, and it is
    // never priced again — silently, and permanently. Worse than the mispricing the flag replaced,
    // because that at least produced a number somebody could argue with.
    const { tenantDb, updateSetCalls, eventValues } = editHarness({
      id: "ext-nq",
      status: "needs_quantity",
      normalizedLabel: "Paint one wall",
      quantity: null,
      unit: null,
      divisionHint: null,
      rawLabel: "Paint one wall",
      metadataJson: {},
    });

    await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-nq",
      userId: "user-1",
      input: { quantity: "120.000", unit: "SF" },
    });

    // The status is now a SQL CASE evaluated under the update's own row lock, not a literal decided
    // from the snapshot read beforehand — so what this asserts is that a reset is ATTEMPTED, and that
    // the expression it sends is the intended one. The lock semantics themselves are a property of
    // Postgres and cannot be proven against a mock.
    expect(updateSetCalls[0].status).toBeDefined();
    const sqlText = sqlTextOf(updateSetCalls[0].status);
    expect(sqlText).toContain("needs_quantity");
    expect(sqlText).toContain("pending");

    // THE TRANSITION IS IN THE AUDIT TRAIL. Approve and reject record their status changes; an edit
    // that silently requeues a row would leave the history unable to explain why it started being
    // priced again. `after` is read off the UPDATED row because the reset is a SQL CASE resolved under
    // the row lock — the database is the only thing that knows what it became.
    expect(eventValues[0].beforeJson.status).toBe("needs_quantity");
    expect(eventValues[0].afterJson.status).toBe("pending");
  });

  it("does NOT requeue a processed row for an edit that never touched the quantity", async () => {
    // `nextQuantity` falls back to the stored value when the field is omitted, so on a priced row
    // `suppliesQuantity` is true for EVERY edit. Without an actual-change test the legacy requeue fired
    // on a label, unit or division edit — sending the row back to `pending` and buying a whole
    // generation run for a change that did not touch pricing.
    const { tenantDb, updateSetCalls } = editHarness({
      id: "ext-labelled",
      status: "processed",
      normalizedLabel: "Install laminate",
      quantity: "700.000",
      unit: "SF",
      divisionHint: "09",
      rawLabel: "Install laminate",
      metadataJson: {},
    });

    await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-labelled",
      userId: "user-1",
      input: { normalizedLabel: "Install laminate flooring" },
    });

    expect(updateSetCalls[0].status).toBeUndefined();
  });

  it("treats a re-sent identical quantity as no change", async () => {
    // A full-form save resubmits every field. "700" against a stored "700.000" is the same quantity,
    // and re-pricing on it would be a run bought by a no-op.
    const { tenantDb, updateSetCalls } = editHarness({
      id: "ext-same",
      status: "processed",
      normalizedLabel: "Install laminate",
      quantity: "700.000",
      unit: "SF",
      divisionHint: null,
      rawLabel: "Install laminate",
      metadataJson: {},
    });

    await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-same",
      userId: "user-1",
      input: { quantity: "700" },
    });

    expect(updateSetCalls[0].status).toBeUndefined();
  });

  it("DOES requeue a processed row when the quantity genuinely changes", async () => {
    const { tenantDb, updateSetCalls } = editHarness({
      id: "ext-moved",
      status: "processed",
      normalizedLabel: "Install laminate",
      quantity: "700.000",
      unit: "SF",
      divisionHint: null,
      rawLabel: "Install laminate",
      metadataJson: {},
    });

    await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-moved",
      userId: "user-1",
      input: { quantity: "500" },
    });

    expect(sqlTextOf(updateSetCalls[0].status)).toContain("pending");
  });

  it("flags a PROCESSED row when its quantity becomes zero, not only when it is cleared", async () => {
    // The worst surviving version of the original bug. Changing 700 to "0" satisfied neither branch, so
    // the status went untouched: the row kept `processed`, the worker only reselects ordinary rows at
    // `pending`, and the promote predicate now rejects its stale recommendation. Stranded, unpriceable,
    // and absent from the very bucket that exists to surface it.
    for (const unpriceable of ["0", "-5", "NaN"]) {
      const { tenantDb, updateSetCalls } = editHarness({
        id: "ext-processed",
        status: "processed",
        normalizedLabel: "Install laminate",
        quantity: "700.000",
        unit: "SF",
        divisionHint: null,
        rawLabel: "Install laminate",
        metadataJson: {},
      });

      await updateEstimateExtraction({
        tenantDb,
        dealId: "deal-1",
        extractionId: "ext-processed",
        userId: "user-1",
        input: { quantity: unpriceable },
      });

      expect(sqlTextOf(updateSetCalls[0].status)).toContain("needs_quantity");
    }
  });

  it("does NOT reopen an APPROVED row when its quantity is cleared", async () => {
    // Clearing a quantity is a reason to stop pricing a row, never a reason to silently undo somebody's
    // review. The harm this branch was added for — a stale price reaching a client estimate — is held
    // off by the quantity predicate on the promote query, so reopening the row buys nothing and costs a
    // human decision.
    const { tenantDb, updateSetCalls } = editHarness({
      id: "ext-approved",
      status: "approved",
      normalizedLabel: "Install laminate",
      quantity: "700.000",
      unit: "SF",
      divisionHint: null,
      rawLabel: "Install laminate",
      metadataJson: {},
    });

    await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-approved",
      userId: "user-1",
      input: { quantity: null },
    });

    // The CASE is sent, but it holds `approved` — the transition is restricted to claimable states.
    const sqlText = sqlTextOf(updateSetCalls[0].status);
    expect(sqlText).toContain("needs_quantity");
    expect(sqlText).toContain("in (");
    expect(sqlText).toContain("else");
  });

  it("does NOT reopen a row whose quantity was ALREADY null", async () => {
    // A full-form edit resubmits every field, so `"quantity" in input` fires on a row nobody changed.
    // Without an actual positive-to-null transition that would reopen rows on every save.
    const { tenantDb, updateSetCalls } = editHarness({
      id: "ext-blank",
      status: "unmatched",
      normalizedLabel: "Paint one wall",
      quantity: null,
      unit: null,
      divisionHint: null,
      rawLabel: "Paint one wall",
      metadataJson: {},
    });

    await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-blank",
      userId: "user-1",
      input: { quantity: null, unit: "SF" },
    });

    expect(updateSetCalls[0].status).toBeUndefined();
  });

  it("REFUSES zero as a correction — it is unpriceable, not a number", async () => {
    // `applyMarketRateAdjustment` already treats a quantity at or below zero as invalid, but the worker
    // still persists the zero-valued recommendation and marks the row `processed`. Accepting "0" would
    // therefore stop the row asking for attention without ever giving it a number anybody can bid.
    const { tenantDb, updateSetCalls } = editHarness({
      id: "ext-zero",
      status: "needs_quantity",
      normalizedLabel: "Paint one wall",
      quantity: null,
      unit: null,
      divisionHint: null,
      rawLabel: "Paint one wall",
      metadataJson: {},
    });

    await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-zero",
      userId: "user-1",
      input: { quantity: "0" },
    });

    expect(updateSetCalls[0].status).toBeUndefined();
  });

  it("sends a PRICED row back to needs_quantity when its quantity is cleared", async () => {
    // The other direction, and the one that leaves a live number with nothing behind it. Without this
    // the row keeps `processed`, the worker admits ordinary rows only at `pending`, and the
    // recommendation computed from the OLD quantity stays visible and priceable while the quantity it
    // came from is gone — with nothing anywhere asking a human to look.
    const { tenantDb, updateSetCalls } = editHarness({
      id: "ext-priced",
      status: "processed",
      normalizedLabel: "Install laminate",
      quantity: "700.000",
      unit: "SF",
      divisionHint: null,
      rawLabel: "Install laminate",
      metadataJson: {},
    });

    await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-priced",
      userId: "user-1",
      input: { quantity: null },
    });

    expect(sqlTextOf(updateSetCalls[0].status)).toContain("needs_quantity");
  });

  it("does NOT requeue while the quantity is still missing", async () => {
    // Clearing the flag with no number sends the row straight back to be flagged on the next run — a
    // loop, not a fix.
    const { tenantDb, updateSetCalls } = editHarness({
      id: "ext-nq2",
      status: "needs_quantity",
      normalizedLabel: "Paint one wall",
      quantity: null,
      unit: null,
      divisionHint: null,
      rawLabel: "Paint one wall",
      metadataJson: {},
    });

    await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-nq2",
      userId: "user-1",
      input: { unit: "SF" },
    });

    // No quantity supplied ⇒ status is not touched at all, so there is nothing to race over.
    expect(updateSetCalls[0].status).toBeUndefined();
  });

  it("leaves any OTHER status alone when a quantity is edited", async () => {
    // `approved`, `unmatched` and `overridden` are somebody else's state machine; an edit here has no
    // business rewriting them.
    const { tenantDb, updateSetCalls } = editHarness({
      id: "ext-app",
      status: "approved",
      normalizedLabel: "Roofing tearoff",
      quantity: "1.000",
      unit: "ea",
      divisionHint: "05",
      rawLabel: "Roofing tearoff",
      metadataJson: {},
    });

    await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-app",
      userId: "user-1",
      input: { quantity: "9.000" },
    });

    // The expression IS sent — it has to be, since only the database can decide safely — but it is a
    // no-op for any status other than `needs_quantity`: the CASE writes the column back to itself.
    // `approved`, `unmatched` and `overridden` are somebody else's state machine.
    const sqlText = sqlTextOf(updateSetCalls[0].status);
    expect(sqlText).toContain("else");
  });

  it("marks an extraction approved and writes a review event", async () => {
    const existingRow = {
      id: "ext-1",
      status: "pending",
      normalizedLabel: "Existing label",
      quantity: "1.000",
      unit: "ea",
      divisionHint: "05",
    };
    const updatedRow = { id: "ext-1", status: "approved" };
    const selectLimit = vi.fn().mockResolvedValue([existingRow]);
    const updateReturning = vi.fn().mockResolvedValue([updatedRow]);
    const insertValues = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "evt-1", eventType: "approved" }]) });
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: selectLimit })),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: updateReturning,
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: insertValues,
      })),
    } as any;

    const result = await approveEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-1",
      userId: "user-1",
    });

    expect(result.extraction).toEqual(updatedRow);
    expect(result.reviewEvent.eventType).toBe("approved");
    expect(tenantDb.select).toHaveBeenCalledOnce();
    expect(tenantDb.update).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith({
      dealId: "deal-1",
      subjectType: "estimate_extraction",
      subjectId: "ext-1",
      eventType: "approved",
      userId: "user-1",
      beforeJson: {
        status: "pending",
        normalizedLabel: "Existing label",
        quantity: "1.000",
        unit: "ea",
        divisionHint: "05",
      },
      afterJson: {
        status: "approved",
        normalizedLabel: undefined,
        quantity: undefined,
        unit: undefined,
        divisionHint: undefined,
      },
      reason: null,
    });
  });

  it("rejects an extraction with an optional reason", async () => {
    const existingRow = {
      id: "ext-2",
      status: "approved",
      normalizedLabel: "Existing label",
      quantity: "3.000",
      unit: "ft",
      divisionHint: "07",
    };
    const updatedRow = { id: "ext-2", status: "rejected" };
    const selectLimit = vi.fn().mockResolvedValue([existingRow]);
    const updateReturning = vi.fn().mockResolvedValue([updatedRow]);
    const insertValues = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "evt-2", eventType: "rejected" }]) });
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: selectLimit })),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: updateReturning,
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: insertValues,
      })),
    } as any;

    const result = await rejectEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-2",
      userId: "user-1",
      reason: "duplicate scope line",
    });

    expect(result.extraction).toEqual(updatedRow);
    expect(result.reviewEvent.eventType).toBe("rejected");
    expect(tenantDb.select).toHaveBeenCalledOnce();
    expect(tenantDb.update).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith({
      dealId: "deal-1",
      subjectType: "estimate_extraction",
      subjectId: "ext-2",
      eventType: "rejected",
      userId: "user-1",
      beforeJson: {
        status: "approved",
        normalizedLabel: "Existing label",
        quantity: "3.000",
        unit: "ft",
        divisionHint: "07",
      },
      afterJson: {
        status: "rejected",
        normalizedLabel: undefined,
        quantity: undefined,
        unit: undefined,
        divisionHint: undefined,
      },
      reason: "duplicate scope line",
    });
  });

  it("updates an extraction and logs before and after values", async () => {
    const existing = {
      id: "ext-3",
      normalizedLabel: "Old Label",
      quantity: "1.000",
      unit: "ea",
      divisionHint: "05",
      rawLabel: "Roofing tearoff",
      metadataJson: {
        pricingScopeType: "trade",
        pricingScopeKey: "roofing",
        activeArtifact: true,
      },
    };
    const updatedRow = {
      id: "ext-3",
      normalizedLabel: "New Label",
      quantity: "2.000",
      unit: "ft",
      divisionHint: "07",
      metadataJson: {
        activeArtifact: true,
        pricingScopeType: "division",
        pricingScopeKey: "07",
      },
    };
    const selectLimit = vi.fn().mockResolvedValue([existing]);
    const updateReturning = vi.fn().mockResolvedValue([updatedRow]);
    const updateSet = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: updateReturning,
      })),
    }));
    const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-3", eventType: "edited" }]);
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: selectLimit })),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: updateSet,
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: insertReturning,
        })),
      })),
    } as any;

    const result = await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-3",
      userId: "user-1",
      input: {
        normalizedLabel: "New Label",
        quantity: "2.000",
        unit: "ft",
        divisionHint: "07",
      },
    });

    expect(result.extraction).toEqual(updatedRow);
    expect(result.reviewEvent.eventType).toBe("edited");
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedLabel: "New Label",
        quantity: "2.000",
        unit: "ft",
        divisionHint: "07",
        metadataJson: {
          activeArtifact: true,
          pricingScopeType: "division",
          pricingScopeKey: "07",
        },
      })
    );
    expect(insertReturning).toHaveBeenCalledWith();
  });
});

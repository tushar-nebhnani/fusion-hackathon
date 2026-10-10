import { describe, expect, it } from "vitest";
import { createMemoryAdvisorRepository } from "../testing/memory-repository.js";
import { createToolRunner } from "../tools/index.js";
import type { AdvisorAlertEvent, BusinessRecord } from "../types.js";

const NOW = new Date("2026-10-09T06:00:00Z");

const alert = (alertId: string, loanId: string): AdvisorAlertEvent => ({
  alertId,
  cellId: `cell-${alertId}`,
  hazard: "flood",
  severity: "warning",
  windowStart: "2026-10-10T00:00:00+05:30",
  windowEnd: "2026-10-11T00:00:00+05:30",
  loanIds: [loanId],
});

// getAlertContext reads only the loan and the alert from the context
async function runnerFor(alertId: string | null) {
  const { repo } = createMemoryAdvisorRepository();
  await repo.saveAlertEvent(alert("mine", "L-1"));
  await repo.saveAlertEvent(alert("theirs", "L-2"));
  return createToolRunner(
    { repo, evaluator: { evaluate: () => Promise.reject(new Error("not used")) }, messenger: { send: () => Promise.reject(new Error("not used")) } },
    {
      conversationId: "c-1",
      business: { id: "B-1", loans: [] } as unknown as BusinessRecord,
      loan: { loanId: "L-1" } as BusinessRecord["loans"][number],
      loanState: null,
      alertId,
      now: NOW,
    },
    1,
  );
}

describe("getAlertContext", () => {
  it("reads the conversation's own alert, named or not", async () => {
    const runner = await runnerFor("mine");

    const unnamed = await runner.run("getAlertContext", {}, "alert");
    const named = await runner.run("getAlertContext", { alertId: "mine" }, "alert");

    expect(unnamed.output).toMatchObject({ event: { alertId: "mine", cellId: "cell-mine" } });
    expect(named.output).toMatchObject({ event: { alertId: "mine" } });
  });

  it("refuses another alert the model names, so chat cannot read other businesses' alerts", async () => {
    const runner = await runnerFor("mine");

    const result = await runner.run("getAlertContext", { alertId: "theirs" }, "alert");

    expect(result.error).toMatch(/not the alert behind this conversation/);
    expect(result.output).toBeUndefined();
    expect(JSON.stringify(result.forModel)).not.toContain("cell-theirs");
  });

  it("refuses any named alert when the conversation has none", async () => {
    const runner = await runnerFor(null);

    const result = await runner.run("getAlertContext", { alertId: "theirs" }, "alert");

    expect(result.error).toMatch(/not the alert behind this conversation/);
  });
});

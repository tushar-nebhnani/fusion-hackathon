import { z } from "zod";
import { withTimeout } from "../alerts/withTimeout.js";
import type { LatLon } from "../climate/types.js";
import * as store from "./store.js";

// Flow step 6: what the input service asks of the other units after a save.
// It only knows these two interfaces. Nothing is connected to them yet; a
// trigger whose port is missing waits as a pending job until one is.

export interface ClimatePort {
  // The climate entry function; called so the location's cell is cached
  warm(point: LatLon): Promise<unknown>;
}

export interface FinancePort {
  // A loan was authorised: build its first finance profile
  firstProfile(input: { businessId: string; loanId: string }): Promise<unknown>;
  // A new snapshot arrived for a business with a live loan
  recompute(input: { businessId: string; snapshotVersion: number }): Promise<unknown>;
}

export interface InputPorts {
  climate?: ClimatePort;
  finance?: FinancePort;
}

const point = z.object({ lat: z.number(), lon: z.number() });
const loan = z.object({ loan_id: z.string() });
const snapshot = z.object({ snapshot_version: z.number() });

// The call a job stands for, or null while its port is not connected
function callFor(job: store.JobRow, ports: InputPorts): (() => Promise<unknown>) | null {
  const { businessId } = job;
  switch (job.kind) {
    case "climate_warm": {
      const { climate } = ports;
      const payload = point.parse(job.payload);
      return climate ? () => climate.warm(payload) : null;
    }
    case "finance_first_profile": {
      const { finance } = ports;
      const payload = loan.parse(job.payload);
      return finance ? () => finance.firstProfile({ businessId, loanId: payload.loan_id }) : null;
    }
    case "finance_recompute": {
      const { finance } = ports;
      const payload = snapshot.parse(job.payload);
      return finance
        ? () => finance.recompute({ businessId, snapshotVersion: payload.snapshot_version })
        : null;
    }
    default:
      throw new Error(`unknown trigger job kind ${job.kind}`);
  }
}

export interface RunJobsOptions {
  timeoutMs: number;
  logger: Pick<Console, "warn">;
}

// Runs the jobs side by side. A job that fails or times out stays pending
// with its error recorded, to be tried again; it never fails the save that
// queued it.
export async function runJobs(
  db: store.Db,
  jobs: store.JobRow[],
  ports: InputPorts,
  options: RunJobsOptions,
): Promise<void> {
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const call = callFor(job, ports);
        if (!call) return;
        await withTimeout(call(), options.timeoutMs, job.kind);
        await store.finishJob(db, job.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        options.logger.warn(`input: trigger ${job.kind} for ${job.businessId} failed: ${reason}`);
        await store.failJob(db, job.id, reason);
      }
    }),
  );
}

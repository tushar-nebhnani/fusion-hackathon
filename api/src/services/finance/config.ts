import "dotenv/config";
import { z } from "zod";
import type { Hazard } from "../climate/types.js";
import type { Sector } from "../input/schemas/index.js";

// `atLeast` rows are read top down: the first row whose threshold the value
// reaches gives the sub-score. `atMost` rows work the other way round.
export type Banding =
  | { atLeast: readonly (readonly [threshold: number, score: number])[]; otherwise: number }
  | { atMost: readonly (readonly [threshold: number, score: number])[]; otherwise: number };

type InsuranceCover = "flood" | "fire" | "storm" | "crop" | "stock";

// Every tunable number of the finance service (README sections 3 to 5)
export const FINANCE = {
  // Stored with every profile; bump when a formula, weight or band changes
  modelVersion: "finance-1",
  // Requests per minute per client on /finance
  rateLimit: 30,
  timezone: "Asia/Kolkata",

  metrics: {
    // Floor under the monthly burn, so a runway is never divided by zero
    epsilon: 1,
    // Used for a loan request that names no interest rate
    defaultInterestRatePct: 12,
  },

  baseline: {
    // Share of the 0-100 score each sub-score carries. They sum to 1.
    weights: {
      dscr: 0.3,
      runway: 0.2,
      leverage: 0.15,
      volatility: 0.1,
      repayment: 0.15,
      business_age: 0.1,
    },
    bands: {
      dscr: { atLeast: [[2, 100], [1.5, 85], [1.25, 70], [1, 45], [0.75, 20]], otherwise: 0 },
      // Months of cash left while the business is burning it
      runway: { atLeast: [[12, 70], [6, 50], [3, 30], [1, 10]], otherwise: 0 },
      // Months of costs and repayments the cash covers, for a business that
      // is not burning it. Never below the best burning score.
      buffer: { atLeast: [[3, 100], [1, 85]], otherwise: 70 },
      // Total debt as a share of a year's revenue
      leverage: { atMost: [[0.1, 100], [0.25, 85], [0.5, 65], [1, 35], [2, 15]], otherwise: 0 },
      // Coefficient of variation of the monthly revenue
      volatility: { atMost: [[0.1, 100], [0.2, 80], [0.35, 60], [0.5, 35]], otherwise: 10 },
      // Late or missed payments in the last 12 months
      repayment: { atMost: [[0, 100], [1, 75], [2, 50], [4, 25]], otherwise: 0 },
      // Years in operation
      business_age: { atLeast: [[10, 100], [5, 80], [3, 60], [1, 35]], otherwise: 15 },
    } satisfies Record<string, Banding>,
    // A business with no debt has nothing to service
    noDebtDscrScore: 100,
    // Lowest score of each band, best first; anything below is `critical`
    riskBands: [
      ["low_risk", 70],
      ["moderate", 50],
      ["high", 30],
    ],
    // Missed payments up to each count, best first; more than the last is `poor`
    repaymentRatings: [
      ["clean", 0],
      ["minor", 1],
      ["watch", 3],
    ],
  },

  stress: {
    // How long a hazard's revenue shock is assumed to last
    durationMonths: 2,
    // Good weather never rescues a weak business: the most revenue it adds
    favourableCap: 0.1,
    // An effect smaller than this is reported as neutral
    neutralBelow: 0.02,
    breach: { dscrBelow: 1, runwayMonthsBelow: 3 },
    insurance: {
      // Share of the physical loss a matching cover takes off the shock
      coverShare: 0.5,
      // Which hazards each cover answers for. `fire` matches none of them.
      covers: {
        flood: ["river_flood", "flash_flood"],
        storm: ["storm"],
        stock: ["river_flood", "flash_flood", "storm"],
        fire: [],
        crop: ["river_flood", "flash_flood", "heat", "drought", "storm", "cold_wave"],
      } satisfies Record<InsuranceCover, readonly Hazard[]>,
      // Crop cover only pays out to businesses that grow something
      cropSectors: ["agriculture"] satisfies Sector[],
    },
  },

  adjusted: {
    // Points taken off per unit of revenue lost: a 30% loss costs 6 points
    pointsPerShock: 20,
    // Share of the fall in the re-scored sub-scores that is also taken off
    rescoreWeight: 0.6,
    // Hazards rarely strike together: the worst counts in full, the next at
    // this share of it, the one after at this share again
    stackDecay: 0.5,
    // The adjusted score never sits more than this above the baseline
    maxUplift: 3,
  },

  capacity: {
    // Operating cashflow a lender wants for every rupee of EMI
    targetDscr: 1.25,
  },

  ml: {
    timeoutMs: 5_000,
  },
} as const;

export type SubScoreName = keyof typeof FINANCE.baseline.weights;

export interface FinanceEnv {
  scorer: "rules" | "ml";
  mlUrl: string | null;
}

// Read apart from config/env.ts, like the alert and input settings: an
// invalid value here falls back to its default and never stops the API.
const schema = z.object({
  FINANCE_SCORER: z.enum(["rules", "ml"]).catch("rules"),
  FINANCE_ML_URL: z.url().optional().catch(undefined),
});

export function loadFinanceEnv(source: NodeJS.ProcessEnv = process.env): FinanceEnv {
  const parsed = schema.parse(source);
  return { scorer: parsed.FINANCE_SCORER, mlUrl: parsed.FINANCE_ML_URL ?? null };
}

import { ConflictError } from "../../errors/app-error.js";
import type { AdvisorMode, Damage, LoanStateName } from "./types.js";

// README §4. Each event names the only states it may leave from.
export const TRANSITIONS = {
  disbursed: { from: ["PRE_LOAN"], to: "ACTIVE" },
  alert: { from: ["ACTIVE", "ALERT"], to: "ALERT" },
  alertEnded: { from: ["ALERT"], to: "ACTIVE" },
  damageReported: { from: ["ACTIVE", "ALERT", "IMPACTED"], to: "IMPACTED" },
  verifiedHit: { from: ["ALERT"], to: "IMPACTED" },
  proposalAccepted: { from: ["IMPACTED"], to: "RECOVERY" },
  recoveryClosed: { from: ["RECOVERY"], to: "ACTIVE" },
} as const satisfies Record<string, { from: readonly LoanStateName[]; to: LoanStateName }>;

export type LoanEvent = keyof typeof TRANSITIONS;

export interface TransitionRecord {
  from: LoanStateName;
  to: LoanStateName;
  event: LoanEvent;
  reason: string;
  at: string;
}

export interface LoanStateRecord {
  loanId: string;
  state: LoanStateName;
  history: TransitionRecord[];
  damage: Damage | null;
  alertId: string | null;
}

export function canTransition(state: LoanStateName, event: LoanEvent): boolean {
  return (TRANSITIONS[event].from as readonly LoanStateName[]).includes(state);
}

// Returns the record after the event; throws 409 when the event is not
// allowed from the current state
export function transition(
  record: LoanStateRecord,
  event: LoanEvent,
  reason: string,
  now: Date,
  patch: Partial<Pick<LoanStateRecord, "damage" | "alertId">> = {},
): LoanStateRecord {
  if (!canTransition(record.state, event)) {
    throw new ConflictError(`Loan ${record.loanId} is ${record.state}; "${event}" is not allowed`, {
      state: record.state,
      event,
      allowedFrom: TRANSITIONS[event].from,
    });
  }
  const to = TRANSITIONS[event].to;
  return {
    ...record,
    ...patch,
    state: to,
    history: [...record.history, { from: record.state, to, event, reason, at: now.toISOString() }],
  };
}

// README §4: the state picks the mode
export function modeFor(state: LoanStateName | null): AdvisorMode {
  switch (state) {
    case "ALERT":
      return "alert";
    case "IMPACTED":
    case "RECOVERY":
      return "recovery";
    default:
      return "preLoan";
  }
}

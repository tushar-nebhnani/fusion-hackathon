import { prisma } from "../../config/db.js";
import { loadAlertsConfig } from "./config.js";
import { createEnqueue } from "./enqueue.js";

// The only function other modules call: `void enqueue(event)`. It resolves
// to true or false within milliseconds and never rejects.
export const enqueue = createEnqueue({ prisma, config: loadAlertsConfig() });

export { createEnqueue, type Enqueue } from "./enqueue.js";
export { HAZARDS, SEVERITIES, type AlertEvent, type Hazard, type Severity } from "./types.js";

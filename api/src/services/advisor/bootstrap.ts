import type { PrismaClient } from "../../generated/prisma/client.js";
import { loadAlertsConfig } from "../alerts/config.js";
import { loadContent } from "../alerts/render.js";
import { createDryRunSender } from "../alerts/senders/dryRun.js";
import { createSmtpSender } from "../alerts/senders/emailSmtp.js";
import type { ClimateService } from "../climate/profile.service.js";
import { loadAdvisorConfig, type AdvisorConfig } from "./config.js";
import { loadDirectory } from "./directory.js";
import { createAdvisor, type Advisor } from "./index.js";
import { createOpenAiLlm } from "./llm/client.js";
import { createOfflineLlm } from "./llm/offline.js";
import { createPrismaAdvisorRepository } from "./repository.js";
import { createContactBook, createMessenger } from "./tools/messaging.js";

export interface AdvisorRuntime {
  advisor: Advisor;
  config: AdvisorConfig;
  // Stops the alert-window sweep
  stop(): void;
}

// Builds the advisor from env, reusing the climate service, the alert
// system's sender (dry run or SMTP, per ALERTS_MODE) and its guidelines
export function createAdvisorFromEnv(deps: {
  prisma: PrismaClient;
  climate: ClimateService;
  logger?: Pick<Console, "log" | "error">;
}): AdvisorRuntime {
  const logger = deps.logger ?? console;
  const config = loadAdvisorConfig();
  const alerts = loadAlertsConfig();
  const content = loadContent();
  const llm =
    config.provider === "openai" && config.apiKey
      ? createOpenAiLlm({ apiKey: config.apiKey, model: config.model })
      : createOfflineLlm();
  const sender = alerts.mode === "live" ? createSmtpSender(alerts.smtp) : createDryRunSender();

  const advisor = createAdvisor({
    repo: createPrismaAdvisorRepository(deps.prisma),
    directory: loadDirectory(config.smesPath),
    climate: deps.climate,
    messenger: createMessenger(sender),
    contacts: createContactBook(deps.prisma),
    llm,
    maxIterations: config.maxIterations,
    ownerSteps: (group, severity) => content.guidelines.hazards[group]?.[severity]?.owner ?? [],
  });
  logger.log(`Advisor: ${llm.version}, messages via ${sender.provider}`);

  // Loans in ALERT go back to ACTIVE once their window ends (README §4)
  const timer = setInterval(() => {
    advisor.sweepAlerts().catch((error: unknown) => {
      logger.error("advisor: alert sweep failed,", error instanceof Error ? error.message : error);
    });
  }, config.sweepSeconds * 1000);
  timer.unref();

  return { advisor, config, stop: () => clearInterval(timer) };
}

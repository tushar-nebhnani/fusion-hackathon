import type { PrismaClient } from "../../generated/prisma/client.js";
import { loadAlertsConfig } from "../alerts/config.js";
import { loadContent } from "../alerts/render.js";
import { createDryRunSender } from "../alerts/senders/dryRun.js";
import { createSmtpSender } from "../alerts/senders/emailSmtp.js";
import { redirected } from "../alerts/senders/Sender.js";
import type { EvaluatorService } from "../evaluator/service.js";
import { loadAdvisorConfig, type AdvisorConfig } from "./config.js";
import { combineDirectories, loadDirectory, type BusinessDirectory } from "./directory.js";
import { createAdvisor, type Advisor } from "./index.js";
import { createOpenAiLlm } from "./llm/client.js";
import { createOfflineLlm } from "./llm/offline.js";
import { createInputDirectory } from "./inputDirectory.js";
import { createMonitorAlertBridge } from "./monitorAlerts.js";
import { createPrismaAdvisorRepository } from "./repository.js";
import { createContactBook, createMessenger } from "./tools/messaging.js";

export interface AdvisorRuntime {
  advisor: Advisor;
  config: AdvisorConfig;
  directory: BusinessDirectory;
  // Whether a business is one of the smes.json demo businesses
  isDemo(businessId: string): Promise<boolean>;
  // Stops the alert-window sweep
  stop(): void;
}

// Builds the advisor from env, reusing the evaluator (its only way to the
// climate unit and the finance service), the input service's tables, the
// alert system's sender (dry run or SMTP, per ALERTS_MODE) and its guidelines
export function createAdvisorFromEnv(deps: {
  prisma: PrismaClient;
  evaluator: Pick<EvaluatorService, "evaluate">;
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
  // The advisor sends on its own, not through the alert worker, so the
  // development redirect has to be applied here as well
  const sender = redirected(
    alerts.mode === "live" ? createSmtpSender(alerts.smtp) : createDryRunSender(),
    alerts.redirectTo,
  );
  if (alerts.redirectTo) logger.log(`Advisor: every email is redirected to ${alerts.redirectTo}`);

  const demo = config.demoBusinesses ? loadDirectory(config.smesPath) : null;
  const directory = demo
    ? combineDirectories(createInputDirectory(deps.prisma), demo)
    : createInputDirectory(deps.prisma);

  const advisor = createAdvisor({
    repo: createPrismaAdvisorRepository(deps.prisma),
    directory,
    evaluator: deps.evaluator,
    messenger: createMessenger(sender),
    contacts: createContactBook(deps.prisma),
    llm,
    maxIterations: config.maxIterations,
    ownerSteps: (group, severity) => content.guidelines.hazards[group]?.[severity]?.owner ?? [],
  });
  logger.log(
    `Advisor: ${llm.version}, messages via ${sender.provider}, ` +
      `businesses from the input service${demo ? " and smes.json" : ""}, ` +
      `monitor alerts ${config.monitorAlerts ? "on" : "off"}`,
  );
  const bridge = config.monitorAlerts
    ? createMonitorAlertBridge({ prisma: deps.prisma, advisor, directory, logger })
    : null;

  // Loans in ALERT go back to ACTIVE once their window ends (README §4), and
  // alerts sent since the last sweep are advised on
  const timer = setInterval(() => {
    advisor.sweepAlerts().catch((error: unknown) => {
      logger.error("advisor: alert sweep failed,", error instanceof Error ? error.message : error);
    });
    bridge?.poll().catch((error: unknown) => {
      logger.error("advisor: monitor alerts failed,", error instanceof Error ? error.message : error);
    });
  }, config.sweepSeconds * 1000);
  timer.unref();

  return {
    advisor,
    config,
    directory,
    isDemo: async (businessId) => (demo ? (await demo.getBusiness(businessId)) !== null : false),
    stop: () => clearInterval(timer),
  };
}

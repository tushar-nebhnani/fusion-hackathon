import type { Sender } from "./Sender.js";

// Hides most of an address in logs
export function mask(recipient: string): string {
  return recipient
    .split(",")
    .map((value) => {
      const text = value.trim();
      return text.length <= 4 ? "****" : `${"*".repeat(text.length - 4)}${text.slice(-4)}`;
    })
    .join(", ");
}

// Logs the message instead of calling a provider. Used when ALERTS_MODE is
// dry_run, so a demo never depends on SMTP.
export function createDryRunSender(logger: Pick<Console, "info"> = console): Sender {
  let count = 0;
  return {
    provider: "dry_run",
    send(message) {
      count += 1;
      const subject = message.subject ? ` "${message.subject}"` : "";
      logger.info(`alerts (dry run): to ${mask(message.to)}${subject}\n${message.body}`);
      return Promise.resolve({ providerRef: `dry-run-${count}` });
    },
  };
}

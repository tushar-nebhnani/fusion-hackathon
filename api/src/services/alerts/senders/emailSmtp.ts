import nodemailer from "nodemailer";
import type { AlertsConfig } from "../config.js";
import type { Sender } from "./Sender.js";

const TIMEOUT_MS = 10_000;

export function createSmtpSender(smtp: AlertsConfig["smtp"]): Sender {
  const from = smtp.from ?? smtp.user;
  const transport =
    smtp.user && smtp.password
      ? nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.port === 465,
          auth: { user: smtp.user, pass: smtp.password },
          connectionTimeout: TIMEOUT_MS,
          greetingTimeout: TIMEOUT_MS,
          socketTimeout: TIMEOUT_MS,
        })
      : undefined;

  return {
    provider: "smtp",
    async send(message) {
      if (!transport || !from) throw new Error("SMTP is not configured");
      const info = await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        ...(message.html ? { html: message.body } : { text: message.body }),
      });
      return { providerRef: info.messageId };
    },
  };
}

export interface OutboundMessage {
  // One or more comma-separated email addresses
  to: string;
  subject: string;
  body: string;
  html: boolean;
}

export interface SendResult {
  // Message id from the provider
  providerRef?: string;
}

// A sender rejects when the message could not be handed to the provider.
// The worker catches that; a sender never needs its own retry.
export interface Sender {
  // Stored with every delivery: smtp | dry_run
  readonly provider: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

// ALERTS_REDIRECT_TO: every message goes to one address instead of its
// contacts. Whether a message goes out is still decided before it gets here.
export function redirected(sender: Sender, to: string | undefined): Sender {
  if (!to) return sender;
  return { provider: sender.provider, send: (message) => sender.send({ ...message, to }) };
}

import { SAMPLES } from "./samples";

// The one way these pages reach the API. Every call ends as one result object
// and never throws. In example mode a request is answered from SAMPLES (the
// same synthetic answers as the console's sample mode) and nothing is sent.

export type Source = "live" | "sample";

// Answers are JSON whose shape depends on the route; each view reads what it needs
export type Json = any;

export interface ApiResult {
  method: string;
  path: string;
  ok: boolean;
  status: number;
  data: Json;
  source: Source;
  // No answer at all: the API is down or refused this page's origin
  network?: boolean;
  // Example mode has no stored answer for this request
  notSent?: boolean;
}

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

// The source used when a call does not name one; the session keeps it current
let defaultSource: Source = "live";
export const setDefaultSource = (source: Source) => { defaultSource = source; };

const newKey = () => crypto.randomUUID?.() ?? `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export async function api(method: string, path: string, body?: unknown, options: { source?: Source } = {}): Promise<ApiResult> {
  const source = options.source ?? defaultSource;
  const result: ApiResult = { method, path, ok: false, status: 0, data: null, source };

  if (source === "sample") {
    const hit = SAMPLES.find(([pattern]) => pattern.test(`${method} ${path}`));
    if (!hit) return { ...result, notSent: true };
    const answer = typeof hit[1] === "function" ? (hit[1] as (b: unknown, p: string) => Json)(body ?? {}, path) : hit[1];
    const { sampleStatus: status = 200, sampleNote: _note, ...data } = answer as Json;
    return { ...result, ok: status < 400, status, data };
  }

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // A fresh key per write: the API replays a retry instead of running it twice
  if (method !== "GET") headers["Idempotency-Key"] = newKey();
  try {
    const response = await fetch(API_URL + path, {
      method, headers, credentials: "include", body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: Json = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ...result, ok: response.ok, status: response.status, data };
  } catch {
    return { ...result, network: true };
  }
}

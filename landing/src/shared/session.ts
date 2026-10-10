import { useSyncExternalStore } from "react";
import { api, setDefaultSource, type Source } from "./api";

// Who is using the pages and where their answers come from. Kept outside React
// so any page or helper can read it; components subscribe with useSession().

export interface User {
  id: string;
  email: string;
  name?: string | null;
  role: "owner" | "bank";
}

export interface Session {
  source: Source;
  user: User | null;
  // null until the first check of the API has come back
  reachable: boolean | null;
}

let session: Session = { source: "live", user: null, reachable: null };
const listeners = new Set<() => void>();

function update(patch: Partial<Session>) {
  session = { ...session, ...patch };
  setDefaultSource(session.source);
  for (const listener of listeners) listener();
}

export function useSession(): Session {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => session,
  );
}

export const getSession = () => session;

// Example data answers as a bank officer would see it, so every step is open there
export const isBank = (s: Session) => s.source === "sample" || s.user?.role === "bank";
export const needsSignin = (s: Session) => s.source === "live" && !s.user;

export async function loadAccount() {
  if (session.source === "sample") { update({ user: null }); return; }
  const me = await api("GET", "/auth/me", undefined, { source: "live" });
  update({ user: me.ok ? (me.data?.user ?? me.data) : null });
}

// Checks the API once; when it does not answer, the pages fall back to example data
let started: Promise<void> | null = null;
export function startSession() {
  started ??= (async () => {
    const health = await api("GET", "/health", undefined, { source: "live" });
    const reachable = !health.network;
    update({ reachable, source: reachable ? "live" : "sample" });
    await loadAccount();
  })();
  return started;
}

export async function setSource(source: Source) {
  if (source === "live") {
    const health = await api("GET", "/health", undefined, { source: "live" });
    update({ reachable: !health.network, source: health.network ? "sample" : "live" });
  } else {
    update({ source: "sample" });
  }
  await loadAccount();
}

export async function signInWithGoogle(credential: string) {
  const r = await api("POST", "/auth/google", { credential }, { source: "live" });
  await loadAccount();
  return r.ok;
}

export async function signOut() {
  await api("POST", "/auth/logout", undefined, { source: "live" });
  update({ user: null });
}

export async function googleClientId(): Promise<string | null> {
  const r = await api("GET", "/auth/config", undefined, { source: "live" });
  return r.ok ? r.data?.google_client_id ?? null : null;
}

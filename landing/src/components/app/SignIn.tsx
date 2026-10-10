import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { googleClientId, signInWithGoogle, useSession } from "../../shared/session";
import { Note } from "./ui";

// Google sign-in, in a pop-up any page can open with openSignin(). It closes
// on its own once someone is signed in.

type Gsi = {
  accounts: { id: {
    initialize(options: { client_id: string; callback: (response: { credential: string }) => void }): void;
    renderButton(el: HTMLElement, options: Record<string, unknown>): void;
  } };
};
declare global { interface Window { google?: Gsi } }

let open = false;
const listeners = new Set<() => void>();
const setOpen = (value: boolean) => { open = value; for (const listener of listeners) listener(); };
export const openSignin = () => setOpen(true);
const useOpen = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => open);

let script: Promise<void> | null = null;
function loadGoogle() {
  script ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://accounts.google.com/gsi/client";
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { script = null; reject(new Error("Google sign-in did not load")); };
    document.head.append(el);
  });
  return script;
}

function GoogleButton() {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "failed">("loading");

  useEffect(() => {
    let alive = true;
    (async () => {
      const clientId = await googleClientId();
      try {
        if (!clientId) throw new Error("not configured");
        await loadGoogle();
      } catch {
        if (alive) setState("unavailable");
        return;
      }
      if (!alive || !box.current || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async ({ credential }) => { if (!(await signInWithGoogle(credential)) && alive) setState("failed"); },
      });
      window.google.accounts.id.renderButton(box.current, { theme: "outline", size: "large", shape: "rectangular", width: 320 });
      setState("ready");
    })();
    return () => { alive = false; };
  }, []);

  return (
    <>
      <div ref={box} className="k-gsi" />
      {state === "unavailable" ? <p className="muted">Sign-in isn't available right now. Please try again later.</p> : null}
      {state === "failed" ? <Note err>Sign-in didn't work. Please try again.</Note> : null}
    </>
  );
}

export function SignInDialog() {
  const isOpen = useOpen();
  const { user } = useSession();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => { if (user) setOpen(false); }, [user]);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (isOpen && !el.open) el.showModal();
    if (!isOpen && el.open) el.close();
  }, [isOpen]);

  return (
    <dialog ref={dialog} className="k-dialog" aria-labelledby="signin-title" onClose={() => setOpen(false)}>
      <button className="k-x" type="button" aria-label="Close" onClick={() => setOpen(false)}>×</button>
      <h2 id="signin-title">Sign in to continue</h2>
      <p>Sign in with Google to enter your details. They're saved to your account, so you can come back to your analysis.</p>
      {/* Drawn only while open: Google cannot size a button it cannot see */}
      {isOpen ? <GoogleButton /> : null}
    </dialog>
  );
}

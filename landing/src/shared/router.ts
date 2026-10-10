import { useSyncExternalStore, type MouseEvent } from "react";

// Three pages need no router library: the path picks the page, and links
// inside the app change it with the History API instead of reloading.
// A host serving the built site must send index.html for /playground and
// /analysis too (Vite's dev and preview servers already do).

export type Page = "landing" | "playground" | "analysis";

const pageOf = (path: string): Page => (path.startsWith("/playground") ? "playground" : path.startsWith("/analysis") ? "analysis" : "landing");

export function usePage(): Page {
  return useSyncExternalStore(
    (listener) => { window.addEventListener("popstate", listener); return () => window.removeEventListener("popstate", listener); },
    () => pageOf(window.location.pathname),
  );
}

export function navigate(to: string) {
  if (to === window.location.pathname) return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}

// onClick for an <a href="/page">: same tab, no reload; a modified click still opens a new tab
export function follow(event: MouseEvent<HTMLAnchorElement>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href") ?? "/");
}

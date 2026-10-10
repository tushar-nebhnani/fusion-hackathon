import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The built site may load scripts only from itself and Google sign-in, and
// talk only to the API, OpenStreetMap's geocoder and Google. Build only: the
// dev server injects an inline script for React refresh, which this would block.
function contentSecurityPolicy(apiUrl: string): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: https://tile.openstreetmap.org",
    "media-src 'self'",
    `connect-src 'self' ${apiUrl} https://nominatim.openstreetmap.org https://accounts.google.com/gsi/`,
    "frame-src https://accounts.google.com/gsi/",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" },
    ],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const apiUrl = new URL(env.VITE_API_URL || "http://localhost:4000").origin;
  return {
    plugins: [react(), contentSecurityPolicy(apiUrl)],
    server: { port: 5173 },
  };
});

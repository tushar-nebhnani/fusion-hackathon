import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startSession } from "./shared/session";
import "./styles.css";
import "./app.css";

// Finds out once whether the API answers and who is signed in
void startSession();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

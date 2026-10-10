import { useEffect, useRef } from "react";
import { API_URL, type ApiResult, type Source } from "../../shared/api";

// The Playground's terminal: every request the story makes, printed as it
// happens the way a developer would see it, with the answer under it.

export type TermLine =
  | { kind: "note"; id: string; text: string }
  | { kind: "call"; id: number; method: string; path: string; body?: unknown; source: Source; result?: ApiResult };

const STATUS_TEXT: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
};
// Lines of a response shown before the rest folds away
const PREVIEW = 8;

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function Call({ line }: { line: Extract<TermLine, { kind: "call" }> }) {
  const r = line.result;
  const json = r && r.data !== null && r.data !== undefined ? JSON.stringify(r.data, null, 2).split("\n") : [];
  const tone = !r ? "wait" : r.network || r.notSent ? "bad" : r.ok ? "good" : "bad";
  return (
    <div className="k-term-call">
      <div><span className="k-term-prompt">$</span> curl -X <b>{line.method}</b> <span className="k-term-url">{line.source === "sample" ? "example://kshetra" : API_URL}{line.path}</span></div>
      {line.body !== undefined ? <div className="k-term-body">    -d '{short(JSON.stringify(line.body), 220)}'</div> : null}
      <div className={`k-term-status ${tone}`}>
        {!r ? <>… waiting<span className="k-term-cursor" /></>
          : r.notSent ? "✗ not sent: example data has no answer for this request"
            : r.network ? "✗ no answer from the API"
              : <>← {r.status} {STATUS_TEXT[r.status] ?? ""} · {r.ms} ms{r.source === "sample" ? " · example data" : ""}</>}
      </div>
      {json.length ? (
        <>
          <pre>{json.slice(0, PREVIEW).join("\n")}</pre>
          {json.length > PREVIEW ? <details><summary>+ {json.length - PREVIEW} more lines</summary><pre>{json.slice(PREVIEW).join("\n")}</pre></details> : null}
        </>
      ) : null}
    </div>
  );
}

export function Terminal({ lines, open, onToggle, onClear }: { lines: TermLine[]; open: boolean; onToggle: () => void; onClear: () => void }) {
  const screen = useRef<HTMLDivElement>(null);
  // Follows the newest output, as a terminal does
  useEffect(() => { if (screen.current) screen.current.scrollTop = screen.current.scrollHeight; }, [lines, open]);
  const calls = lines.filter((l) => l.kind === "call").length;
  return (
    <div className={`k-term ${open ? "" : "shut"}`} role="region" aria-label="API calls">
      <header>
        <span className="k-term-dots" aria-hidden="true"><i /><i /><i /></span>
        <b>kshetra — api calls</b>
        <span>{calls} request{calls === 1 ? "" : "s"}</span>
        <button type="button" onClick={onClear}>Clear</button>
        <button type="button" aria-expanded={open} onClick={onToggle}>{open ? "Hide" : "Show"}</button>
      </header>
      <div className="k-term-screen" ref={screen} role="log" aria-live="off" hidden={!open}>
        {lines.length ? lines.map((line) => (line.kind === "note"
          ? <div key={line.id} className="k-term-note"># {line.text}</div>
          : <Call key={line.id} line={line} />))
          : <div className="k-term-note"># Requests appear here as the story plays.</div>}
      </div>
    </div>
  );
}

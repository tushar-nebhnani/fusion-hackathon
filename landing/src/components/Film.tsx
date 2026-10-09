import { useEffect, useRef, useState } from "react";

// Starts on load and loops. Viewers who prefer less motion start on the
// poster and press Play themselves.
export function Film() {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = video.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.play().catch(() => {});
  }, []);

  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  return (
    <figure className="film">
      <div className="film-h"><span><b>Demo</b> · one loan, start to finish</span><span>0:30 · loop</span></div>
      <video
        ref={video}
        src="/kshetra-demo.mp4"
        poster="/poster.jpg"
        muted
        loop
        playsInline
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        aria-label="Thirty-second demo: a Chennai bakery applies for a loan, its location is graded D for climate risk, its score falls from 85 to 68 under flood stress, the monitor alerts the owner before heavy rain, and after damage the bank accepts a three-month moratorium."
      />
      <figcaption className="film-f">
        <span>A synthetic bakery in Chennai, run through the console in sample mode. No real customer data.</span>
        <button type="button" onClick={toggle}>{playing ? "Pause" : "Play"}</button>
      </figcaption>
    </figure>
  );
}

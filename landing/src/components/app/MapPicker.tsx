import L from "leaflet";
import "leaflet/dist/leaflet.css";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import iconUrl from "leaflet/dist/images/marker-icon.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";
import { useEffect, useRef, useState } from "react";

// Where the shop is: an OpenStreetMap map with a draggable pin that fills the
// latitude and longitude inputs (named lat and lon, so the form reads them).
// Nominatim, OpenStreetMap's free geocoder, turns an address into a point and
// a point into an address. Its policy allows about one request a second, so it
// runs only on a button press or a dropped pin, never per key.

// A bundler moves Leaflet's marker images; tell it where they went
L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl });

const NOMINATIM = "https://nominatim.openstreetmap.org";
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const inIndia = (lat: number, lon: number) => lat >= 6 && lat <= 37 && lon >= 68 && lon <= 98;

interface Hit { lat: string; lon: string; display_name: string }

async function geocode<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${NOMINATIM}${path}`, { headers: { "Accept-Language": "en" } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function MapPicker({ onAddress }: { onAddress: (address: string, pincode: string | undefined) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pin = useRef<L.Marker | null>(null);
  const latInput = useRef<HTMLInputElement>(null);
  const lonInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Search for your shop, or click on the map to place it.");
  // The latest onAddress, without restarting the map when it changes
  const addressCallback = useRef(onAddress);
  addressCallback.current = onAddress;

  const place = useRef((lat: number, lon: number, { pan = true, lookup = true } = {}) => {
    const m = map.current;
    if (!m) return;
    lat = round4(lat);
    lon = round4(lon);
    if (latInput.current) latInput.current.value = String(lat);
    if (lonInput.current) lonInput.current.value = String(lon);
    if (pin.current) pin.current.setLatLng([lat, lon]);
    else {
      pin.current = L.marker([lat, lon], { draggable: true }).addTo(m);
      pin.current.on("dragend", () => { const p = pin.current!.getLatLng(); place.current(p.lat, p.lng, { pan: false }); });
    }
    if (pan) m.setView([lat, lon], Math.max(m.getZoom(), 15));
    if (!inIndia(lat, lon)) { setStatus("That's outside India. We only cover places in India."); return; }
    setStatus("Drag the pin if it isn't exactly on your shop.");
    if (lookup) {
      void geocode<{ display_name?: string; address?: { postcode?: string } }>(`/reverse?format=jsonv2&lat=${lat}&lon=${lon}`).then((d) => {
        if (d?.display_name) addressCallback.current(d.display_name.slice(0, 250), d.address?.postcode?.replace(/\s/g, ""));
      });
    }
  });

  useEffect(() => {
    if (!box.current || map.current) return;
    const m = L.map(box.current, { maxBounds: [[2, 60], [40, 104]], minZoom: 4 }).setView([22.5, 79], 5);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => place.current(e.latlng.lat, e.latlng.lng, { pan: false }));
    map.current = m;
    // Drawn inside a closed panel the map has no size; redraw once it gets one
    const resized = new ResizeObserver(() => m.invalidateSize());
    resized.observe(box.current);
    return () => { resized.disconnect(); m.remove(); map.current = null; pin.current = null; };
  }, []);

  async function search() {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setStatus("Searching…");
    const list = await geocode<Hit[]>(`/search?format=jsonv2&countrycodes=in&limit=5&q=${encodeURIComponent(q)}`);
    setBusy(false);
    setHits([]);
    if (!list) { setStatus("Search isn't available right now. Click on the map instead."); return; }
    if (!list.length) { setStatus("Nothing found. Try a nearby landmark or area, or click on the map."); return; }
    if (list.length === 1) { place.current(Number(list[0]!.lat), Number(list[0]!.lon)); return; }
    setStatus("Pick the right place:");
    setHits(list);
  }

  function here() {
    if (!navigator.geolocation) { setStatus("Your browser can't share its location. Search or click on the map instead."); return; }
    setStatus("Finding you…");
    navigator.geolocation.getCurrentPosition((p) => place.current(p.coords.latitude, p.coords.longitude),
      () => setStatus("We couldn't get your location. Search or click on the map instead."), { timeout: 10000 });
  }

  // Typed coordinates move the pin
  const typed = () => {
    const lat = Number(latInput.current?.value), lon = Number(lonInput.current?.value);
    if (latInput.current?.value && lonInput.current?.value) place.current(lat, lon, { lookup: false });
  };

  return (
    <div className="k-map-picker wide">
      <div className="k-map-search">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your shop's address, area or a landmark" aria-label="Search for a place"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} />
        <button className="btn sm" type="button" disabled={busy} onClick={() => void search()}>Search</button>
        <button className="btn sm ghost" type="button" onClick={here}>Use my location</button>
      </div>
      {hits.length ? (
        <div className="k-map-hits">
          {hits.map((x, i) => <button key={i} type="button" onClick={() => { setHits([]); place.current(Number(x.lat), Number(x.lon)); }}>{x.display_name}</button>)}
        </div>
      ) : null}
      <div ref={box} className="k-map" aria-label="Map. Click to place your shop." />
      <p className="muted small">{status}</p>
      <div className="k-fields">
        <label className="k-field"><span>Latitude<em>set by the pin</em></span><input ref={latInput} name="lat" type="number" step="any" onChange={typed} /></label>
        <label className="k-field"><span>Longitude<em>set by the pin</em></span><input ref={lonInput} name="lon" type="number" step="any" onChange={typed} /></label>
      </div>
    </div>
  );
}

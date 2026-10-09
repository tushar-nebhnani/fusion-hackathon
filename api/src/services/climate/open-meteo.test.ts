import { describe, expect, it, vi } from "vitest";
import { createOpenMeteoClient, parsePayload, UpstreamError } from "./open-meteo.js";

const point = { lat: 26.1, lon: 91.7 };
const ok = { daily: { time: ["2026-10-09"], precipitation_sum: [1.5] } };

function setup(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
  }
  const sleep = vi.fn(() => Promise.resolve());
  const client = createOpenMeteoClient({ fetch: fetchMock, sleep });
  const urlOf = (call: number) => {
    const input = fetchMock.mock.calls[call]?.[0];
    if (!(input instanceof URL)) throw new Error(`no request #${call}`);
    return input;
  };
  return { client, fetchMock, sleep, urlOf };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("Open-Meteo client", () => {
  it("requests the archive with latitude first, IST and ERA5-Seamless", async () => {
    const { client, urlOf } = setup(json(ok));

    await client.archive(point, "1995-01-01", "2026-10-03");

    const url = urlOf(0);
    expect(url.origin + url.pathname).toBe("https://archive-api.open-meteo.com/v1/archive");
    expect([...url.searchParams.keys()].slice(0, 2)).toEqual(["latitude", "longitude"]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      latitude: "26.1",
      longitude: "91.7",
      start_date: "1995-01-01",
      end_date: "2026-10-03",
      timezone: "Asia/Kolkata",
      models: "era5_seamless",
    });
    expect(url.searchParams.get("daily")).toContain("wind_gusts_10m_max");
  });

  it("asks the forecast for 7 days ahead and 5 back, with hourly only when needed", async () => {
    const { client, urlOf } = setup(json(ok), json(ok));

    await client.forecast(point, ["precipitation_sum", "temperature_2m_max"], []);
    await client.forecast(point, ["precipitation_sum"], ["soil_moisture_9_to_27cm"]);

    expect(Object.fromEntries(urlOf(0).searchParams)).toMatchObject({
      forecast_days: "7",
      past_days: "5",
      timezone: "Asia/Kolkata",
      daily: "precipitation_sum,temperature_2m_max",
    });
    expect(urlOf(0).searchParams.has("hourly")).toBe(false);
    expect(urlOf(1).searchParams.get("hourly")).toBe("soil_moisture_9_to_27cm");
  });

  it("batches elevation points into one request", async () => {
    const { client, fetchMock, urlOf } = setup(json({ elevation: [101, 49] }));

    const result = await client.elevation([point, { lat: 26.11, lon: 91.71 }]);

    expect(result).toEqual([101, 49]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(urlOf(0).searchParams.get("latitude")).toBe("26.1,26.11");
    expect(urlOf(0).searchParams.get("longitude")).toBe("91.7,91.71");
  });

  it("retries rate limits and server errors with backoff", async () => {
    const { client, fetchMock, sleep } = setup(json({}, 429), json({}, 503), json(ok));

    const result = await client.floodForecast(point);

    expect(result.daily?.values.precipitation_sum).toEqual([1.5]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
    expect(client.status().state).toBe("up");
  });

  it("retries network failures and gives up after three tries", async () => {
    const { client, fetchMock } = setup(
      new Error("socket hang up"),
      new Error("timeout"),
      new Error("timeout"),
    );

    await expect(client.forecast(point, ["precipitation_sum"], [])).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client.status().state).toBe("down");
  });

  it("does not retry a 400 from Open-Meteo", async () => {
    const { client, fetchMock, sleep } = setup(json({ error: true, reason: "bad" }, 400));

    await expect(client.climate(point, "1995-01-01", "2045-12-31")).rejects.toMatchObject({
      name: "UpstreamError",
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not leak upstream response bodies in its errors", async () => {
    const { client } = setup(json({ reason: "secret-internal-detail" }, 400));

    const error: unknown = await client.forecast(point, ["x"], []).catch((e: unknown) => e);

    expect(String(error)).not.toContain("secret-internal-detail");
  });

  it("starts with an unknown upstream status", () => {
    expect(setup().client.status()).toEqual({ state: "unknown", checked_at: null });
  });

  it("rejects an elevation reply with the wrong number of points", async () => {
    const { client } = setup(json({ elevation: [101] }));
    await expect(client.elevation([point, point])).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("parsePayload", () => {
  it("turns a daily block into aligned series", () => {
    const result = parsePayload("forecast", {
      latitude: 26.1,
      daily: { time: ["2026-10-09", "2026-10-10"], precipitation_sum: [1, null] },
    });
    expect(result.daily).toEqual({
      time: ["2026-10-09", "2026-10-10"],
      values: { precipitation_sum: [1, null] },
    });
    expect(result.hourly).toBeNull();
    expect(result.payload).toHaveProperty("latitude", 26.1);
  });

  it("accepts the scalar elevation that real weather responses carry", () => {
    const result = parsePayload("flood_history", {
      latitude: 26.175,
      elevation: 163.0,
      daily_units: { time: "iso8601", river_discharge: "m³/s" },
      daily: { time: ["1995-01-01"], river_discharge: [3.45] },
    });
    expect(result.daily?.values.river_discharge).toEqual([3.45]);
  });

  it.each([
    ["not an object", "<html>rate limited</html>"],
    ["series longer than the time axis", { daily: { time: ["2026-10-09"], x: [1, 2] } }],
    ["text where numbers belong", { daily: { time: ["2026-10-09"], x: ["DROP TABLE"] } }],
    ["missing time axis", { daily: { x: [1] } }],
    ["numeric time axis", { daily: { time: [1], x: [1] } }],
    ["nested objects as values", { daily: { time: ["2026-10-09"], x: [{ a: 1 }] } }],
  ])("rejects a tampered payload: %s", (_name, payload) => {
    expect(() => parsePayload("forecast", payload)).toThrow(UpstreamError);
  });
});

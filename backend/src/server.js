import { setDefaultResultOrder } from "node:dns";
import { readFile } from "node:fs/promises";
import { setDefaultAutoSelectFamily } from "node:net";

import { createAmapProvider } from "./amap-provider.js";
import { createAmapPlacesProvider } from "./amap-places.js";
import { createAmapCitiesProvider } from "./amap-cities.js";
import { createFixtureNavigationProvider } from "./fixture-catalog.js";
import { createAutoProvider, createGoogleProvider } from "./google-provider.js";
import { createMapTileProvider } from "./map-tiles.js";
import { createGateway } from "./gateway.js";

// restapi.amap.com publishes AAAA records, and an overseas VPS often has no
// IPv6 route and over 250 ms of RTT to AMap. Node's happy-eyeballs then aborts
// the IPv4 attempt after 250 ms, IPv6 fails at once, and every AMap fetch ends
// in ETIMEDOUT. Plain IPv4-first connects let each request use its own deadline.
setDefaultAutoSelectFamily(false);
setDefaultResultOrder("ipv4first");

function createDisabledProvider() {
  const unavailable = () => {
    const error = new Error("Live navigation provider is not configured");
    error.code = "SERVER_MISCONFIGURED";
    error.retryable = false;
    throw error;
  };
  return {
    async planRoute() {
      unavailable();
    },
    async planRouteOptions() {
      unavailable();
    },
    async searchPlaces() {
      unavailable();
    },
  };
}

function buildAmapSuite(env) {
  const key = env.AMAP_WEB_SERVICE_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    return null;
  }
  return {
    ...createAmapProvider({
      key,
      enableMotorcycleApi: env.AMAP_ENABLE_MOTORCYCLE_API === "true",
      motorcyclePlate: env.AMAP_DEFAULT_PLATE ?? "",
      motorcycleType: env.AMAP_MOTORCYCLE_TYPE ?? "",
    }),
    ...createAmapPlacesProvider({ key }),
    ...createAmapCitiesProvider({ key }),
  };
}

function buildGoogleSuite(env) {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    return null;
  }
  return createGoogleProvider({
    key,
    travelMode: env.GOOGLE_TRAVEL_MODE ?? "TWO_WHEELER",
    trafficAware: env.GOOGLE_TRAFFIC_AWARE !== "false",
  });
}

async function main() {
  const providerMode = process.env.MOTO_PROVIDER ?? "fixture";
  let provider;
  let routeTrafficEnabled;

  if (providerMode === "amap") {
    provider = buildAmapSuite(process.env);
    if (!provider) {
      throw new Error("AMAP_WEB_SERVICE_KEY is required when MOTO_PROVIDER=amap");
    }
    routeTrafficEnabled = true;
  } else if (providerMode === "google") {
    provider = buildGoogleSuite(process.env);
    if (!provider) {
      throw new Error("GOOGLE_MAPS_API_KEY is required when MOTO_PROVIDER=google");
    }
    routeTrafficEnabled = process.env.GOOGLE_TRAFFIC_REFRESH_ENABLED === "true";
  } else if (providerMode === "auto") {
    const amap = buildAmapSuite(process.env);
    const google = buildGoogleSuite(process.env);
    if (!amap && !google) {
      throw new Error(
        "At least one of AMAP_WEB_SERVICE_KEY or GOOGLE_MAPS_API_KEY is required when MOTO_PROVIDER=auto",
      );
    }
    provider = createAutoProvider({ amap, google });
    routeTrafficEnabled = Boolean(amap) || process.env.GOOGLE_TRAFFIC_REFRESH_ENABLED === "true";
  } else if (providerMode === "fixture") {
    const fixtureUrl = new URL("../fixtures/amap-route-v2.json", import.meta.url);
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
    provider = createFixtureNavigationProvider(fixture);
    routeTrafficEnabled = false;
  } else if (providerMode === "disabled") {
    provider = createDisabledProvider();
    routeTrafficEnabled = false;
  } else {
    throw new Error(`unsupported MOTO_PROVIDER: ${providerMode}`);
  }

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173";
  const liveMode = providerMode === "amap" || providerMode === "google" || providerMode === "auto";
  const mapProvider = createMapTileProvider({
    url: process.env.MOTO_MAP_PMTILES_URL ?? (liveMode ? "auto" : "disabled"),
    cacheDirectory: process.env.MOTO_MAP_CACHE_DIR,
    maximumCacheBytes:
      process.env.MOTO_MAP_CACHE_MAX_BYTES === undefined
        ? undefined
        : Number(process.env.MOTO_MAP_CACHE_MAX_BYTES),
  });
  await mapProvider?.initialize();
  const server = createGateway({
    provider,
    mapProvider,
    allowedOrigin,
    providerMode,
    routeTrafficEnabled,
  });

  server.listen(port, host, () => {
    console.log(`MOTO GPS gateway listening on http://${host}:${port} (${providerMode})`);
  });

  const close = () => {
    mapProvider?.close();
    server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

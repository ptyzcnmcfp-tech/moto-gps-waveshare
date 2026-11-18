import {
  transformAmapRouteOptionsV2,
  transformAmapRouteV2,
} from "./amap-transformer.js";
import { wgs84ToGcj02 } from "./coordinates.js";
import {
  fetchGetWithTransientRetry,
  isTransientUpstreamStatus,
} from "./upstream-retry.js";

const DEFAULT_ENDPOINT = "https://restapi.amap.com/v5/direction/driving";
const DEFAULT_MOTORCYCLE_ENDPOINT = "https://restapi.amap.com/v5/direction/motor";

const DRIVING_STRATEGIES = {
  default: "32",
  avoid_highway: "40",
  less_tolls: "41",
  fastest: "38",
};

const MOTORCYCLE_STRATEGIES = {
  default: "10",
  avoid_highway: "14",
  less_tolls: "15",
  fastest: "12",
};

export class AmapProviderError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.name = "AmapProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function formatProviderPoint(point) {
  return `${Number(point.longitude_deg).toFixed(6)},${Number(point.latitude_deg).toFixed(6)}`;
}

export function buildAmapDrivingUrl(
  request,
  {
    key,
    endpoint,
    enableMotorcycleApi = false,
    motorcyclePlate = "",
    motorcycleType = "",
  } = {},
) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new AmapProviderError("SERVER_MISCONFIGURED", "AMap server key is not configured", {
      retryable: false,
    });
  }

  const origin = wgs84ToGcj02(request.origin);
  const destination = wgs84ToGcj02(request.destination);
  const targetEndpoint =
    endpoint ?? (enableMotorcycleApi ? DEFAULT_MOTORCYCLE_ENDPOINT : DEFAULT_ENDPOINT);
  const url = new URL(targetEndpoint);
  if (url.protocol !== "https:") {
    throw new AmapProviderError("SERVER_MISCONFIGURED", "AMap endpoint must use HTTPS", {
      retryable: false,
    });
  }

  const preference = request.route_preference ?? "default";
  const strategyTable = enableMotorcycleApi ? MOTORCYCLE_STRATEGIES : DRIVING_STRATEGIES;
  const strategy = strategyTable[preference] ?? strategyTable.default;

  url.searchParams.set("key", key);
  url.searchParams.set("origin", formatProviderPoint(origin));
  url.searchParams.set("destination", formatProviderPoint(destination));
  url.searchParams.set("strategy", strategy);
  url.searchParams.set("show_fields", "cost,polyline,navi,tmcs");
  if (request.destination_poi_id) {
    url.searchParams.set("destination_id", request.destination_poi_id);
  }
  if (enableMotorcycleApi) {
    if (typeof motorcyclePlate === "string" && motorcyclePlate.trim() !== "") {
      url.searchParams.set("plate", motorcyclePlate.trim());
    }
    if (typeof motorcycleType === "string" && motorcycleType.trim() !== "") {
      url.searchParams.set("cartype", motorcycleType.trim());
    }
  }
  return url;
}

export function createAmapProvider({
  key,
  fetchImpl = globalThis.fetch,
  endpoint,
  enableMotorcycleApi = false,
  motorcyclePlate = "",
  motorcycleType = "",
  timeoutMs = 12000,
  maxAttempts = 3,
  retryDelayMs = 100,
  clock = Date.now,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  async function fetchRoutePayload(request, { signal } = {}) {
    const url = buildAmapDrivingUrl(request, {
      key,
      endpoint,
      enableMotorcycleApi,
      motorcyclePlate,
      motorcycleType,
    });
    const deadlineSignal = AbortSignal.timeout(timeoutMs);
    const signals = [deadlineSignal];
    if (signal) signals.push(signal);
    const requestSignal = AbortSignal.any(signals);

    let response;
    try {
      response = await fetchGetWithTransientRetry(fetchImpl, url, {
        headers: { Accept: "application/json" },
        signal: requestSignal,
        maxAttempts,
        retryDelayMs,
      });
    } catch (error) {
      const code =
        deadlineSignal.aborted || error?.name === "TimeoutError"
          ? "PROVIDER_TIMEOUT"
          : "PROVIDER_UNAVAILABLE";
      throw new AmapProviderError(code, "AMap route service is unavailable");
    }

    if (!response.ok) {
      throw new AmapProviderError(
        "PROVIDER_HTTP_ERROR",
        `AMap returned HTTP ${response.status}`,
        {
          retryable:
            isTransientUpstreamStatus(response.status) || response.status === 429,
        },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new AmapProviderError("PROVIDER_INVALID_JSON", "AMap returned invalid JSON");
    }
    return payload;
  }

  return {
    async planRoute(request, options = {}) {
      const payload = await fetchRoutePayload(request, options);
      const generatedAtMs = clock();
      if (request.previous_route_id) {
        const candidates = transformAmapRouteOptionsV2(payload, {
          generatedAtMs,
          routePreference: request.route_preference,
        });
        const matched = candidates.find(
          (candidate) => candidate.route_id === request.previous_route_id,
        );
        return matched ?? candidates[0];
      }
      return transformAmapRouteV2(payload, {
        generatedAtMs,
        routePreference: request.route_preference,
      });
    },

    async planRouteOptions(request, options = {}) {
      const payload = await fetchRoutePayload(request, options);
      return transformAmapRouteOptionsV2(payload, {
        generatedAtMs: clock(),
        routePreference: request.route_preference,
      });
    },
  };
}

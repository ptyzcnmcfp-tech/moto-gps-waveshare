import { createHash } from "node:crypto";

import { validateCityKeywords } from "./amap-cities.js";
import { simplifyPolylineToLimit, MAX_MANEUVERS, MAX_POLYLINE_POINTS, MAX_TRAFFIC_SEGMENTS } from "./amap-transformer.js";
import { isOutsideGcj02Coverage } from "./coordinates.js";
import { isTransientUpstreamStatus } from "./upstream-retry.js";

const DEFAULT_ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const DEFAULT_PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const MAX_PLACE_RESULTS = 12;

export class GoogleProviderError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.name = "GoogleProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function compactText(value, maximumLength) {
  return String(value ?? "").trim().slice(0, maximumLength);
}

function rounded(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function parseDurationSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(value ?? "").trim());
  return match ? Math.max(0, Math.round(Number(match[1]))) : 0;
}

export function decodeGooglePolyline(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) return [];
  const points = [];
  let index = 0;
  let latE5 = 0;
  let lonE5 = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (index >= encoded.length) {
        throw new GoogleProviderError("INVALID_POLYLINE", "Google returned truncated encoded polyline", {
          retryable: false,
        });
      }
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    latE5 += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      if (index >= encoded.length) {
        throw new GoogleProviderError("INVALID_POLYLINE", "Google returned truncated encoded polyline", {
          retryable: false,
        });
      }
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lonE5 += result & 1 ? ~(result >> 1) : result >> 1;

    const latitudeDeg = rounded(latE5 / 1e5, 7);
    const longitudeDeg = rounded(lonE5 / 1e5, 7);
    if (Math.abs(latitudeDeg) <= 90 && Math.abs(longitudeDeg) <= 180) {
      const previous = points.at(-1);
      if (
        !previous ||
        previous.longitude_deg !== longitudeDeg ||
        previous.latitude_deg !== latitudeDeg
      ) {
        points.push({ longitude_deg: longitudeDeg, latitude_deg: latitudeDeg });
      }
    }
  }
  return points;
}

function distanceMetres(left, right) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const lat1 = toRadians(left.latitude_deg);
  const lat2 = toRadians(right.latitude_deg);
  const dLat = lat2 - lat1;
  const dLon = toRadians(right.longitude_deg - left.longitude_deg);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function mapGoogleManeuver(maneuver) {
  const code = String(maneuver ?? "").toUpperCase();
  switch (code) {
    case "TURN_SLIGHT_LEFT":
    case "FORK_LEFT":
    case "KEEP_LEFT":
      return "slight_left";
    case "TURN_LEFT":
    case "RAMP_LEFT":
      return "left";
    case "TURN_SHARP_LEFT":
      return "sharp_left";
    case "UTURN_LEFT":
      return "u_turn_left";
    case "TURN_SLIGHT_RIGHT":
    case "FORK_RIGHT":
    case "KEEP_RIGHT":
      return "slight_right";
    case "TURN_RIGHT":
    case "RAMP_RIGHT":
      return "right";
    case "TURN_SHARP_RIGHT":
      return "sharp_right";
    case "UTURN_RIGHT":
      return "u_turn_right";
    case "ROUNDABOUT_LEFT":
    case "ROUNDABOUT_RIGHT":
      return "roundabout";
    case "OFF_RAMP":
      return "exit";
    case "STRAIGHT":
    case "DEPART":
    case "MERGE":
    case "NAME_CHANGE":
      return "continue";
    default:
      return "unknown";
  }
}

function mapGoogleSpeedReading(speed) {
  const code = String(speed ?? "").toUpperCase();
  if (code === "NORMAL") return "free_flow";
  if (code === "SLOW") return "slow";
  if (code === "TRAFFIC_JAM") return "congested";
  return "unknown";
}

function extractRoadNameFromInstruction(instructions) {
  const clean = compactText(String(instructions ?? "").replace(/\s+/g, " "), 256);
  const ontoMatch = /\b(?:onto|on|toward|along|via)\s+([^,.()\n]{2,64})/i.exec(clean);
  if (ontoMatch) return compactText(ontoMatch[1], 96);
  const cjkMatch = /(?:进入|沿|驶入|朝)([^\s,，。；()\n]{2,32})/.exec(clean);
  if (cjkMatch) return compactText(cjkMatch[1], 96);
  return compactText(clean, 64);
}

function cumulativeVertexOffsets(points, totalDistanceM) {
  const offsets = new Float64Array(points.length);
  let cumulative = 0;
  for (let i = 1; i < points.length; i += 1) {
    cumulative += distanceMetres(points[i - 1], points[i]);
    offsets[i] = cumulative;
  }
  if (cumulative > 0 && totalDistanceM > 0) {
    const scale = totalDistanceM / cumulative;
    for (let i = 1; i < points.length; i += 1) {
      offsets[i] *= scale;
    }
  }
  return offsets;
}

function googleRouteIdentifier(polyline, totalDistanceM) {
  const signature = JSON.stringify({
    totalDistanceM: Math.round(totalDistanceM),
    polyline,
  });
  return `google-${createHash("sha256").update(signature).digest("hex").slice(0, 20)}`;
}

export function transformGoogleRoute(
  route,
  { generatedAtMs = Date.now(), routePreference } = {},
) {
  if (!route || typeof route !== "object") {
    throw new GoogleProviderError("NO_ROUTE", "Google returned no usable route", {
      retryable: false,
    });
  }

  let rawPolyline = decodeGooglePolyline(route.polyline?.encodedPolyline);
  const legs = Array.isArray(route.legs) ? route.legs : [];
  const steps = legs.flatMap((leg) => (Array.isArray(leg?.steps) ? leg.steps : []));

  if (rawPolyline.length < 2) {
    rawPolyline = [];
    for (const step of steps) {
      for (const point of decodeGooglePolyline(step.polyline?.encodedPolyline)) {
        const prev = rawPolyline.at(-1);
        if (!prev || prev.longitude_deg !== point.longitude_deg || prev.latitude_deg !== point.latitude_deg) {
          rawPolyline.push(point);
        }
      }
    }
  }
  if (rawPolyline.length < 2) {
    throw new GoogleProviderError("INVALID_POLYLINE", "Google route has fewer than two points", {
      retryable: false,
    });
  }

  const rawManeuvers = [];
  let offsetM = 0;
  let hasHighway = false;
  let hasElevated = false;

  for (const [index, step] of steps.entries()) {
    const stepDistanceM = Math.max(0, Number(step?.distanceMeters ?? 0) || 0);
    const navInstruction = step?.navigationInstruction ?? {};
    const instructions = compactText(
      String(navInstruction.instructions ?? "").replace(/\s+/g, " "),
      256,
    );
    const roadName = extractRoadNameFromInstruction(instructions);
    if (/\b(?:highway|freeway|motorway|expressway|interstate|autobahn)\b|高速|自動車道/i.test(instructions)) {
      hasHighway = true;
    }
    if (/\b(?:elevated|viaduct|flyover|overpass)\b|高架|首都高|阪神高速/i.test(instructions)) {
      hasElevated = true;
    }

    // Google's navigationInstruction applies at the start of the step for turns
    // after step 0; record step boundaries cleanly and append an explicit arrive.
    const maneuverOffsetM = index === 0 ? rounded(stepDistanceM) : rounded(offsetM);
    if (index > 0 || steps.length === 1) {
      rawManeuvers.push({
        id: rawManeuvers.length + 1,
        type: mapGoogleManeuver(navInstruction.maneuver),
        route_offset_m: maneuverOffsetM,
        road_name: roadName,
        instruction: instructions,
        roundabout_exit: 0,
      });
    }
    offsetM += stepDistanceM;
  }

  const totalDistanceM = Math.max(
    1,
    Number(route.distanceMeters ?? offsetM) || offsetM || distanceMetres(rawPolyline[0], rawPolyline.at(-1)),
  );
  const totalDurationS = parseDurationSeconds(route.duration);

  rawManeuvers.push({
    id: rawManeuvers.length + 1,
    type: "arrive",
    route_offset_m: rounded(totalDistanceM),
    road_name: rawManeuvers.at(-1)?.road_name ?? "",
    instruction: "Arrive at destination",
    roundabout_exit: 0,
  });

  const maneuvers =
    rawManeuvers.length <= MAX_MANEUVERS
      ? rawManeuvers
      : [
          ...rawManeuvers.slice(0, MAX_MANEUVERS - 1),
          { ...rawManeuvers.at(-1), id: MAX_MANEUVERS },
        ];

  const vertexOffsets = cumulativeVertexOffsets(rawPolyline, totalDistanceM);
  const intervals = Array.isArray(route.travelAdvisory?.speedReadingIntervals)
    ? route.travelAdvisory.speedReadingIntervals
    : [];
  const traffic = [];
  for (const interval of intervals) {
    const startIdx = Math.max(0, Math.min(rawPolyline.length - 1, Number(interval.startPolylinePointIndex ?? 0)));
    const endIdx = Math.max(startIdx, Math.min(rawPolyline.length - 1, Number(interval.endPolylinePointIndex ?? 0)));
    const startM = rounded(vertexOffsets[startIdx] ?? 0);
    const endM = rounded(vertexOffsets[endIdx] ?? 0);
    if (endM <= startM) continue;
    const level = mapGoogleSpeedReading(interval.speed);
    const prev = traffic.at(-1);
    if (prev && prev.level === level && Math.abs(prev.end_offset_m - startM) < 0.5) {
      prev.end_offset_m = endM;
    } else if (traffic.length < MAX_TRAFFIC_SEGMENTS) {
      traffic.push({ start_offset_m: startM, end_offset_m: endM, level });
    }
  }

  const polyline = simplifyPolylineToLimit(rawPolyline, MAX_POLYLINE_POINTS);
  const bundle = {
    schema_version: 1,
    route_id: googleRouteIdentifier(polyline, totalDistanceM),
    provider: "google",
    coordinate_system: "WGS84",
    generated_at_ms: Math.max(0, Math.trunc(Number(generatedAtMs) || 0)),
    total_distance_m: rounded(totalDistanceM),
    total_duration_s: totalDurationS,
    has_highway: hasHighway,
    has_elevated: hasElevated,
    toll_yuan: 0,
    restriction_active: false,
    polyline,
    maneuvers,
    traffic,
  };
  if (routePreference) {
    bundle.route_preference = routePreference;
  }
  return bundle;
}

export function transformGoogleRouteOptions(
  payload,
  { generatedAtMs = Date.now(), maximumRoutes = 3, routePreference } = {},
) {
  const routes = Array.isArray(payload?.routes) ? payload.routes : [];
  if (routes.length === 0) {
    throw new GoogleProviderError("NO_ROUTE", "Google returned no usable route", {
      retryable: false,
    });
  }
  const limit = Math.min(Math.max(1, Math.trunc(maximumRoutes)), 3);
  const converted = [];
  const seen = new Set();
  let firstError = null;
  for (let i = 0; i < routes.length && converted.length < limit; i += 1) {
    try {
      const bundle = transformGoogleRoute(routes[i], { generatedAtMs, routePreference });
      if (!seen.has(bundle.route_id)) {
        seen.add(bundle.route_id);
        converted.push(bundle);
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  if (converted.length === 0) {
    throw firstError ?? new GoogleProviderError("NO_ROUTE", "Google returned no usable route", { retryable: false });
  }
  return converted;
}

async function postGoogleJson(
  fetchImpl,
  url,
  { key, fieldMask, body, timeoutMs = 12000, maxAttempts = 2, retryDelayMs = 120, signal } = {},
) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new GoogleProviderError("SERVER_MISCONFIGURED", "Google Maps server key is not configured", {
      retryable: false,
    });
  }
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    throw new GoogleProviderError("SERVER_MISCONFIGURED", "Google endpoint must use HTTPS", {
      retryable: false,
    });
  }

  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([deadlineSignal, signal]) : deadlineSignal;
  const serializedBody = JSON.stringify(body);

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(parsedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": fieldMask,
        },
        body: serializedBody,
        signal: requestSignal,
      });
    } catch (error) {
      lastError = error;
      if (deadlineSignal.aborted || signal?.aborted || attempt === maxAttempts) {
        const code =
          deadlineSignal.aborted || error?.name === "TimeoutError"
            ? "PROVIDER_TIMEOUT"
            : "PROVIDER_UNAVAILABLE";
        throw new GoogleProviderError(code, "Google Maps service is unavailable");
      }
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      if (isTransientUpstreamStatus(response.status) && attempt < maxAttempts) {
        if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw new GoogleProviderError(
        "PROVIDER_HTTP_ERROR",
        `Google Maps returned HTTP ${response.status}`,
        {
          retryable: isTransientUpstreamStatus(response.status) || response.status === 429,
        },
      );
    }

    try {
      return await response.json();
    } catch {
      throw new GoogleProviderError("PROVIDER_INVALID_JSON", "Google Maps returned invalid JSON");
    }
  }
  throw lastError ?? new GoogleProviderError("PROVIDER_UNAVAILABLE", "Google Maps service is unavailable");
}

export function createGoogleProvider({
  key,
  fetchImpl = globalThis.fetch,
  routesEndpoint = DEFAULT_ROUTES_ENDPOINT,
  placesEndpoint = DEFAULT_PLACES_ENDPOINT,
  travelMode = "TWO_WHEELER",
  trafficAware = true,
  timeoutMs = 12000,
  maxAttempts = 2,
  retryDelayMs = 100,
  clock = Date.now,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const routeFieldMask = [
    "routes.distanceMeters",
    "routes.duration",
    "routes.polyline.encodedPolyline",
    "routes.legs.steps.distanceMeters",
    "routes.legs.steps.staticDuration",
    "routes.legs.steps.polyline.encodedPolyline",
    "routes.legs.steps.navigationInstruction",
    "routes.travelAdvisory.speedReadingIntervals",
  ].join(",");

  async function computeRoutes(request, { alternatives = false, signal } = {}) {
    const preference = request.route_preference ?? "default";
    const buildBody = (mode) => {
      const body = {
        origin: {
          location: {
            latLng: {
              latitude: Number(request.origin.latitude_deg),
              longitude: Number(request.origin.longitude_deg),
            },
          },
        },
        destination: {
          location: {
            latLng: {
              latitude: Number(request.destination.latitude_deg),
              longitude: Number(request.destination.longitude_deg),
            },
          },
        },
        travelMode: mode,
        computeAlternativeRoutes: alternatives,
        polylineQuality: "OVERVIEW",
        units: "METRIC",
        routeModifiers: {
          avoidHighways: preference === "avoid_highway",
          avoidTolls: preference === "less_tolls",
        },
      };
      if (trafficAware) {
        body.routingPreference = "TRAFFIC_AWARE";
        body.extraComputations = ["TRAFFIC_ON_POLYLINE"];
      }
      return body;
    };

    const normalizedMode = travelMode === "TWO_WHEELER" ? "TWO_WHEELER" : "DRIVE";
    try {
      const payload = await postGoogleJson(fetchImpl, routesEndpoint, {
        key,
        fieldMask: routeFieldMask,
        body: buildBody(normalizedMode),
        timeoutMs,
        maxAttempts,
        retryDelayMs,
        signal,
      });
      if (Array.isArray(payload?.routes) && payload.routes.length > 0) {
        return payload;
      }
      if (normalizedMode !== "TWO_WHEELER") return payload;
    } catch (error) {
      if (
        normalizedMode !== "TWO_WHEELER" ||
        error?.code === "SERVER_MISCONFIGURED" ||
        error?.code === "PROVIDER_TIMEOUT"
      ) {
        throw error;
      }
    }

    // Google's TWO_WHEELER mode is unavailable in several countries; fall back
    // cleanly to DRIVE with the same highway/toll modifiers.
    return postGoogleJson(fetchImpl, routesEndpoint, {
      key,
      fieldMask: routeFieldMask,
      body: buildBody("DRIVE"),
      timeoutMs,
      maxAttempts,
      retryDelayMs,
      signal,
    });
  }

  return {
    async planRoute(request, options = {}) {
      const wantAlternatives = Boolean(request.previous_route_id);
      const payload = await computeRoutes(request, {
        alternatives: wantAlternatives,
        signal: options.signal,
      });
      const generatedAtMs = clock();
      if (wantAlternatives) {
        const candidates = transformGoogleRouteOptions(payload, {
          generatedAtMs,
          routePreference: request.route_preference,
        });
        const matched = candidates.find(
          (candidate) => candidate.route_id === request.previous_route_id,
        );
        return matched ?? candidates[0];
      }
      const first = Array.isArray(payload?.routes) ? payload.routes[0] : null;
      return transformGoogleRoute(first, {
        generatedAtMs,
        routePreference: request.route_preference,
      });
    },

    async planRouteOptions(request, options = {}) {
      const payload = await computeRoutes(request, {
        alternatives: true,
        signal: options.signal,
      });
      return transformGoogleRouteOptions(payload, {
        generatedAtMs: clock(),
        routePreference: request.route_preference,
      });
    },

    async searchPlaces(query, { signal } = {}) {
      const keywords = compactText(query?.keywords, 80);
      if (keywords.length < 2) {
        throw new GoogleProviderError("INVALID_REQUEST", "keywords must contain at least 2 characters", {
          retryable: false,
        });
      }
      const body = {
        textQuery: query?.region ? `${keywords} ${compactText(query.region, 32)}` : keywords,
        maxResultCount: MAX_PLACE_RESULTS,
      };
      if (query?.origin) {
        body.locationBias = {
          circle: {
            center: {
              latitude: Number(query.origin.latitude_deg),
              longitude: Number(query.origin.longitude_deg),
            },
            radius: 50_000,
          },
        };
      }
      const payload = await postGoogleJson(fetchImpl, placesEndpoint, {
        key,
        fieldMask:
          "places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents",
        body,
        timeoutMs: 8000,
        maxAttempts,
        retryDelayMs,
        signal,
      });

      const places = [];
      for (const item of Array.isArray(payload?.places) ? payload.places : []) {
        const lat = Number(item?.location?.latitude);
        const lon = Number(item?.location?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          continue;
        }
        const components = Array.isArray(item.addressComponents) ? item.addressComponents : [];
        const findComponent = (type) =>
          compactText(
            components.find((entry) => Array.isArray(entry.types) && entry.types.includes(type))
              ?.longText,
            32,
          );
        const city =
          findComponent("locality") || findComponent("administrative_area_level_2") || findComponent("administrative_area_level_1");
        const district =
          findComponent("sublocality_level_1") || findComponent("sublocality") || findComponent("country");
        const location = {
          coordinate_system: "WGS84",
          longitude_deg: rounded(lon, 7),
          latitude_deg: rounded(lat, 7),
        };
        const place = {
          id: compactText(item.id, 64),
          name: compactText(item.displayName?.text, 96) || compactText(item.formattedAddress, 96),
          address: compactText(item.formattedAddress, 160),
          city,
          district,
          display_area: [city, district].filter(Boolean).join(" · "),
          location,
        };
        if (query?.origin) {
          place.distance_m = Math.round(distanceMetres(query.origin, location));
        }
        places.push(place);
        if (places.length >= MAX_PLACE_RESULTS) break;
      }

      return { protocol_version: 1, query: keywords, places };
    },

    async searchCities({ keywords } = {}, { signal } = {}) {
      const validated = validateCityKeywords(keywords);
      const payload = await postGoogleJson(fetchImpl, placesEndpoint, {
        key,
        fieldMask:
          "places.id,places.displayName,places.formattedAddress,places.viewport,places.location",
        body: {
          textQuery: validated,
          maxResultCount: 10,
        },
        timeoutMs: 8000,
        maxAttempts,
        retryDelayMs,
        signal,
      });

      const cities = [];
      const seen = new Set();
      for (const item of Array.isArray(payload?.places) ? payload.places : []) {
        const id = compactText(item?.id, 64);
        const name = compactText(item?.displayName?.text, 80);
        if (!id || !name || seen.has(id)) continue;

        let west = Number(item?.viewport?.low?.longitude);
        let south = Number(item?.viewport?.low?.latitude);
        let east = Number(item?.viewport?.high?.longitude);
        let north = Number(item?.viewport?.high?.latitude);
        if (
          !Number.isFinite(west) ||
          !Number.isFinite(south) ||
          !Number.isFinite(east) ||
          !Number.isFinite(north) ||
          west >= east ||
          south >= north
        ) {
          const lon = Number(item?.location?.longitude);
          const lat = Number(item?.location?.latitude);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          west = Math.max(-180, lon - 0.15);
          east = Math.min(180, lon + 0.15);
          south = Math.max(-85, lat - 0.15);
          north = Math.min(85, lat + 0.15);
        }

        seen.add(id);
        cities.push({
          id,
          name,
          detail: compactText(item?.formattedAddress, 64) || "City area",
          bounds_wgs84: [
            rounded(west, 6),
            rounded(south, 6),
            rounded(east, 6),
            rounded(north, 6),
          ],
        });
      }
      return { cities };
    },
  };
}

export function createAutoProvider({ amap, google }) {
  if (!amap && !google) {
    throw new TypeError("createAutoProvider requires at least one of amap or google");
  }
  const routeUsesAmap = (request) => {
    if (!amap) return false;
    if (!google) return true;
    const originInGcj = !isOutsideGcj02Coverage(
      request.origin.longitude_deg,
      request.origin.latitude_deg,
    );
    const destInGcj = !isOutsideGcj02Coverage(
      request.destination.longitude_deg,
      request.destination.latitude_deg,
    );
    return originInGcj && destInGcj;
  };

  const looksChineseQuery = (text) =>
    /[\u4e00-\u9fff]/.test(String(text ?? "")) &&
    !/[\u3040-\u30ff\uac00-\ud7af]/.test(String(text ?? ""));

  return {
    async planRoute(request, options) {
      return routeUsesAmap(request)
        ? amap.planRoute(request, options)
        : google.planRoute(request, options);
    },
    async planRouteOptions(request, options) {
      return routeUsesAmap(request)
        ? amap.planRouteOptions(request, options)
        : google.planRouteOptions(request, options);
    },
    async searchPlaces(query, options) {
      if (!amap) return google.searchPlaces(query, options);
      if (!google) return amap.searchPlaces(query, options);
      if (query?.origin) {
        const originOutside = isOutsideGcj02Coverage(
          query.origin.longitude_deg,
          query.origin.latitude_deg,
        );
        const primary = originOutside ? google : amap;
        const secondary = originOutside ? amap : google;
        const first = await primary.searchPlaces(query, options);
        if (first.places.length > 0) return first;
        return secondary.searchPlaces({ ...query, origin: undefined }, options);
      }
      const primary = looksChineseQuery(query?.keywords) ? amap : google;
      const secondary = primary === amap ? google : amap;
      const first = await primary.searchPlaces(query, options);
      if (first.places.length > 0) return first;
      return secondary.searchPlaces(query, options);
    },
    async searchCities(query, options) {
      if (!amap) return google.searchCities(query, options);
      if (!google) return amap.searchCities(query, options);
      const primary = looksChineseQuery(query?.keywords) ? amap : google;
      const secondary = primary === amap ? google : amap;
      try {
        const first = await primary.searchCities(query, options);
        if (first.cities.length > 0) return first;
      } catch {
        // Fall through to secondary provider when region lookup misses.
      }
      return secondary.searchCities(query, options);
    },
  };
}

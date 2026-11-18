import { createHash } from "node:crypto";

export const MAX_POLYLINE_POINTS = 32768;
export const MAX_MANEUVERS = 1024;
export const MAX_TRAFFIC_SEGMENTS = 4096;

export class AmapTransformError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "AmapTransformError";
    this.code = code;
    this.retryable = retryable;
  }
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  return Math.max(0, finiteNumber(value, fallback));
}

function compactText(value, maximumLength) {
  if (Array.isArray(value)) {
    value = value.join("/");
  }
  return String(value ?? "").trim().slice(0, maximumLength);
}

function rounded(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function parsePolyline(polyline) {
  if (typeof polyline !== "string" || polyline.trim() === "") {
    return [];
  }

  const points = [];
  for (const encodedPoint of polyline.split(";")) {
    const trimmed = encodedPoint.trim();
    if (trimmed === "") continue;
    const [longitudeText, latitudeText] = trimmed.split(",");
    const longitudeDeg = Number(longitudeText);
    const latitudeDeg = Number(latitudeText);
    if (
      !Number.isFinite(longitudeDeg) ||
      !Number.isFinite(latitudeDeg) ||
      longitudeDeg < -180 ||
      longitudeDeg > 180 ||
      latitudeDeg < -90 ||
      latitudeDeg > 90
    ) {
      throw new AmapTransformError("INVALID_POLYLINE", "AMap returned an invalid polyline point");
    }
    points.push({
      longitude_deg: rounded(longitudeDeg, 7),
      latitude_deg: rounded(latitudeDeg, 7),
    });
  }
  return points;
}

function samePoint(left, right) {
  return (
    left?.longitude_deg === right?.longitude_deg &&
    left?.latitude_deg === right?.latitude_deg
  );
}

function appendPolyline(target, points) {
  for (const point of points) {
    if (!samePoint(target.at(-1), point)) {
      target.push(point);
    }
  }
}

function stepGeometry(step, stepDistanceM) {
  const polyline = parsePolyline(step.polyline);
  if (
    polyline.length >= 2 ||
    stepDistanceM === 0 ||
    (polyline.length === 1 && stepDistanceM <= 35)
  ) {
    return polyline;
  }

  // Some responses omit the step-level geometry but still include it in every
  // TMC. Recover only complete coverage: concatenating partial fragments would
  // turn missing roads into a straight line or truncate the route, while tiny
  // integer-metre rounding across dozens of TMCs on long highway legs is normal.
  const tmcs = Array.isArray(step.tmcs) ? step.tmcs : [];
  const recovered = [];
  let coveredDistanceM = 0;
  for (const tmc of tmcs) {
    const distanceM = nonNegativeNumber(tmc.tmc_distance ?? tmc.distance);
    if (distanceM === 0) continue;
    const points = parsePolyline(tmc.tmc_polyline ?? tmc.polyline);
    if (points.length < 2 && !(points.length === 1 && distanceM <= 35)) {
      return [];
    }
    appendPolyline(recovered, points);
    coveredDistanceM += distanceM;
  }
  const toleranceM = Math.max(5, Math.min(80, tmcs.length * 1.5));
  return coveredDistanceM + toleranceM >= stepDistanceM ? recovered : [];
}

function perpendicularDistanceMetres(point, start, end) {
  const meanLatRad = ((start.latitude_deg + end.latitude_deg) * 0.5 * Math.PI) / 180;
  const metersPerDegLat = 111_132.0;
  const metersPerDegLon = 111_320.0 * Math.cos(meanLatRad);
  const px = (point.longitude_deg - start.longitude_deg) * metersPerDegLon;
  const py = (point.latitude_deg - start.latitude_deg) * metersPerDegLat;
  const dx = (end.longitude_deg - start.longitude_deg) * metersPerDegLon;
  const dy = (end.latitude_deg - start.latitude_deg) * metersPerDegLat;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 1e-9) {
    return Math.hypot(px, py);
  }
  const t = Math.min(1, Math.max(0, (px * dx + py * dy) / lengthSq));
  return Math.hypot(px - t * dx, py - t * dy);
}

function simplifyDouglasPeucker(points, epsilonM) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last - first <= 1) continue;
    let maxDist = -1;
    let split = -1;
    for (let i = first + 1; i < last; i += 1) {
      const dist = perpendicularDistanceMetres(points[i], points[first], points[last]);
      if (dist > maxDist) {
        maxDist = dist;
        split = i;
      }
    }
    if (maxDist > epsilonM && split !== -1) {
      keep[split] = 1;
      stack.push([first, split], [split, last]);
    }
  }

  const simplified = [];
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i]) simplified.push(points[i]);
  }
  return simplified;
}

export function simplifyPolylineToLimit(points, maximumPoints = MAX_POLYLINE_POINTS) {
  if (points.length <= maximumPoints) return points;
  let candidate = points;
  for (const epsilonM of [2, 5, 10, 20, 40, 80, 160, 320]) {
    candidate = simplifyDouglasPeucker(candidate, epsilonM);
    if (candidate.length <= maximumPoints) return candidate;
  }
  const sampled = [candidate[0]];
  const interiorSlots = Math.max(0, maximumPoints - 2);
  for (let i = 1; i <= interiorSlots; i += 1) {
    const index = Math.round((i * (candidate.length - 1)) / (interiorSlots + 1));
    sampled.push(candidate[index]);
  }
  sampled.push(candidate.at(-1));
  return sampled;
}

function compactManeuversToLimit(maneuvers, maximumManeuvers = MAX_MANEUVERS) {
  if (maneuvers.length <= maximumManeuvers) return maneuvers;
  const compacted = maneuvers.filter((maneuver, index) => {
    if (index === 0 || index === maneuvers.length - 1) return true;
    return maneuver.type !== "continue" && maneuver.type !== "unknown";
  });
  const bounded =
    compacted.length <= maximumManeuvers
      ? compacted
      : [
          ...compacted.slice(0, maximumManeuvers - 1),
          compacted.at(-1),
        ];
  return bounded.map((maneuver, index) => ({ ...maneuver, id: index + 1 }));
}

const TRAFFIC_SEVERITY = {
  unknown: 0,
  free_flow: 1,
  slow: 2,
  congested: 3,
  severe: 4,
};

function compactTrafficToLimit(traffic, maximumSegments = MAX_TRAFFIC_SEGMENTS) {
  if (traffic.length <= maximumSegments) return traffic;
  let current = traffic.map((segment) => ({ ...segment }));
  while (current.length > maximumSegments) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1];
      if (!right) {
        next.push(left);
        continue;
      }
      const dominantLevel =
        (TRAFFIC_SEVERITY[right.level] ?? 0) > (TRAFFIC_SEVERITY[left.level] ?? 0)
          ? right.level
          : left.level;
      next.push({
        start_offset_m: left.start_offset_m,
        end_offset_m: right.end_offset_m,
        level: dominantLevel,
      });
    }
    current = next;
  }
  return current;
}

export function mapAmapManeuver(action, assistantAction = "") {
  const primary = compactText(action, 96);
  const assistant = compactText(assistantAction, 96);
  const combined = `${primary} ${assistant}`;

  if (/到达|目的地/.test(assistant) || /到达目的地/.test(primary)) return "arrive";
  if (/驶出环岛|离开环岛|出环岛/.test(combined)) return "exit";
  if (/环岛/.test(combined)) return "roundabout";
  if (/右后方|右转掉头|向右掉头/.test(combined)) return "u_turn_right";
  if (/左后方|掉头/.test(combined)) return "u_turn_left";
  if (/右前方|稍向右|靠右/.test(combined)) return "slight_right";
  if (/左前方|稍向左|靠左/.test(combined)) return "slight_left";
  if (/急向右|大幅右转/.test(combined)) return "sharp_right";
  if (/急向左|大幅左转/.test(combined)) return "sharp_left";
  if (/右转/.test(combined)) return "right";
  if (/左转/.test(combined)) return "left";
  if (/直行|沿|前行|继续/.test(combined)) return "continue";
  return "unknown";
}

export function mapAmapTrafficStatus(status) {
  const normalized = compactText(status, 32).toLowerCase();
  if (normalized.includes("严重拥堵") || normalized === "blocked" || normalized === "severe") {
    return "severe";
  }
  if (normalized.includes("拥堵") || normalized === "congested") return "congested";
  if (normalized.includes("缓行") || normalized === "slow") return "slow";
  if (normalized.includes("畅通") || normalized === "smooth" || normalized === "free") {
    return "free_flow";
  }
  return "unknown";
}

function roundaboutExit(action, assistantAction) {
  const match = `${action ?? ""} ${assistantAction ?? ""}`.match(/第\s*(\d{1,2})\s*个?出口/);
  return match ? Math.min(32, Number(match[1])) : 0;
}

function appendTraffic(target, segment) {
  if (segment.end_offset_m <= segment.start_offset_m) return;
  const previous = target.at(-1);
  if (
    previous &&
    previous.level === segment.level &&
    Math.abs(previous.end_offset_m - segment.start_offset_m) < 0.01
  ) {
    previous.end_offset_m = segment.end_offset_m;
    return;
  }
  target.push(segment);
}

function routeIdentifier(path, polyline, totalDistanceM) {
  const providerId = compactText(path.path_id ?? path.pathid ?? path.id, 80);
  if (providerId) return `amap-${providerId}`.slice(0, 96);

  // Exclude live duration from the fallback hash so periodic traffic refreshes
  // keep a stable route_id for the exact same road geometry.
  const signature = JSON.stringify({
    totalDistanceM: Math.round(totalDistanceM),
    polyline,
  });
  return `amap-${createHash("sha256").update(signature).digest("hex").slice(0, 20)}`;
}

function detectHighwayAndElevated(steps, tollYuan) {
  let hasHighway = tollYuan > 0;
  let hasElevated = false;
  for (const step of steps) {
    const road = compactText(step.road_name ?? step.road, 96);
    const instruction = compactText(step.instruction, 256);
    const combined = `${road} ${instruction}`;
    if (/高速|收费站|(?:^|[^A-Za-z0-9])[GS]\d{1,4}高速/.test(combined)) {
      hasHighway = true;
    }
    if (/高架|快速路|内环|中环|立交主线/.test(combined)) {
      hasElevated = true;
    }
  }
  return { hasHighway, hasElevated };
}

function assertAmapSuccess(payload) {
  if (!payload || typeof payload !== "object") {
    throw new AmapTransformError("INVALID_RESPONSE", "AMap returned a non-object response", {
      retryable: true,
    });
  }
  if (String(payload.status) !== "1") {
    const providerCode = compactText(payload.infocode, 24) || "UNKNOWN";
    throw new AmapTransformError(
      `AMAP_${providerCode}`,
      `AMap route planning failed (${providerCode})`,
      { retryable: providerCode.startsWith("10") === false },
    );
  }
}

/**
 * Converts an AMap Route Planning v2 driving/motorcycle response into protocol v1.
 * No AMap field is allowed to escape this function.
 */
export function transformAmapRouteV2(
  payload,
  { generatedAtMs = Date.now(), pathIndex = 0, routePreference } = {},
) {
  assertAmapSuccess(payload);
  const paths = payload.route?.paths;
  if (!Array.isArray(paths) || !paths[pathIndex]) {
    throw new AmapTransformError("NO_ROUTE", "AMap returned no usable driving path");
  }

  const path = paths[pathIndex];
  const steps = Array.isArray(path.steps) ? path.steps : [];

  const rawPolyline = [];
  const rawManeuvers = [];
  const rawTraffic = [];
  let routeOffsetM = 0;
  let missingStepGeometry = false;

  for (const [index, step] of steps.entries()) {
    const stepDistanceM = nonNegativeNumber(step.step_distance ?? step.distance);
    const stepPolyline = stepGeometry(step, stepDistanceM);
    const usableMicroStep = stepDistanceM <= 35 && (stepPolyline.length >= 1 || rawPolyline.length >= 1);
    if (stepDistanceM > 0 && stepPolyline.length < 2 && !usableMicroStep) {
      missingStepGeometry = true;
    }
    appendPolyline(rawPolyline, stepPolyline);

    const navi = step.navi && typeof step.navi === "object" ? step.navi : {};
    const action = navi.action ?? step.action ?? "";
    const assistantAction = navi.assistant_action ?? step.assistant_action ?? "";

    // AMap describes a step as "travel this step, then perform action".
    // The maneuver therefore happens at the end of the step, not at its beginning.
    rawManeuvers.push({
      id: index + 1,
      type: mapAmapManeuver(action, assistantAction),
      route_offset_m: rounded(routeOffsetM + stepDistanceM),
      road_name: compactText(step.road_name ?? step.road, 96),
      instruction: compactText(step.instruction, 256),
      roundabout_exit: roundaboutExit(action, assistantAction),
    });

    const tmcs = Array.isArray(step.tmcs) ? step.tmcs : [];
    let tmcOffsetM = routeOffsetM;
    for (const tmc of tmcs) {
      const segmentDistanceM = nonNegativeNumber(tmc.tmc_distance ?? tmc.distance);
      const endOffsetM = tmcOffsetM + segmentDistanceM;
      appendTraffic(rawTraffic, {
        start_offset_m: rounded(tmcOffsetM),
        end_offset_m: rounded(endOffsetM),
        level: mapAmapTrafficStatus(tmc.tmc_status ?? tmc.status),
      });
      tmcOffsetM = endOffsetM;
    }

    routeOffsetM += stepDistanceM;
  }

  if (missingStepGeometry || rawPolyline.length < 2) {
    const completePathPolyline = parsePolyline(path.polyline);
    if (completePathPolyline.length < 2 && missingStepGeometry) {
      throw new AmapTransformError(
        "INVALID_POLYLINE",
        "AMap route is missing geometry for a road segment",
        { retryable: true },
      );
    }
    rawPolyline.length = 0;
    appendPolyline(rawPolyline, completePathPolyline);
  }
  if (rawPolyline.length < 2) {
    throw new AmapTransformError("INVALID_POLYLINE", "AMap route has fewer than two points");
  }

  const polyline = simplifyPolylineToLimit(rawPolyline, MAX_POLYLINE_POINTS);
  const maneuvers = compactManeuversToLimit(rawManeuvers, MAX_MANEUVERS);
  const traffic = compactTrafficToLimit(rawTraffic, MAX_TRAFFIC_SEGMENTS);

  const totalDistanceM = nonNegativeNumber(path.distance, routeOffsetM) || routeOffsetM;
  const durationCandidate = path.cost?.duration ?? path.duration;
  const stepDurationS = steps.reduce(
    (sum, step) => sum + nonNegativeNumber(step.cost?.duration ?? step.duration),
    0,
  );
  const totalDurationS = Math.round(nonNegativeNumber(durationCandidate, stepDurationS));
  const integerGeneratedAtMs = Math.max(0, Math.trunc(finiteNumber(generatedAtMs)));
  const tollYuan = rounded(nonNegativeNumber(path.cost?.tolls ?? path.tolls), 2);
  const { hasHighway, hasElevated } = detectHighwayAndElevated(steps, tollYuan);
  const restrictionActive = String(path.restriction ?? "0") === "1";

  const bundle = {
    schema_version: 1,
    route_id: routeIdentifier(path, polyline, totalDistanceM),
    provider: "amap",
    coordinate_system: "GCJ-02",
    generated_at_ms: integerGeneratedAtMs,
    total_distance_m: rounded(totalDistanceM),
    total_duration_s: totalDurationS,
    has_highway: hasHighway,
    has_elevated: hasElevated,
    toll_yuan: tollYuan,
    restriction_active: restrictionActive,
    polyline,
    maneuvers,
    traffic,
  };
  if (routePreference) {
    bundle.route_preference = routePreference;
  }
  return bundle;
}

/**
 * Converts up to three usable AMap candidates returned by the multi-route strategy.
 * One malformed or oversized alternative never discards sibling candidates.
 */
export function transformAmapRouteOptionsV2(
  payload,
  { generatedAtMs = Date.now(), maximumRoutes = 3, routePreference } = {},
) {
  assertAmapSuccess(payload);
  const paths = payload.route?.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new AmapTransformError("NO_ROUTE", "AMap returned no usable driving path");
  }

  const limit = Math.min(Math.max(1, Math.trunc(maximumRoutes)), 3);
  const routes = [];
  const seenIds = new Set();
  let firstError = null;

  for (let pathIndex = 0; pathIndex < paths.length && routes.length < limit; pathIndex += 1) {
    try {
      const candidate = transformAmapRouteV2(payload, {
        generatedAtMs,
        pathIndex,
        routePreference,
      });
      if (!seenIds.has(candidate.route_id)) {
        seenIds.add(candidate.route_id);
        routes.push(candidate);
      }
    } catch (error) {
      firstError ??= error;
    }
  }

  if (routes.length === 0) {
    throw firstError ?? new AmapTransformError("NO_ROUTE", "AMap returned no usable driving path");
  }
  return routes;
}

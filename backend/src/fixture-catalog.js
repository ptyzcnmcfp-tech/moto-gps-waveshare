import { transformAmapRouteOptionsV2, transformAmapRouteV2 } from "./amap-transformer.js";
import { isOutsideGcj02Coverage, wgs84ToGcj02 } from "./coordinates.js";

const FIXTURE_PLACES = [
  {
    id: "B021407X01",
    name: "济南西站",
    address: "齐鲁大道6号",
    city: "济南市",
    district: "槐荫区",
    aliases: ["济南西", "西站", "jinan west"],
    location: { coordinate_system: "WGS84", longitude_deg: 116.891322, latitude_deg: 36.669148 },
  },
  {
    id: "B02140A001",
    name: "济南奥林匹克体育中心",
    address: "经十东路龙奥北路",
    city: "济南市",
    district: "历下区",
    aliases: ["奥体中心", "奥体", "jinan olympic"],
    location: { coordinate_system: "WGS84", longitude_deg: 117.120092, latitude_deg: 36.656554 },
  },
  {
    id: "B02140B002",
    name: "趵突泉景区",
    address: "趵突泉南路1号",
    city: "济南市",
    district: "历下区",
    aliases: ["趵突泉", "baotu"],
    location: { coordinate_system: "WGS84", longitude_deg: 117.015921, latitude_deg: 36.661094 },
  },
  {
    id: "B000A83V3S",
    name: "北京站",
    address: "毛家湾胡同甲13号",
    city: "北京市",
    district: "东城区",
    aliases: ["beijing station"],
    location: { coordinate_system: "WGS84", longitude_deg: 116.427281, latitude_deg: 39.902896 },
  },
  {
    id: "ChIJ_TooXM3gAGARQR6hXH3QAQ8",
    name: "Osaka Castle (大阪城)",
    address: "1-1 Osakajo, Chuo Ward, Osaka",
    city: "Osaka",
    district: "Japan",
    aliases: ["osaka", "大阪", "大阪城"],
    location: { coordinate_system: "WGS84", longitude_deg: 135.525955, latitude_deg: 34.687315 },
  },
  {
    id: "ChIJCewJkL2LGGAR3Qmk0vCTGkg",
    name: "Tokyo Tower (东京塔)",
    address: "4 Chome-2-8 Shibakoen, Minato City, Tokyo",
    city: "Tokyo",
    district: "Japan",
    aliases: ["tokyo", "东京", "东京塔"],
    location: { coordinate_system: "WGS84", longitude_deg: 139.745433, latitude_deg: 35.658581 },
  },
];

function distanceMetres(left, right) {
  const toRadians = (deg) => (deg * Math.PI) / 180;
  const lat1 = toRadians(left.latitude_deg);
  const lat2 = toRadians(right.latitude_deg);
  const dLat = lat2 - lat1;
  const dLon = toRadians(right.longitude_deg - left.longitude_deg);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function buildDynamicAlternatives(originWgs84, destinationWgs84, generatedAtMs, preference = "default") {
  const outsideGcj02 =
    isOutsideGcj02Coverage(originWgs84.longitude_deg, originWgs84.latitude_deg) ||
    isOutsideGcj02Coverage(destinationWgs84.longitude_deg, destinationWgs84.latitude_deg);

  const start = outsideGcj02 ? originWgs84 : wgs84ToGcj02(originWgs84);
  const end = outsideGcj02 ? destinationWgs84 : wgs84ToGcj02(destinationWgs84);
  const directM = Math.max(600, distanceMetres(originWgs84, destinationWgs84));
  const stepsCount = Math.min(240, Math.max(16, Math.round(directM / 1200)));

  const makeBundle = ({ suffix, lateralOffsetDeg, distanceFactor, speedMps, hasHighway, hasElevated, tollYuan }) => {
    const polyline = [];
    for (let i = 0; i <= stepsCount; i += 1) {
      const t = i / stepsCount;
      const arch = Math.sin(t * Math.PI) * lateralOffsetDeg;
      polyline.push({
        longitude_deg: Number((start.longitude_deg + (end.longitude_deg - start.longitude_deg) * t + arch).toFixed(7)),
        latitude_deg: Number((start.latitude_deg + (end.latitude_deg - start.latitude_deg) * t - arch * 0.65).toFixed(7)),
      });
    }
    const totalDistanceM = Math.round(directM * distanceFactor);
    const totalDurationS = Math.max(60, Math.round(totalDistanceM / speedMps));
    const mainRoad = outsideGcj02
      ? hasHighway
        ? "Hanshin Expy"
        : "National Route 1"
      : hasHighway
        ? "G2京沪高速"
        : "G104国道";
    const connectorRoad = outsideGcj02 ? "Chuo Blvd" : "经十西路";

    return {
      schema_version: 1,
      route_id: `${outsideGcj02 ? "google" : "amap"}-fixture-${suffix}`,
      provider: outsideGcj02 ? "google" : "amap",
      coordinate_system: outsideGcj02 ? "WGS84" : "GCJ-02",
      generated_at_ms: generatedAtMs,
      total_distance_m: totalDistanceM,
      total_duration_s: totalDurationS,
      route_preference: preference,
      has_highway: hasHighway,
      has_elevated: hasElevated,
      toll_yuan: outsideGcj02 ? 0 : tollYuan,
      restriction_active: false,
      polyline,
      maneuvers: [
        {
          id: 1,
          type: "continue",
          route_offset_m: Math.round(totalDistanceM * 0.35),
          road_name: mainRoad,
          instruction: outsideGcj02 ? `Continue on ${mainRoad}` : `沿${mainRoad}直行`,
          roundabout_exit: 0,
        },
        {
          id: 2,
          type: "right",
          route_offset_m: Math.round(totalDistanceM * 0.82),
          road_name: connectorRoad,
          instruction: outsideGcj02 ? `Turn right onto ${connectorRoad}` : `右转进入${connectorRoad}`,
          roundabout_exit: 0,
        },
        {
          id: 3,
          type: "arrive",
          route_offset_m: totalDistanceM,
          road_name: connectorRoad,
          instruction: outsideGcj02 ? "Arrive at destination" : "到达目的地",
          roundabout_exit: 0,
        },
      ],
      traffic: [
        { start_offset_m: 0, end_offset_m: Math.round(totalDistanceM * 0.65), level: "free_flow" },
        { start_offset_m: Math.round(totalDistanceM * 0.65), end_offset_m: totalDistanceM, level: "slow" },
      ],
    };
  };

  const express = makeBundle({
    suffix: "express-1",
    lateralOffsetDeg: 0.0,
    distanceFactor: 1.18,
    speedMps: 22.5,
    hasHighway: directM > 15_000,
    hasElevated: directM > 8_000,
    tollYuan: directM > 15_000 ? Math.round(directM / 2200) : 0,
  });
  const arterial = makeBundle({
    suffix: "arterial-no-hwy-2",
    lateralOffsetDeg: 0.012,
    distanceFactor: 1.27,
    speedMps: 15.8,
    hasHighway: false,
    hasElevated: false,
    tollYuan: 0,
  });
  const scenic = makeBundle({
    suffix: "scenic-low-toll-3",
    lateralOffsetDeg: -0.014,
    distanceFactor: 1.33,
    speedMps: 16.5,
    hasHighway: false,
    hasElevated: directM > 20_000,
    tollYuan: 0,
  });

  if (preference === "avoid_highway" || preference === "less_tolls") {
    return [arterial, scenic, express];
  }
  return [express, arterial, scenic];
}

function isStandardBeijingFixtureRequest(request) {
  if (!request?.origin || !request?.destination) return true;
  const nearBeijing =
    Math.abs(request.origin.longitude_deg - 116.397389) < 0.08 &&
    Math.abs(request.origin.latitude_deg - 39.908722) < 0.08 &&
    Math.abs(request.destination.longitude_deg - 116.410886) < 0.08 &&
    Math.abs(request.destination.latitude_deg - 39.92015) < 0.08;
  return nearBeijing;
}

export function createFixtureNavigationProvider(amapFixturePayload, { clock = Date.now } = {}) {
  function buildFixtureCandidates(request) {
    const generatedAtMs = clock();
    const preference = request?.route_preference ?? "default";
    if (isStandardBeijingFixtureRequest(request)) {
      const base = transformAmapRouteV2(amapFixturePayload, {
        generatedAtMs,
        routePreference: preference,
      });
      const altA = {
        ...structuredClone(base),
        route_id: "amap-fixture-beijing-002",
        total_distance_m: 2340,
        total_duration_s: 455,
        has_highway: false,
        has_elevated: false,
        toll_yuan: 0,
      };
      const altB = {
        ...structuredClone(base),
        route_id: "amap-fixture-beijing-003",
        total_distance_m: 2490,
        total_duration_s: 480,
        has_highway: false,
        has_elevated: true,
        toll_yuan: 0,
      };
      const baseOptions = transformAmapRouteOptionsV2(amapFixturePayload, {
        generatedAtMs,
        routePreference: preference,
      });
      if (baseOptions.length >= 2) return baseOptions;
      return preference === "avoid_highway" ? [altA, base, altB] : [base, altA, altB];
    }
    return buildDynamicAlternatives(
      request.origin,
      request.destination,
      generatedAtMs,
      preference,
    );
  }

  return {
    async planRoute(request) {
      const candidates = buildFixtureCandidates(request);
      if (request?.previous_route_id) {
        const matched = candidates.find((item) => item.route_id === request.previous_route_id);
        if (matched) return matched;
      }
      return candidates[0];
    },

    async planRouteOptions(request) {
      return buildFixtureCandidates(request);
    },

    async searchPlaces(query) {
      const keywords = String(query?.keywords ?? "").trim();
      const lower = keywords.toLowerCase();
      const matched = FIXTURE_PLACES.filter((entry) => {
        if (entry.name.toLowerCase().includes(lower) || lower.includes(entry.name.toLowerCase())) {
          return true;
        }
        return entry.aliases.some(
          (alias) => alias.toLowerCase().includes(lower) || lower.includes(alias.toLowerCase()),
        );
      }).map((entry) => {
        const place = {
          id: entry.id,
          name: entry.name,
          address: entry.address,
          city: entry.city,
          district: entry.district,
          display_area: [entry.city, entry.district].filter(Boolean).join(" · "),
          location: { ...entry.location },
        };
        if (query?.origin) {
          place.distance_m = distanceMetres(query.origin, entry.location);
        }
        return place;
      });

      return {
        protocol_version: 1,
        query: keywords,
        places: matched,
      };
    },

    async searchCities({ keywords } = {}) {
      const lower = String(keywords ?? "").trim().toLowerCase();
      const catalog = [
        { id: "370100", name: "济南市", detail: "全市范围", bounds_wgs84: [116.75, 36.45, 117.35, 36.85] },
        { id: "371300", name: "临沂市", detail: "全市范围", bounds_wgs84: [118.10, 34.90, 118.60, 35.30] },
        { id: "110000", name: "北京市", detail: "全市范围", bounds_wgs84: [116.15, 39.75, 116.65, 40.10] },
        { id: "osaka-jp", name: "Osaka", detail: "Osaka Prefecture, Japan", bounds_wgs84: [135.38, 34.58, 135.65, 34.78] },
      ];
      return {
        cities: catalog.filter(
          (city) => city.name.toLowerCase().includes(lower) || lower.includes(city.name.toLowerCase()),
        ),
      };
    },
  };
}

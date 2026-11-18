import assert from "node:assert/strict";
import test from "node:test";

import {
  createAutoProvider,
  createGoogleProvider,
  decodeGooglePolyline,
} from "../src/google-provider.js";

// Encoded polyline from (38.5, -120.2) -> (40.7, -120.95) -> (43.252, -126.453)
const SAMPLE_ENCODED_POLYLINE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

test("decodes Google encoded polylines into WGS84 coordinates", () => {
  const decoded = decodeGooglePolyline(SAMPLE_ENCODED_POLYLINE);
  assert.equal(decoded.length, 3);
  assert.ok(Math.abs(decoded[0].latitude_deg - 38.5) < 1e-5);
  assert.ok(Math.abs(decoded[0].longitude_deg - -120.2) < 1e-5);
  assert.ok(Math.abs(decoded[2].latitude_deg - 43.252) < 1e-5);
  assert.ok(Math.abs(decoded[2].longitude_deg - -126.453) < 1e-5);
});

test("plans WGS84 overseas routes via Google Routes v2 with TWO_WHEELER to DRIVE fallback", async () => {
  const seenBodies = [];
  const provider = createGoogleProvider({
    key: "google-test-key",
    travelMode: "TWO_WHEELER",
    clock: () => 1700000000777,
    fetchImpl: async (url, init) => {
      assert.equal(init.headers["X-Goog-Api-Key"], "google-test-key");
      const body = JSON.parse(init.body);
      seenBodies.push(body);
      if (body.travelMode === "TWO_WHEELER") {
        // Simulate country where TWO_WHEELER returns empty routes
        return Response.json({});
      }
      return Response.json({
        routes: [
          {
            distanceMeters: 4820,
            duration: "540s",
            polyline: { encodedPolyline: SAMPLE_ENCODED_POLYLINE },
            legs: [
              {
                steps: [
                  {
                    distanceMeters: 2100,
                    navigationInstruction: {
                      maneuver: "DEPART",
                      instructions: "Head east on Honmachi Dori",
                    },
                  },
                  {
                    distanceMeters: 2720,
                    navigationInstruction: {
                      maneuver: "TURN_LEFT",
                      instructions: "Turn left onto Tanimachi Suji",
                    },
                  },
                ],
              },
            ],
            travelAdvisory: {
              speedReadingIntervals: [
                { startPolylinePointIndex: 0, endPolylinePointIndex: 1, speed: "NORMAL" },
                { startPolylinePointIndex: 1, endPolylinePointIndex: 2, speed: "SLOW" },
              ],
            },
          },
        ],
      });
    },
  });

  const route = await provider.planRoute({
    protocol_version: 1,
    request_id: 9,
    route_mode: "driving",
    route_preference: "avoid_highway",
    is_reroute: false,
    origin: { coordinate_system: "WGS84", longitude_deg: 135.5023, latitude_deg: 34.6937 },
    destination: { coordinate_system: "WGS84", longitude_deg: 135.5259, latitude_deg: 34.6873 },
  });

  assert.equal(seenBodies.length, 2);
  assert.equal(seenBodies[0].travelMode, "TWO_WHEELER");
  assert.equal(seenBodies[1].travelMode, "DRIVE");
  assert.equal(seenBodies[1].routeModifiers.avoidHighways, true);
  assert.equal(route.provider, "google");
  assert.equal(route.coordinate_system, "WGS84");
  assert.equal(route.route_preference, "avoid_highway");
  assert.equal(route.total_distance_m, 4820);
  assert.equal(route.total_duration_s, 540);
  assert.equal(route.maneuvers[0].type, "left");
  assert.equal(route.maneuvers.at(-1).type, "arrive");
  assert.equal(route.traffic.length, 2);
});

test("searches Google Places (New) and cities in WGS84 and dispatches auto mode by region", async () => {
  const google = createGoogleProvider({
    key: "google-test-key",
    fetchImpl: async () =>
      Response.json({
        places: [
          {
            id: "osaka-castle",
            displayName: { text: "Osaka Castle" },
            formattedAddress: "1-1 Osakajo, Chuo Ward, Osaka",
            location: { latitude: 34.687315, longitude: 135.525955 },
            viewport: {
              low: { latitude: 34.67, longitude: 135.5 },
              high: { latitude: 34.7, longitude: 135.55 },
            },
            addressComponents: [
              { longText: "Osaka", types: ["locality"] },
              { longText: "Japan", types: ["country"] },
            ],
          },
        ],
      }),
  });

  let amapCalls = 0;
  const amap = {
    async planRoute() {
      amapCalls += 1;
      return { route_id: "amap-mainland", provider: "amap", coordinate_system: "GCJ-02" };
    },
    async planRouteOptions() {
      amapCalls += 1;
      return [{ route_id: "amap-mainland", provider: "amap", coordinate_system: "GCJ-02" }];
    },
    async searchPlaces() {
      amapCalls += 1;
      return { protocol_version: 1, query: "济南西站", places: [{ id: "jnw", name: "济南西站" }] };
    },
    async searchCities() {
      amapCalls += 1;
      return { cities: [{ id: "370100", name: "济南市", bounds_wgs84: [116.8, 36.5, 117.3, 36.8] }] };
    },
  };

  const auto = createAutoProvider({ amap, google });

  const mainlandRoute = await auto.planRoute({
    origin: { coordinate_system: "WGS84", longitude_deg: 118.3564, latitude_deg: 35.1047 },
    destination: { coordinate_system: "WGS84", longitude_deg: 116.8913, latitude_deg: 36.6691 },
  });
  assert.equal(mainlandRoute.provider, "amap");
  assert.equal(amapCalls, 1);

  const places = await auto.searchPlaces({
    keywords: "Osaka Castle",
    origin: { coordinate_system: "WGS84", longitude_deg: 135.5, latitude_deg: 34.69 },
  });
  assert.equal(places.places[0].name, "Osaka Castle");
  assert.equal(places.places[0].location.coordinate_system, "WGS84");

  const cities = await auto.searchCities({ keywords: "Osaka" });
  assert.equal(cities.cities[0].name, "Osaka Castle");
  assert.deepEqual(cities.cities[0].bounds_wgs84, [135.5, 34.67, 135.55, 34.7]);
});

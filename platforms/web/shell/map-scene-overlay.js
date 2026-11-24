(function () {
  "use strict";

  // Must match moto::nav::RoadContextClass / BuildingContextClass.
  const ROAD_CLASS = Object.freeze({
    motorway: 0,
    primary: 1,
    secondary: 2,
    residential: 3,
    service: 4,
    other: 5,
  });
  // NavSnapshot capacities (shared/nav_core/nav_core.hpp).
  const MAX_ROADS = 24;
  const MAX_ROAD_POINTS = 192;
  const MAX_BUILDINGS = 16;
  const MAX_BUILDING_POINTS = 128;

  const BUILDING_CLASS = Object.freeze({
    generic: 0,
    landmark: 1,
    parking: 2,
  });

  function validScene(scene) {
    return (
      (scene?.coordinate_system === "GCJ-02" || scene?.coordinate_system === "WGS84") &&
      Array.isArray(scene.roads) &&
      Array.isArray(scene.buildings)
    );
  }

  function injectSceneIntoRuntime(runtime, scene) {
    if (!runtime?.sceneBegin || !validScene(scene)) return false;
    runtime.sceneBegin(
      Number(scene.scene_revision ?? 1),
      scene.coordinate_system === "WGS84" ? 1 : 0,
    );
    for (const road of scene.roads.slice(0, MAX_ROADS)) {
      const points = Array.isArray(road.points_e6) ? road.points_e6 : [];
      if (points.length < 2) continue;
      runtime.sceneAddRoad(ROAD_CLASS[road.class] ?? ROAD_CLASS.other);
      for (const point of points.slice(0, MAX_ROAD_POINTS)) {
        runtime.sceneAddRoadPoint(Number(point[0]) / 1e6, Number(point[1]) / 1e6);
      }
    }
    for (const building of scene.buildings.slice(0, MAX_BUILDINGS)) {
      const points = Array.isArray(building.points_e6) ? building.points_e6 : [];
      if (points.length < 3) continue;
      runtime.sceneAddBuilding(BUILDING_CLASS[building.class] ?? 0);
      for (const point of points.slice(0, MAX_BUILDING_POINTS)) {
        runtime.sceneAddBuildingPoint(Number(point[0]) / 1e6, Number(point[1]) / 1e6);
      }
    }
    runtime.sceneCommit();
    return true;
  }

  function create({ ring, runtime }) {
    if (!runtime) return null;
    let destroyed = false;

    const sceneUrls = [
      new URL("./fixtures/jinan_map_scene_sample.json", location.href),
      new URL("../../../shared/demo_fixture/jinan_map_scene_sample.json", location.href),
    ];

    (async () => {
      let scene = null;
      for (const url of sceneUrls) {
        try {
          const response = await fetch(url, { cache: "no-store" });
          if (response.ok) {
            scene = await response.json();
            break;
          }
        } catch {
          // Try next fallback location.
        }
      }
      if (destroyed || !scene || !validScene(scene)) return;
      injectSceneIntoRuntime(runtime, scene);
      if (ring instanceof HTMLElement) {
        ring.dataset.sceneRevision = String(scene.scene_revision ?? 1);
      }
      window.__MOTO_MAP_SCENE_QA__ = Object.freeze({
        source: scene.source?.provider ?? "unknown",
        roads: scene.roads.length,
        buildings: scene.buildings.length,
        renderedBy: "lvgl-native",
      });
    })();

    return Object.freeze({
      injectScene(scene) {
        return injectSceneIntoRuntime(runtime, scene);
      },
      clear() {
        runtime.sceneClear?.();
      },
      destroy() {
        destroyed = true;
        runtime.sceneClear?.();
      },
    });
  }

  window.MotoMapSceneOverlay = Object.freeze({ create, injectSceneIntoRuntime });
})();

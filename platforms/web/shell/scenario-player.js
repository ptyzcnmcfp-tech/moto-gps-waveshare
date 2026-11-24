(function () {
  "use strict";

  const MANEUVER = {
    unknown: 0,
    continue: 1,
    slight_left: 2,
    left: 3,
    sharp_left: 4,
    u_turn_left: 5,
    slight_right: 6,
    right: 7,
    sharp_right: 8,
    u_turn_right: 9,
    roundabout: 10,
    exit: 11,
    arrive: 12,
  };
  const TRAFFIC = { unknown: 0, free_flow: 1, slow: 2, congested: 3, severe: 4 };
  const PI = Math.PI;
  const EARTH_R = 6_371_000;

  function toRad(deg) { return (deg * PI) / 180; }
  function toDeg(rad) { return (rad * 180) / PI; }

  function wgs84ToGcj02(lat, lon) {
    if (lon < 73.5 || lon > 135.1 || lat < 18.1 || lat > 53.6) return [lat, lon];
    if (lon >= 124.5 && lat >= 32.5 && lat <= 39.2) return [lat, lon];
    if (lon >= 119.3 && lon <= 122.2 && lat >= 21.8 && lat <= 25.4) return [lat, lon];
    const x = lon - 105;
    const y = lat - 35;
    let dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    dLat += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
    dLat += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
    dLat += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
    let dLon = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    dLon += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
    dLon += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
    dLon += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
    const radLat = toRad(lat);
    let magic = Math.sin(radLat);
    magic = 1 - 0.006693421622965943 * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180) / (((6378245 * (1 - 0.006693421622965943)) / (magic * sqrtMagic)) * PI);
    dLon = (dLon * 180) / ((6378245 / sqrtMagic) * Math.cos(radLat) * PI);
    return [lat + dLat, lon + dLon];
  }

  function distanceM(a, b) {
    const lat = toRad((a[0] + b[0]) * 0.5);
    const north = toRad(b[0] - a[0]) * EARTH_R;
    const east = toRad(b[1] - a[1]) * Math.cos(lat) * EARTH_R;
    return Math.hypot(east, north);
  }

  function bearingDeg(a, b) {
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const dLon = toRad(b[1] - a[1]);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function sampleAlongPolyline(wgsPoints, totalSamples) {
    const cum = [0];
    for (let i = 1; i < wgsPoints.length; i += 1) {
      cum.push(cum[i - 1] + distanceM(wgsPoints[i - 1], wgsPoints[i]));
    }
    const total = cum.at(-1) || 1;
    const samples = [];
    for (let s = 0; s <= totalSamples; s += 1) {
      const target = (s / totalSamples) * total;
      let idx = 1;
      while (idx < cum.length - 1 && cum[idx] < target) idx += 1;
      const seg = cum[idx] - cum[idx - 1];
      const frac = seg > 0 ? (target - cum[idx - 1]) / seg : 0;
      const lat = wgsPoints[idx - 1][0] + (wgsPoints[idx][0] - wgsPoints[idx - 1][0]) * frac;
      const lon = wgsPoints[idx - 1][1] + (wgsPoints[idx][1] - wgsPoints[idx - 1][1]) * frac;
      const hdg = bearingDeg(wgsPoints[idx - 1], wgsPoints[idx]);
      samples.push({
        lat,
        lon,
        speedMps: s === totalSamples ? 0 : 14.5,
        headingDeg: hdg,
        accuracyM: 4.5,
        offsetM: target,
        note: "正常循迹骑行",
      });
    }
    return { samples, totalDistanceM: total };
  }

  function makeGcjRoute(routeId, wgsPoints, maneuvers, traffic, durationS) {
    const polyline = wgsPoints.map(([lat, lon]) => {
      const [gLat, gLon] = wgs84ToGcj02(lat, lon);
      return { latitude_deg: gLat, longitude_deg: gLon };
    });
    let total = 0;
    for (let i = 1; i < wgsPoints.length; i += 1) total += distanceM(wgsPoints[i - 1], wgsPoints[i]);
    return {
      route_id: routeId,
      coordinate_system: "GCJ-02",
      total_distance_m: Math.round(total),
      total_duration_s: durationS,
      generated_at_ms: Date.now(),
      polyline,
      maneuvers,
      traffic,
    };
  }

  const BASE_JINAN_WGS = [
    [36.674804, 117.122449],
    [36.672850, 117.122455],
    [36.670910, 117.122460],
    [36.670900, 117.126100],
    [36.670895, 117.129950],
    [36.667800, 117.129960],
    [36.664920, 117.129970],
  ];

  // Where the rider rides after leaving the planned route (starts where the
  // west-branch samples end).
  const REROUTE_TRACK_WGS = [
    [36.672850, 117.119200],
    [36.669100, 117.119210],
    [36.669090, 117.129960],
    [36.664920, 117.129970],
  ];
  // The replanned route a real router returns: it starts at the rider's
  // position when NavCore asks (a few samples into the west branch), not at
  // the end of the branch, otherwise the new route is itself off-route.
  const REROUTE_JINAN_WGS = [[36.672850, 117.122000], ...REROUTE_TRACK_WGS];

  function vertexOffsetsM(points) {
    const offsets = [0];
    for (let i = 1; i < points.length; i += 1) {
      offsets.push(offsets[i - 1] + distanceM(points[i - 1], points[i]));
    }
    return offsets.map(Math.round);
  }

  function buildScenarioCatalog() {
    const normalTrack = sampleAlongPolyline(BASE_JINAN_WGS, 80);
    normalTrack.samples.push({
      ...normalTrack.samples.at(-1),
      speedMps: 0,
      note: "第二次静止定位确认到达 (Arrived)",
    });

    const baseRoute = makeGcjRoute(
      "sim-jinan-primary",
      BASE_JINAN_WGS,
      [
        { id: 1, type: "left", route_offset_m: 435, road_name: "新泺大街", instruction: "左转进入新泺大街", roundabout_exit: 0 },
        { id: 2, type: "right", route_offset_m: 1105, road_name: "浪潮路", instruction: "右转进入浪潮路", roundabout_exit: 0 },
        { id: 3, type: "arrive", route_offset_m: Math.round(normalTrack.totalDistanceM), road_name: "浪潮路", instruction: "到达浪潮集团总部", roundabout_exit: 0 },
      ],
      [
        { start_offset_m: 0, end_offset_m: 700, level: "free_flow" },
        { start_offset_m: 700, end_offset_m: Math.round(normalTrack.totalDistanceM), level: "slow" },
      ],
      185,
    );

    // 2. Off-route reroute scenario
    const offRouteSamples = [];
    for (let i = 0; i <= 22; i += 1) {
      offRouteSamples.push({ ...normalTrack.samples[i], note: "沿原定路线行驶" });
    }
    for (let i = 1; i <= 10; i += 1) {
      const lon = 117.122455 - i * 0.000325;
      offRouteSamples.push({
        lat: 36.672850,
        lon,
        speedMps: 13.5,
        headingDeg: 270,
        accuracyM: 5,
        note: i < 4 ? "驶入西侧岔路（偏航检测中）" : "已触发偏航自动重算 (Rerouting -> 新路线)",
      });
    }
    const rerouteTrack = sampleAlongPolyline(REROUTE_TRACK_WGS, 45);
    const rerouteOffsets = vertexOffsetsM(REROUTE_JINAN_WGS);
    for (const item of rerouteTrack.samples) {
      offRouteSamples.push({ ...item, note: "沿重规划路线前往终点" });
    }
    offRouteSamples.push({ ...offRouteSamples.at(-1), speedMps: 0, note: "到达终点" });

    const rerouteBundle = makeGcjRoute(
      "sim-jinan-rerouted",
      REROUTE_JINAN_WGS,
      [
        { id: 1, type: "left", route_offset_m: rerouteOffsets[1], road_name: "舜华西路", instruction: "左转进入舜华西路", roundabout_exit: 0 },
        { id: 2, type: "left", route_offset_m: rerouteOffsets[2], road_name: "新泺大街", instruction: "左转进入新泺大街", roundabout_exit: 0 },
        { id: 3, type: "right", route_offset_m: rerouteOffsets[3], road_name: "浪潮路", instruction: "右转进入浪潮路", roundabout_exit: 0 },
        { id: 4, type: "arrive", route_offset_m: rerouteOffsets.at(-1), road_name: "浪潮路", instruction: "到达目的地", roundabout_exit: 0 },
      ],
      [{ start_offset_m: 0, end_offset_m: rerouteOffsets.at(-1), level: "free_flow" }],
      165,
    );

    // 3. Tunnel GPS blackout scenario
    const tunnelSamples = normalTrack.samples.map((sample, idx) => {
      if (idx >= 26 && idx <= 44) {
        return {
          ...sample,
          dropFix: true,
          note: "进入隧道：GPS 信号中断（NavCore 5 s 后判定定位过期，保持当前路线不乱跳）",
        };
      }
      if (idx === 45) {
        return { ...sample, accuracyM: 18, note: "驶出隧道：重新捕获卫星，无缝恢复导航" };
      }
      return sample;
    });

    // 4. Parallel service road & rapid U-turn hairpin scenario
    const parallelWgs = [
      [36.674804, 117.122449],
      [36.669000, 117.122449],
      [36.668980, 117.122680], // 20m parallel service road U-turn!
      [36.674200, 117.122680],
    ];
    const parallelTrack = sampleAlongPolyline(parallelWgs, 76);
    parallelTrack.samples.forEach((s, idx) => {
      if (idx >= 34 && idx <= 42) {
        s.note = "高架桥下掉头进平行辅路：航向惩罚防止误吸回对向车道，40Hz 平滑转向无跳动";
      } else {
        s.note = "平行主辅路高精度航向匹配";
      }
    });
    parallelTrack.samples.push({ ...parallelTrack.samples.at(-1), speedMps: 0, note: "到达辅路终点" });
    const parallelRoute = makeGcjRoute(
      "sim-jinan-parallel-uturn",
      parallelWgs,
      [
        { id: 1, type: "u_turn_left", route_offset_m: 645, road_name: "经十路辅路", instruction: "前方桥下掉头进入对向辅路", roundabout_exit: 0 },
        { id: 2, type: "arrive", route_offset_m: Math.round(parallelTrack.totalDistanceM), road_name: "经十路辅路", instruction: "到达目的地", roundabout_exit: 0 },
      ],
      [{ start_offset_m: 0, end_offset_m: Math.round(parallelTrack.totalDistanceM), level: "free_flow" }],
      150,
    );

    // 5. Linyi -> Jinan West Station intercity route (synthetic geometry)
    const linyiWgs = [];
    for (let i = 0; i <= 180; i += 1) {
      const t = i / 180;
      linyiWgs.push([
        35.1047 + (36.6691 - 35.1047) * t,
        118.3564 + (116.8913 - 118.3564) * t + Math.sin(t * PI * 3) * 0.03,
      ]);
    }
    const linyiTrack = sampleAlongPolyline(linyiWgs, 90);
    const linyiKm = Math.round(linyiTrack.totalDistanceM / 1000);
    const linyiTotalM = Math.round(linyiTrack.totalDistanceM);
    linyiTrack.samples.forEach((s) => {
      s.speedMps = 27.8; // 100 km/h
      s.note = `临沂 → 济南西站 ${linyiKm} km 跨城长途（圆屏 >=100 km 整数显示）`;
    });
    linyiTrack.samples[90].speedMps = 0;
    linyiTrack.samples.push({ ...linyiTrack.samples[90], speedMps: 0, note: "到达济南西站落客平台" });
    const linyiRoute = makeGcjRoute(
      "sim-linyi-jinan-west-272km",
      linyiWgs,
      [
        { id: 1, type: "slight_right", route_offset_m: linyiTotalM - 21000, road_name: "殷家林立交", instruction: "靠右驶入济南绕城高速西线", roundabout_exit: 0 },
        { id: 2, type: "exit", route_offset_m: linyiTotalM - 4000, road_name: "齐鲁大道出口", instruction: "从齐鲁大道出口驶出", roundabout_exit: 0 },
        { id: 3, type: "arrive", route_offset_m: linyiTotalM, road_name: "济南西站", instruction: "到达济南西站", roundabout_exit: 0 },
      ],
      [
        { start_offset_m: 0, end_offset_m: linyiTotalM - 25000, level: "free_flow" },
        { start_offset_m: linyiTotalM - 25000, end_offset_m: linyiTotalM, level: "slow" },
      ],
      9800,
    );

    // 6. BLE Disconnect & Reconnect scenario
    const bleSamples = normalTrack.samples.map((sample, idx) => {
      if (idx === 24) return { ...sample, bleState: 0, note: "蓝牙意外断开：圆屏立即清除旧指引，回到 CONNECT PHONE" };
      if (idx > 24 && idx < 34) return { ...sample, skipWhileBleDown: true, note: "蓝牙断开中（无残留旧箭头/旧距离）" };
      if (idx === 34) return { ...sample, bleState: 1, note: "手机后台自动扫描重连中 (CONNECTING)…" };
      if (idx === 37) return { ...sample, bleState: 2, resyncRoute: true, note: "蓝牙重连成功：自动重发当前路线与周边地图，无缝继续导航！" };
      return sample;
    });

    return [
      {
        id: "jinan_ride",
        title: "1. 济南常规骑行（OSM 灰路建筑 + 转向到达）",
        destinationName: "浪潮集团(总部)",
        destination: { lat: BASE_JINAN_WGS.at(-1)[0], lon: BASE_JINAN_WGS.at(-1)[1] },
        route: baseRoute,
        reroute: rerouteBundle,
        samples: normalTrack.samples,
        useJinanScene: true,
      },
      {
        id: "off_route_reroute",
        title: "2. 偏航自动重算（驶离主路 -> 自动切换新路线）",
        destinationName: "浪潮集团(总部)",
        destination: { lat: REROUTE_JINAN_WGS.at(-1)[0], lon: REROUTE_JINAN_WGS.at(-1)[1] },
        route: baseRoute,
        reroute: rerouteBundle,
        samples: offRouteSamples,
        useJinanScene: true,
      },
      {
        id: "tunnel_gps_loss",
        title: "3. 隧道失去定位（5s 丢星提示 -> 出洞平滑恢复）",
        destinationName: "浪潮集团(总部)",
        destination: { lat: BASE_JINAN_WGS.at(-1)[0], lon: BASE_JINAN_WGS.at(-1)[1] },
        route: baseRoute,
        reroute: rerouteBundle,
        samples: tunnelSamples,
        useJinanScene: true,
      },
      {
        id: "parallel_road_hairpin",
        title: "4. 辅路平行与急弯掉头（防对向误吸 + 防跳动）",
        destinationName: "经十路辅路掉头测试点",
        destination: { lat: parallelWgs.at(-1)[0], lon: parallelWgs.at(-1)[1] },
        route: parallelRoute,
        reroute: parallelRoute,
        samples: parallelTrack.samples,
        useJinanScene: true,
      },
      {
        id: "linyi_jinan_long",
        title: `5. 临沂 → 济南西站 ${linyiKm} km（跨城超长路线）`,
        destinationName: "济南西站",
        destination: { lat: linyiWgs.at(-1)[0], lon: linyiWgs.at(-1)[1] },
        route: linyiRoute,
        reroute: linyiRoute,
        samples: linyiTrack.samples,
        useJinanScene: false,
      },
      {
        id: "ble_disconnect_reconnect",
        title: "6. 圆屏蓝牙断线清零与自动重连恢复",
        destinationName: "浪潮集团(总部)",
        destination: { lat: BASE_JINAN_WGS.at(-1)[0], lon: BASE_JINAN_WGS.at(-1)[1] },
        route: baseRoute,
        reroute: rerouteBundle,
        samples: bleSamples,
        useJinanScene: true,
      },
    ];
  }

  function pushBundleToRuntime(runtime, requestId, route) {
    runtime.routeBegin(
      requestId,
      String(route.route_id),
      Number(route.total_distance_m),
      Number(route.total_duration_s),
      Number(route.generated_at_ms || Date.now()),
    );
    runtime.routeSetDatum?.(route.coordinate_system === "WGS84" ? 1 : 0);
    for (const pt of route.polyline) {
      runtime.routeAddPoint(pt.latitude_deg, pt.longitude_deg);
    }
    for (const m of route.maneuvers) {
      runtime.routeAddManeuver(
        m.id,
        MANEUVER[m.type] ?? 0,
        m.route_offset_m,
        m.road_name,
        m.instruction,
        m.roundabout_exit ?? 0,
      );
    }
    for (const t of route.traffic) {
      runtime.routeAddTraffic(t.start_offset_m, t.end_offset_m, TRAFFIC[t.level] ?? 0);
    }
    runtime.routeCommit(Date.now());
  }

  function createPlayer({ getRuntime, getSceneOverlay, onSample }) {
    const catalog = buildScenarioCatalog();
    let currentScenario = catalog[0];
    let index = 0;
    let playing = false;
    let speedMultiplier = 1;
    let timer = 0;
    let simClockMs = Date.now();

    function stopTimer() {
      if (timer) window.clearTimeout(timer);
      timer = 0;
    }

    function applyStep(stepIndex) {
      const runtime = getRuntime();
      if (!runtime) return;
      index = Math.max(0, Math.min(currentScenario.samples.length - 1, stepIndex));
      const sample = currentScenario.samples[index];
      simClockMs += 1000;

      if (typeof sample.bleState === "number") {
        runtime.setPhoneConnection(sample.bleState);
      }
      if (sample.resyncRoute) {
        // Same recovery as the phone app: restart guidance; NavCore then issues
        // a RequestRoute that handleSimRouteRequest answers with its real id.
        runtime.setNetwork(1);
        runtime.start(currentScenario.destination.lat, currentScenario.destination.lon);
        if (currentScenario.useJinanScene) {
          getSceneOverlay?.();
        }
      }

      if (!sample.skipWhileBleDown) {
        if (sample.dropFix) {
          // No fix: only time advances. NavCore's own gnss_stale_after_ms
          // decides when the round screen shows the lost-signal state.
          runtime.tick(simClockMs);
        } else {
          runtime.fix(
            sample.lat,
            sample.lon,
            sample.accuracyM ?? 4.5,
            sample.speedMps ?? 14,
            sample.headingDeg ?? 0,
            simClockMs,
          );
        }
      }

      onSample?.({
        scenario: currentScenario,
        index,
        total: currentScenario.samples.length,
        sample,
        playing,
        speedMultiplier,
      });
    }

    function scheduleNext() {
      stopTimer();
      if (!playing) return;
      const delay = Math.max(45, Math.round(450 / speedMultiplier));
      timer = window.setTimeout(() => {
        if (!playing) return;
        if (index + 1 < currentScenario.samples.length) {
          applyStep(index + 1);
          scheduleNext();
        } else {
          playing = false;
          onSample?.({
            scenario: currentScenario,
            index,
            total: currentScenario.samples.length,
            sample: currentScenario.samples[index],
            playing: false,
            speedMultiplier,
          });
        }
      }, delay);
    }

    function loadScenario(id, { autoPlay = false } = {}) {
      stopTimer();
      playing = false;
      currentScenario = catalog.find((s) => s.id === id) ?? catalog[0];
      index = 0;
      simClockMs = Date.now();

      const runtime = getRuntime();
      if (runtime) {
        runtime.initialize();
        runtime.setPhoneConnection(2);
        runtime.setNetwork(1);
        runtime.setMusicState?.(
          "APPLE MUSIC",
          "公路之歌 (Highway Song)",
          "新裤子 · 骑行歌单",
          1,
          1,
          1,
          0,
        );
        runtime.start(currentScenario.destination.lat, currentScenario.destination.lon);
        const first = currentScenario.samples[0];
        runtime.fix(first.lat, first.lon, 4.5, first.speedMps, first.headingDeg, simClockMs);
        if (!currentScenario.useJinanScene) {
          runtime.sceneClear?.();
        } else {
          getSceneOverlay?.();
        }
        applyStep(0);
      }
      if (autoPlay) {
        playing = true;
        scheduleNext();
      }
      return currentScenario;
    }

    function handleSimRouteRequest(command) {
      const runtime = getRuntime();
      if (!runtime) return false;
      const bundle = command.isReroute ? currentScenario.reroute : currentScenario.route;
      window.setTimeout(() => {
        pushBundleToRuntime(runtime, command.requestId, bundle);
      }, 120);
      return true;
    }

    return Object.freeze({
      catalog,
      loadScenario,
      play() {
        if (index >= currentScenario.samples.length - 1) {
          loadScenario(currentScenario.id, { autoPlay: true });
          return;
        }
        playing = true;
        scheduleNext();
      },
      pause() {
        playing = false;
        stopTimer();
      },
      toggle() {
        if (playing) this.pause();
        else this.play();
        return playing;
      },
      seek(stepIndex) {
        const wasPlaying = playing;
        this.pause();
        loadScenario(currentScenario.id, { autoPlay: false });
        for (let s = 1; s <= stepIndex; s += 1) {
          applyStep(s);
        }
        if (wasPlaying) this.play();
      },
      setSpeed(multiplier) {
        speedMultiplier = Number(multiplier) || 1;
        if (playing) scheduleNext();
      },
      isPlaying: () => playing,
      currentScenario: () => currentScenario,
      handleSimRouteRequest,
    });
  }

  window.MotoScenarioPlayer = Object.freeze({ createPlayer });
})();

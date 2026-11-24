(function () {
  "use strict";

  const NAV_STATE = ["空闲", "等待定位", "路线规划", "导航中", "重新规划", "已到达"];
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
  const IS_LOCAL_HOST = ["127.0.0.1", "localhost"].includes(location.hostname);
  const SEARCH_PARAMS = new URLSearchParams(location.search);
  const API_BASE = (() => {
    const override = SEARCH_PARAMS.get("api");
    if (override) return new URL(override, location.href);
    if (IS_LOCAL_HOST) return new URL("http://127.0.0.1:8787/");
    return new URL("./api/", location.href);
  })();
  const LOCAL_DEMO = IS_LOCAL_HOST && SEARCH_PARAMS.get("demo") === "1";
  const OPEN_SIM_LAB = SEARCH_PARAMS.get("sim") === "1";
  const DEVICE_STATE_PREVIEW = (() => {
    const requested = SEARCH_PARAMS.get("deviceState");
    const states = { offline: 0, connecting: 1, success: 2, ready: 3, planning: 4 };
    return Object.prototype.hasOwnProperty.call(states, requested)
      ? { name: requested, value: states[requested] }
      : null;
  })();
  const LOCAL_TEST_POSITION = (() => {
    if (!IS_LOCAL_HOST) return null;
    const encoded = SEARCH_PARAMS.get("testPosition");
    if (!encoded) return null;
    const [latitude, longitude] = encoded.split(",").map(Number);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { latitude, longitude }
      : null;
  })();

  const state = {
    runtime: null,
    runtimeReady: false,
    backendReady: false,
    backendFixtureMode: false,
    backendProvider: "unknown",
    routeTrafficSupported: false,
    currentPosition: null,
    simulatedOriginLabel: "",
    orientationHeading: null,
    destination: null,
    routePreference: "default",
    routeOptions: [],
    selectedRouteIndex: 0,
    route: null,
    view: "setup",
    navigating: false,
    arrivedAnnounced: false,
    watchId: null,
    wakeLock: null,
    searchController: null,
    searchTimer: 0,
    locationPending: false,
    lastRouteGeneration: 0,
    lastVisibilityPause: false,
    activeRouteRequestId: null,
    activeTrafficRequestId: null,
    nextClientRequestId: 1,
    mapSceneOverlay: null,
    scenarioPlayer: null,
  };

  const elements = {
    setupView: document.querySelector("#setup-view"),
    routeView: document.querySelector("#route-view"),
    navigationView: document.querySelector("#navigation-view"),
    simView: document.querySelector("#sim-view"),
    homeButton: document.querySelector("#home-button"),
    openSimLab: document.querySelector("#open-sim-lab"),
    systemState: document.querySelector("#system-state"),
    systemStateLabel: document.querySelector("#system-state-label"),
    systemStateDetail: document.querySelector("#system-state-detail"),
    locationCard: document.querySelector("#location-card"),
    locationTitle: document.querySelector("#location-title"),
    locationCopy: document.querySelector("#location-copy"),
    locationButton: document.querySelector("#location-button"),
    searchForm: document.querySelector("#search-form"),
    destinationQuery: document.querySelector("#destination-query"),
    clearSearch: document.querySelector("#clear-search"),
    quickSearches: document.querySelector("#quick-searches"),
    searchFeedback: document.querySelector("#search-feedback"),
    placeResults: document.querySelector("#place-results"),
    routeBack: document.querySelector("#route-back"),
    routeDestination: document.querySelector("#route-destination"),
    preferenceChips: document.querySelector("#preference-chips"),
    routeOptionsList: document.querySelector("#route-options-list"),
    routeDuration: document.querySelector("#route-duration"),
    routeDistance: document.querySelector("#route-distance"),
    routeTraffic: document.querySelector("#route-traffic"),
    routeStatus: document.querySelector("#route-status"),
    startNavigation: document.querySelector("#start-navigation"),
    startButtonHint: document.querySelector("#start-button-hint"),
    rideInstrument: document.querySelector("#ride-instrument"),
    previewInstrument: document.querySelector("#preview-instrument"),
    simInstrument: document.querySelector("#sim-instrument"),
    rideDestination: document.querySelector("#ride-destination"),
    rideAlert: document.querySelector("#ride-alert"),
    endNavigation: document.querySelector("#end-navigation"),
    ridePagePills: document.querySelector("#ride-page-pills"),
    remainingDistance: document.querySelector("#remaining-distance"),
    arrivalTime: document.querySelector("#arrival-time"),
    rideConnection: document.querySelector("#ride-connection"),
    wakeState: document.querySelector("#wake-state"),
    locationAccuracy: document.querySelector("#location-accuracy"),
    simBack: document.querySelector("#sim-back"),
    simPagePills: document.querySelector("#sim-page-pills"),
    simScenarioSelect: document.querySelector("#sim-scenario-select"),
    simPlayToggle: document.querySelector("#sim-play-toggle"),
    simSpeedGroup: document.querySelector("#sim-speed-group"),
    simSlider: document.querySelector("#sim-slider"),
    simStepLabel: document.querySelector("#sim-step-label"),
    simStepNote: document.querySelector("#sim-step-note"),
    simStatState: document.querySelector("#sim-stat-state"),
    simStatRem: document.querySelector("#sim-stat-rem"),
    simStatGen: document.querySelector("#sim-stat-gen"),
    simStatOff: document.querySelector("#sim-stat-off"),
    statusDialog: document.querySelector("#status-dialog"),
    dialogBackend: document.querySelector("#dialog-backend"),
    dialogRuntime: document.querySelector("#dialog-runtime"),
    dialogLocation: document.querySelector("#dialog-location"),
    dialogNetwork: document.querySelector("#dialog-network"),
    dialogHint: document.querySelector("#dialog-hint"),
    toast: document.querySelector("#toast"),
    canvas: document.querySelector("#canvas"),
  };

  let placeholderContext = elements.canvas.getContext("2d");
  let toastTimer = 0;

  function drawPlaceholder() {
    if (!placeholderContext) return;
    const context = placeholderContext;
    const scale = elements.canvas.width / 360;
    context.fillStyle = "#050607";
    context.fillRect(0, 0, elements.canvas.width, elements.canvas.height);
    context.save();
    context.scale(scale, scale);
    context.strokeStyle = "#27302f";
    context.lineWidth = 18;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(180, 260);
    context.lineTo(180, 202);
    context.lineTo(146, 165);
    context.lineTo(213, 96);
    context.stroke();
    context.strokeStyle = "#f4f5ef";
    context.lineWidth = 9;
    context.stroke();
    context.fillStyle = "#f4f5ef";
    context.beginPath();
    context.moveTo(180, 177);
    context.lineTo(165, 208);
    context.lineTo(195, 208);
    context.closePath();
    context.fill();
    context.fillStyle = "#74817e";
    context.textAlign = "center";
    context.font = "700 11px ui-monospace, monospace";
    context.fillText("SHARED NAV LOADING", 180, 312);
    context.restore();
  }

  function showToast(message, duration = 2600) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, duration);
  }

  function setFeedback(message, tone = "info") {
    elements.searchFeedback.dataset.tone = tone;
    elements.searchFeedback.textContent = message;
  }

  function setRouteStatus(message, tone = "info") {
    elements.routeStatus.dataset.tone = tone;
    elements.routeStatus.textContent = message;
  }

  function setRideAlert(message) {
    elements.rideAlert.textContent = message;
    elements.rideAlert.hidden = !message;
  }

  function setView(view) {
    state.view = view;
    document.body.dataset.view = view;
    elements.setupView.hidden = view !== "setup";
    elements.routeView.hidden = view !== "route";
    elements.navigationView.hidden = view !== "navigation";
    elements.simView.hidden = view !== "sim";
    const ring = document.querySelector(".screen-ring");
    if (ring && view === "navigation") elements.rideInstrument.append(ring);
    if (ring && view === "route") elements.previewInstrument.append(ring);
    if (ring && view === "sim") elements.simInstrument.append(ring);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function syncPagePills(pageIndex) {
    for (const container of [elements.ridePagePills, elements.simPagePills]) {
      if (!container) continue;
      for (const btn of container.querySelectorAll("button[data-page]")) {
        btn.classList.toggle("is-active", Number(btn.dataset.page) === pageIndex);
      }
    }
  }

  function updateSystemState() {
    let label = "可以导航";
    let detail = state.backendFixtureMode ? "模拟网关已就绪" : "定位与路线已就绪";
    let tone = "ready";

    if (!state.backendReady) {
      label = state.backendProvider === "offline" ? "网关未连接" : "服务未配置";
      detail =
        state.backendProvider === "offline"
          ? "请启动 backend 服务或打开轨迹回放台"
          : "需配置高德或 Google Key（或使用 fixture）";
      tone = "error";
    } else if (!state.runtimeReady) {
      label = "画面加载中";
      detail = "共享 LVGL 运行时";
      tone = "loading";
    } else if (!state.currentPosition) {
      label = state.locationPending ? "正在定位" : "等待起点";
      detail = "启用定位或点选模拟起点";
      tone = "loading";
    }

    elements.systemState.dataset.tone = tone;
    elements.systemStateLabel.textContent = label;
    elements.systemStateDetail.textContent = detail;
    elements.dialogBackend.textContent = state.backendReady
      ? state.backendFixtureMode
        ? "本地模拟网关 (fixture)"
        : `已连接 (${state.backendProvider})`
      : state.backendProvider === "offline"
        ? "无法连接 127.0.0.1:8787"
        : "未配置 API Key";
    elements.dialogRuntime.textContent = state.runtimeReady ? "LVGL 已运行" : "加载中";
    elements.dialogLocation.textContent = state.currentPosition
      ? state.simulatedOriginLabel
        ? `模拟起点 · ${state.simulatedOriginLabel}`
        : `已定位 · ±${Math.round(state.currentPosition.coords.accuracy)} m`
      : "未设置起点";
    elements.dialogNetwork.textContent = navigator.onLine ? "在线" : "离线";

    const canSearch = state.backendReady && state.runtimeReady && Boolean(state.currentPosition);
    elements.destinationQuery.disabled = !canSearch;
  }

  async function fetchJson(url, options = {}) {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 12000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        ...options,
        signal,
        headers: { Accept: "application/json", ...(options.headers ?? {}) },
      });
    } catch (error) {
      const wrapped = new Error(
        deadline.aborted ? "请求超时，请检查网络或网关服务状态。" : "无法连接到路线网关，请确认后端已启动。",
      );
      wrapped.code = deadline.aborted ? "TIMEOUT" : "NETWORK_ERROR";
      wrapped.retryable = true;
      throw wrapped;
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`服务返回了无法读取的数据（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      const error = new Error(body?.error?.message || `请求失败（HTTP ${response.status}）`);
      error.code = body?.error?.code;
      error.retryable = body?.error?.retryable;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function checkBackend() {
    if (LOCAL_DEMO) {
      state.backendProvider = "fixture";
      state.backendFixtureMode = true;
      state.backendReady = true;
      updateSystemState();
      return;
    }
    try {
      const health = await fetchJson(new URL("healthz", API_BASE), { timeoutMs: 5000 });
      state.backendProvider = String(health.provider ?? "unknown");
      state.routeTrafficSupported = Boolean(health.capabilities?.route_traffic);
      const localFixtureAllowed = IS_LOCAL_HOST && state.backendProvider === "fixture";
      state.backendFixtureMode = localFixtureAllowed;
      state.backendReady = health.ready_for_live_navigation === true || localFixtureAllowed;
      if (!state.backendReady) {
        setFeedback(
          "后端已启动，但尚未配置高德或 Google Key；本地无 Key 测试请用 MOTO_PROVIDER=fixture 启动或进入右上角「轨迹回放台」。",
          "error",
        );
      } else if (localFixtureAllowed) {
        setFeedback("已连接本地模拟网关（无需 API Key），选择模拟起点即可搜索路线。", "info");
      }
    } catch {
      state.backendProvider = "offline";
      state.backendReady = false;
      setFeedback(
        "未检测到本地路线网关 (127.0.0.1:8787)。你仍可直接点击右上角「轨迹回放台」测试全部圆屏场景，或在仓库根目录运行 npm --prefix backend start（默认离线 fixture 模式，无需高德/Google Key）启动完整服务。",
        "error",
      );
    }
    updateSystemState();
  }

  function normalizeHeading(coords) {
    if (Number.isFinite(coords.heading) && Number(coords.speed ?? 0) >= 1) {
      return Number(coords.heading);
    }
    if (Number.isFinite(state.orientationHeading)) return state.orientationHeading;
    return 0;
  }

  function feedPosition(position, { originLabel = "" } = {}) {
    state.currentPosition = position;
    state.simulatedOriginLabel = originLabel;
    state.locationPending = false;
    const accuracy = Math.round(position.coords.accuracy);
    elements.locationCard.classList.add("is-ready");
    elements.locationTitle.textContent = originLabel
      ? `已加载模拟起点：${originLabel}`
      : accuracy <= 30
        ? "位置已锁定"
        : "定位精度较低";
    elements.locationCopy.textContent = originLabel
      ? `WGS84 (${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}) · 可直接搜索目的地`
      : `当前精度约 ±${accuracy} 米${accuracy > 50 ? "，建议到开阔处等待更高精度" : "，持续实时更新"}`;
    elements.locationButton.textContent = originLabel ? "切换真机定位" : "重新定位";
    elements.locationAccuracy.textContent = originLabel ? `模拟 GPS · ${originLabel}` : `GPS ±${accuracy} m`;

    if (state.runtimeReady && state.view !== "sim") {
      const coords = position.coords;
      state.runtime.fix(
        coords.latitude,
        coords.longitude,
        coords.accuracy,
        Number.isFinite(coords.speed) ? coords.speed : 0,
        normalizeHeading(coords),
        position.timestamp || Date.now(),
      );
    }
    updateSystemState();
  }

  function applySimulatedOrigin(lat, lon, label) {
    if (state.watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    feedPosition(
      {
        coords: {
          latitude: lat,
          longitude: lon,
          accuracy: 4,
          speed: 0,
          heading: 0,
        },
        timestamp: Date.now(),
      },
      { originLabel: label },
    );
    if (state.backendReady) {
      setFeedback(`起点已设为「${label}」，请输入或点选下方常用目的地。`, "info");
      elements.destinationQuery.focus({ preventScroll: true });
    } else {
      showToast(`已设起点：${label}（启动后端后可搜索路线，或直接用轨迹回放台）`);
    }
  }

  function locationErrorMessage(error) {
    if (error?.code === 1) return "定位权限被拒绝：请在浏览器地址栏网站设置中允许位置访问，或点击上方「模拟起点」。";
    if (error?.code === 2) return "暂时无法获取系统位置：请检查系统定位开关，或直接使用上方「模拟起点」。";
    if (error?.code === 3) return "定位请求超时：请到开阔处重试，或点选上方「模拟起点」继续体验。";
    return "当前环境不支持浏览器定位，请直接使用上方「模拟起点」。";
  }

  function onLocationError(error) {
    state.locationPending = false;
    elements.locationCard.classList.remove("is-ready");
    elements.locationTitle.textContent = "未获取到实时位置";
    elements.locationCopy.textContent = locationErrorMessage(error);
    elements.locationButton.textContent = "重试定位";
    setFeedback(locationErrorMessage(error), "error");
    updateSystemState();
  }

  function positionOptions() {
    return { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 };
  }

  function startPositionWatch() {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => feedPosition(pos),
      onLocationError,
      positionOptions(),
    );
  }

  function requestLocation() {
    if (LOCAL_TEST_POSITION) {
      applySimulatedOrigin(LOCAL_TEST_POSITION.latitude, LOCAL_TEST_POSITION.longitude, "测试坐标");
      return;
    }
    if (!window.isSecureContext || !navigator.geolocation) {
      onLocationError({ code: 0 });
      return;
    }
    state.locationPending = true;
    elements.locationTitle.textContent = "正在锁定位置…";
    elements.locationCopy.textContent = "请在系统弹窗中允许精确位置权限。";
    elements.locationButton.textContent = "定位中…";
    updateSystemState();
    navigator.geolocation.getCurrentPosition(
      (position) => {
        feedPosition(position);
        startPositionWatch();
        if (state.backendReady && state.runtimeReady) {
          setFeedback("位置已锁定，现在输入目的地。", "info");
          elements.destinationQuery.focus({ preventScroll: true });
        }
      },
      onLocationError,
      positionOptions(),
    );
  }

  function formatDistance(meters) {
    const value = Number(meters);
    if (!Number.isFinite(value)) return "--";
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} km`;
    return `${Math.max(0, Math.round(value))} m`;
  }

  function formatDuration(seconds) {
    const minutes = Math.max(1, Math.round(Number(seconds ?? 0) / 60));
    if (minutes < 60) return `${minutes} 分钟`;
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  }

  function renderPlaces(places) {
    elements.placeResults.replaceChildren();
    for (const [index, place] of places.entries()) {
      const item = document.createElement("li");
      item.className = "place-result";
      const button = document.createElement("button");
      button.type = "button";
      const indexLabel = document.createElement("span");
      indexLabel.className = "result-index";
      indexLabel.textContent = String(index + 1).padStart(2, "0");
      const copy = document.createElement("span");
      copy.className = "result-copy";
      const name = document.createElement("b");
      name.textContent = place.name || "未命名地点";
      const address = document.createElement("span");
      const distText = Number.isFinite(place.distance_m) ? `距你 ${formatDistance(place.distance_m)}` : "";
      address.textContent =
        [distText, place.display_area, place.address].filter(Boolean).join(" · ") || "地址未提供";
      const arrow = document.createElement("span");
      arrow.className = "result-arrow";
      arrow.textContent = "›";
      copy.append(name, address);
      button.append(indexLabel, copy, arrow);
      button.addEventListener("click", () => selectDestination(place));
      item.append(button);
      elements.placeResults.append(item);
    }
  }

  function friendlyGatewayError(error, actionLabel) {
    if (error?.code === "SERVER_MISCONFIGURED") {
      return "网关尚未配置地图服务 Key：请在 backend/.env 配置高德/Google Key 或使用 MOTO_PROVIDER=fixture。";
    }
    if (error?.code === "RATE_LIMITED" || error?.status === 429) {
      return `${actionLabel}过于频繁（触发限流），请等待几十秒后再试。`;
    }
    if (error?.code === "PROVIDER_TIMEOUT" || error?.code === "TIMEOUT") {
      return `${actionLabel}超时：跨城长路线或弱网下耗时较长，请点击重试。`;
    }
    if (error?.code === "NO_ROUTE") {
      return "未找到可行驾车/摩旅路线：请确认起终点未跨海且不在封闭区域，或切换路线偏好重试。";
    }
    return error?.message || `${actionLabel}失败，请检查网络连接后重试。`;
  }

  async function searchPlaces(rawQuery) {
    const query = String(rawQuery ?? "").trim();
    elements.clearSearch.hidden = query.length === 0;
    if (query.length < 2) {
      if (state.searchController) state.searchController.abort();
      elements.placeResults.replaceChildren();
      setFeedback(query.length ? "请至少输入 2 个字符。" : "输入城市与地点名称，例如：济南西站。", "info");
      return;
    }
    if (!state.backendReady) {
      setFeedback("路线网关尚未就绪，请先启动后端服务或进入右上角「轨迹回放台」。", "error");
      return;
    }

    if (state.searchController) state.searchController.abort();
    state.searchController = new AbortController();
    setFeedback("正在检索目的地…", "loading");
    try {
      const url = new URL("v1/places", API_BASE);
      url.searchParams.set("keywords", query);
      if (state.currentPosition) {
        url.searchParams.set("longitude_deg", String(state.currentPosition.coords.longitude));
        url.searchParams.set("latitude_deg", String(state.currentPosition.coords.latitude));
      }
      const result = await fetchJson(url, { signal: state.searchController.signal });
      const places = Array.isArray(result.places) ? result.places : [];
      renderPlaces(places);
      setFeedback(
        places.length
          ? `找到 ${places.length} 个匹配地点，点击即可预览多条路线`
          : `没有找到“${query}”：建议加上城市名（如“济南西站”），或在模拟模式下尝试“济南奥体中心 / Osaka Castle”。`,
        places.length ? "info" : "error",
      );
    } catch (error) {
      if (error?.name === "AbortError") return;
      elements.placeResults.replaceChildren();
      setFeedback(friendlyGatewayError(error, "地点搜索"), "error");
    }
  }

  function currentFix() {
    if (!state.currentPosition) return null;
    return {
      coordinate_system: "WGS84",
      longitude_deg: state.currentPosition.coords.longitude,
      latitude_deg: state.currentPosition.coords.latitude,
    };
  }

  function selectedDestinationPoint() {
    return state.destination?.location ?? null;
  }

  function feedRouteToRuntime(requestId, route) {
    state.runtime.routeBegin(
      requestId,
      String(route.route_id ?? ""),
      Number(route.total_distance_m ?? 0),
      Number(route.total_duration_s ?? 0),
      Number(route.generated_at_ms ?? Date.now()),
    );
    state.runtime.routeSetDatum?.(route.coordinate_system === "WGS84" ? 1 : 0);
    for (const point of route.polyline ?? []) {
      state.runtime.routeAddPoint(Number(point.latitude_deg), Number(point.longitude_deg));
    }
    for (const maneuver of route.maneuvers ?? []) {
      state.runtime.routeAddManeuver(
        Number(maneuver.id ?? 0),
        MANEUVER[maneuver.type] ?? MANEUVER.unknown,
        Number(maneuver.route_offset_m ?? 0),
        String(maneuver.road_name ?? ""),
        String(maneuver.instruction ?? ""),
        Number(maneuver.roundabout_exit ?? 0),
      );
    }
    for (const segment of route.traffic ?? []) {
      state.runtime.routeAddTraffic(
        Number(segment.start_offset_m ?? 0),
        Number(segment.end_offset_m ?? 0),
        TRAFFIC[segment.level] ?? TRAFFIC.unknown,
      );
    }
    state.runtime.routeCommit(Date.now());
  }

  function trafficLabel(route) {
    let severity = 0;
    for (const segment of route?.traffic ?? []) {
      severity = Math.max(severity, TRAFFIC[segment.level] ?? 0);
    }
    return ["未知", "畅通", "缓行", "拥堵", "严重拥堵"][severity];
  }

  function updateRouteSummary(route) {
    elements.routeDuration.textContent = formatDuration(route.total_duration_s);
    elements.routeDistance.textContent = formatDistance(route.total_distance_m);
    elements.routeTraffic.textContent = trafficLabel(route);
  }

  function renderRouteOptions() {
    elements.routeOptionsList.replaceChildren();
    if (state.routeOptions.length <= 0) return;

    state.routeOptions.forEach((candidate, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `route-option-card${idx === state.selectedRouteIndex ? " is-selected" : ""}`;

      const top = document.createElement("div");
      top.className = "route-option-top";
      const title = document.createElement("strong");
      title.textContent = `方案 ${idx + 1} · ${formatDuration(candidate.total_duration_s)}`;
      const dist = document.createElement("span");
      dist.textContent = `${formatDistance(candidate.total_distance_m)} · ${trafficLabel(candidate)}`;
      top.append(title, dist);

      const badges = document.createElement("div");
      badges.className = "route-option-badges";
      const addBadge = (text, tone = "neutral") => {
        const tag = document.createElement("em");
        tag.dataset.tone = tone;
        tag.textContent = text;
        badges.append(tag);
      };

      if (candidate.coordinate_system === "WGS84") {
        addBadge("海外 WGS84", "info");
      }
      if (candidate.has_highway) {
        addBadge("含高速 · 注意禁摩政策", "warn");
      } else {
        addBadge("不含高速", "good");
      }
      if (candidate.has_elevated) {
        addBadge("含高架/快速路", "warn");
      }
      if (Number(candidate.toll_yuan) > 0) {
        addBadge(`收费 ¥${candidate.toll_yuan}`, "neutral");
      }
      if (candidate.restriction_active) {
        addBadge("存在限行提示", "warn");
      }

      btn.append(top, badges);
      btn.addEventListener("click", () => applySelectedCandidate(idx));
      elements.routeOptionsList.append(btn);
    });
  }

  function applySelectedCandidate(index) {
    const candidate = state.routeOptions[index];
    if (!candidate || !state.runtime) return;
    state.selectedRouteIndex = index;
    state.route = candidate;
    renderRouteOptions();
    updateRouteSummary(candidate);

    // Re-prime runtime so the LVGL round screen previews the exact chosen candidate!
    state.runtime.start(
      state.destination.location.latitude_deg,
      state.destination.location.longitude_deg,
    );
    if (state.currentPosition) {
      feedPosition(state.currentPosition, { originLabel: state.simulatedOriginLabel });
    }
    const syntheticId = state.activeRouteRequestId || 1;
    state.activeRouteRequestId = null;
    feedRouteToRuntime(syntheticId, candidate);
    elements.startNavigation.disabled = false;
    elements.startButtonHint.textContent = `已选方案 ${index + 1} · 同步圆屏`;
    setRouteStatus(
      candidate.has_highway
        ? `已选方案 ${index + 1}（途经高速，请确认当地摩托车通行规定或切换“不走高速”）。`
        : `已选方案 ${index + 1}（不含高速路段），圆屏与手机路线已完全对齐。`,
      "info",
    );
  }

  async function loadRoutePreviewOptions() {
    const origin = currentFix();
    const destination = selectedDestinationPoint();
    if (!origin || !destination || !state.runtime) return;

    const reqId = (state.nextClientRequestId += 1);
    state.activeRouteRequestId = reqId;
    state.routeOptions = [];
    elements.routeOptionsList.replaceChildren();
    elements.startNavigation.disabled = true;
    setRouteStatus("正在规划多条备选路线…", "info");

    try {
      const body = {
        protocol_version: 1,
        request_id: reqId,
        route_mode: "driving",
        route_preference: state.routePreference,
        origin,
        destination,
        is_reroute: false,
        ...(state.destination?.id ? { destination_poi_id: state.destination.id } : {}),
      };
      const envelope = await fetchJson(new URL("v1/route-options", API_BASE), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 14000,
      });
      if (state.activeRouteRequestId !== reqId) return;
      const routes = Array.isArray(envelope.routes) ? envelope.routes : [];
      if (routes.length === 0) {
        const noRouteError = new Error("未返回可用路线");
        noRouteError.code = "NO_ROUTE";
        throw noRouteError;
      }
      state.routeOptions = routes;
      applySelectedCandidate(0);
    } catch (error) {
      if (state.activeRouteRequestId !== reqId) return;
      state.activeRouteRequestId = null;
      setRouteStatus(friendlyGatewayError(error, "路线规划"), "error");
    }
  }

  async function handleRouteRequest(command) {
    if (state.view === "sim" && state.scenarioPlayer?.handleSimRouteRequest(command)) {
      return;
    }
    // During preview, loadRoutePreviewOptions owns multi-route selection; only
    // let NavCore drive live reroutes or active-ride route recovery.
    if (!state.navigating && !command.isReroute) {
      state.activeRouteRequestId = Number(command.requestId);
      return;
    }
    if (!state.destination || !state.runtime) return;
    state.activeRouteRequestId = Number(command.requestId);
    if (command.isReroute && state.navigating) {
      setRideAlert("检测到偏航，正在按当前偏好重新规划…");
    }

    try {
      const body = {
        protocol_version: 1,
        request_id: command.requestId,
        route_mode: "driving",
        route_preference: state.routePreference,
        origin: {
          coordinate_system: "WGS84",
          longitude_deg: command.origin.longitude,
          latitude_deg: command.origin.latitude,
        },
        destination: {
          coordinate_system: "WGS84",
          longitude_deg: command.destination.longitude,
          latitude_deg: command.destination.latitude,
        },
        is_reroute: Boolean(command.isReroute),
        ...(state.route?.route_id ? { previous_route_id: state.route.route_id } : {}),
        ...(state.destination?.id ? { destination_poi_id: state.destination.id } : {}),
      };
      const envelope = await fetchJson(new URL("v1/routes", API_BASE), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (state.activeRouteRequestId !== Number(command.requestId)) return;
      state.activeRouteRequestId = null;
      state.route = envelope.route;
      feedRouteToRuntime(command.requestId, envelope.route);
      updateRouteSummary(envelope.route);
      if (state.navigating) {
        setRideAlert("");
        showToast(command.isReroute ? "已自动切换到新路线" : "路线已更新");
      }
    } catch (error) {
      if (state.activeRouteRequestId !== Number(command.requestId)) return;
      state.activeRouteRequestId = null;
      state.runtime.routeFailed(command.requestId, error?.retryable === false ? 0 : 1, Date.now());
      if (state.navigating) {
        setRideAlert("重规划暂时失败，继续沿用当前路线；网络恢复后自动重试。");
      }
    }
  }

  async function handleTrafficRequest(command) {
    if (state.view === "sim" || !state.routeTrafficSupported) {
      state.runtime?.trafficFailed(command.requestId, Date.now());
      return;
    }
    const origin = currentFix();
    const destination = selectedDestinationPoint();
    if (!origin || !destination || !state.runtime) {
      state.runtime?.trafficFailed(command.requestId, Date.now());
      return;
    }
    state.activeTrafficRequestId = Number(command.requestId);
    try {
      const body = {
        protocol_version: 1,
        request_id: command.requestId,
        route_mode: "driving",
        route_preference: state.routePreference,
        origin,
        destination,
        is_reroute: false,
        previous_route_id: command.routeId,
        ...(state.destination?.id ? { destination_poi_id: state.destination.id } : {}),
      };
      const envelope = await fetchJson(new URL("v1/routes", API_BASE), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (state.activeTrafficRequestId !== Number(command.requestId)) return;
      state.activeTrafficRequestId = null;
      const progress = Math.max(0, Number(state.runtime.getRouteProgress()));
      state.runtime.trafficBegin(
        command.requestId,
        command.routeId,
        Number(envelope.route.total_duration_s ?? 0),
        Date.now(),
      );
      for (const segment of envelope.route.traffic ?? []) {
        state.runtime.trafficAddSegment(
          progress + Number(segment.start_offset_m ?? 0),
          progress + Number(segment.end_offset_m ?? 0),
          TRAFFIC[segment.level] ?? TRAFFIC.unknown,
        );
      }
      state.runtime.trafficCommit();
      elements.routeTraffic.textContent = trafficLabel(envelope.route);
    } catch {
      if (state.activeTrafficRequestId !== Number(command.requestId)) return;
      state.activeTrafficRequestId = null;
      state.runtime.trafficFailed(command.requestId, Date.now());
    }
  }

  function handleMusicCommand(command) {
    const labels = ["播放/暂停", "上一首", "下一首", "已收藏歌曲"];
    showToast(`圆屏音乐控制：${labels[command] ?? "操作已发送"}`);
  }

  function selectDestination(place) {
    if (!state.runtime || !state.currentPosition) {
      showToast("请先启用定位或选择一个模拟起点");
      return;
    }
    state.destination = place;
    state.route = null;
    state.routeOptions = [];
    state.navigating = false;
    state.arrivedAnnounced = false;
    elements.routeDestination.textContent = [place.name, place.display_area].filter(Boolean).join(" · ");
    elements.rideDestination.textContent = place.name || "目的地";
    elements.routeDuration.textContent = "--";
    elements.routeDistance.textContent = "--";
    elements.routeTraffic.textContent = "--";
    elements.startNavigation.disabled = true;
    setView("route");
    state.runtime.setNetwork(navigator.onLine ? 1 : 0);
    loadRoutePreviewOptions();
  }

  async function requestOrientationPermission() {
    if (typeof window.DeviceOrientationEvent === "undefined") return;
    if (typeof window.DeviceOrientationEvent.requestPermission === "function") {
      try {
        const result = await window.DeviceOrientationEvent.requestPermission();
        if (result !== "granted") return;
      } catch {
        return;
      }
    }
    window.addEventListener(
      "deviceorientation",
      (event) => {
        if (Number.isFinite(event.webkitCompassHeading)) {
          state.orientationHeading = Number(event.webkitCompassHeading);
        } else if (event.absolute && Number.isFinite(event.alpha)) {
          state.orientationHeading = (360 - Number(event.alpha)) % 360;
        }
      },
      { passive: true },
    );
  }

  async function acquireWakeLock() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") {
      elements.wakeState.innerHTML = "<i></i> 请保持屏幕常亮";
      return false;
    }
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      elements.wakeState.innerHTML = "<i></i> 屏幕常亮中";
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
        elements.wakeState.innerHTML = "<i></i> 常亮已释放";
      });
      return true;
    } catch {
      elements.wakeState.innerHTML = "<i></i> 请手动保持亮屏";
      return false;
    }
  }

  async function startNavigation() {
    if (!state.route || !state.currentPosition) return;
    state.navigating = true;
    state.arrivedAnnounced = false;
    await Promise.allSettled([requestOrientationPermission(), acquireWakeLock()]);
    setView("navigation");
    setRideAlert("");
  }

  async function cancelNavigation({ confirmEnd = false } = {}) {
    if (confirmEnd && state.navigating && !window.confirm("结束当前导航并返回目的地搜索？")) return;
    state.scenarioPlayer?.pause();
    state.navigating = false;
    state.destination = null;
    state.route = null;
    state.routeOptions = [];
    state.arrivedAnnounced = false;
    state.activeRouteRequestId = null;
    state.activeTrafficRequestId = null;
    state.runtime?.cancel();
    if (state.wakeLock) {
      try { await state.wakeLock.release(); } catch {}
      state.wakeLock = null;
    }
    setRideAlert("");
    setView("setup");
  }

  function openSimulationLab() {
    if (!state.runtimeReady || !state.scenarioPlayer) {
      showToast("圆屏 LVGL 运行时正在加载，请稍候…");
      return;
    }
    state.navigating = false;
    setView("sim");
    const chosen = elements.simScenarioSelect.value || state.scenarioPlayer.catalog[0].id;
    state.scenarioPlayer.loadScenario(chosen, { autoPlay: true });
    elements.simPlayToggle.textContent = "暂停回放";
  }

  function updateRideReadouts() {
    if (!state.runtimeReady || !state.runtime) return;
    const navState = state.runtime.getNavState();
    const remainingDistance = state.runtime.getRemainingDistance();
    const remainingDuration = state.runtime.getRemainingDuration();
    const generation = state.runtime.getRouteGeneration();
    const offRoute = state.runtime.getOffRoute() !== 0;
    const pageIndex = state.runtime.getPage();
    syncPagePills(pageIndex);

    if (state.view === "sim") {
      elements.simStatState.textContent = NAV_STATE[navState] ?? "未知";
      elements.simStatRem.textContent = formatDistance(remainingDistance);
      elements.simStatGen.textContent = `#${generation}`;
      elements.simStatOff.textContent = offRoute ? "偏航重算" : "循迹正常";
      return;
    }

    elements.remainingDistance.textContent = formatDistance(remainingDistance);
    const arrival = new Date(Date.now() + Math.max(0, remainingDuration) * 1000);
    elements.arrivalTime.textContent =
      remainingDuration > 0
        ? arrival.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
        : "--:--";
    elements.rideConnection.textContent = navigator.onLine ? "在线" : "离线";

    if (state.navigating && navState === 4) setRideAlert("已偏离路线，正在重新规划…");
    if (state.navigating && navState === 5 && !state.arrivedAnnounced) {
      state.arrivedAnnounced = true;
      setRideAlert("已到达目的地");
    }

    if (generation !== state.lastRouteGeneration) state.lastRouteGeneration = generation;
    elements.dialogRuntime.textContent = `LVGL 已运行 · ${NAV_STATE[navState] ?? "未知"}`;
  }

  function setupScenarioPlayer() {
    if (!window.MotoScenarioPlayer) return;
    state.scenarioPlayer = window.MotoScenarioPlayer.createPlayer({
      getRuntime: () => state.runtime,
      getSceneOverlay: () => {
        state.mapSceneOverlay?.destroy();
        state.mapSceneOverlay = window.MotoMapSceneOverlay?.create({
          ring: document.querySelector(".screen-ring"),
          runtime: state.runtime,
        }) ?? null;
      },
      onSample({ index, total, sample, playing }) {
        elements.simSlider.max = String(Math.max(1, total - 1));
        elements.simSlider.value = String(index);
        elements.simStepLabel.textContent = `样本 ${index + 1} / ${total}`;
        elements.simStepNote.textContent = sample.note || "";
        elements.simPlayToggle.textContent = playing ? "暂停回放" : "继续回放";
        updateRideReadouts();
      },
    });

    elements.simScenarioSelect.replaceChildren();
    for (const scenario of state.scenarioPlayer.catalog) {
      const opt = document.createElement("option");
      opt.value = scenario.id;
      opt.textContent = scenario.title;
      elements.simScenarioSelect.append(opt);
    }
  }

  function attachRuntime(runtime) {
    state.runtime = runtime;
    state.runtimeReady = true;
    runtime.initialize();
    setupScenarioPlayer();

    if (DEVICE_STATE_PREVIEW) {
      setView("route");
      updateSystemState();
      window.setTimeout(() => runtime.previewPhoneLifecycle(DEVICE_STATE_PREVIEW.value), 0);
      return;
    }

    if (OPEN_SIM_LAB) {
      window.setTimeout(() => openSimulationLab(), 0);
      updateSystemState();
      return;
    }

    if (LOCAL_DEMO) {
      state.navigating = true;
      elements.rideDestination.textContent = "D栋 → 浪潮集团总部";
      setView("navigation");
      updateSystemState();
      window.setTimeout(() => {
        runtime.setPhoneConnection(2);
        runtime.demoScenario(0);
        state.mapSceneOverlay?.destroy();
        state.mapSceneOverlay = window.MotoMapSceneOverlay?.create({
          ring: document.querySelector(".screen-ring"),
          runtime,
        }) ?? null;
      }, 0);
      return;
    }

    window.setTimeout(() => runtime.setPhoneConnection(2), 0);
    runtime.setNetwork(navigator.onLine ? 1 : 0);
    if (LOCAL_TEST_POSITION) {
      applySimulatedOrigin(LOCAL_TEST_POSITION.latitude, LOCAL_TEST_POSITION.longitude, "测试起点");
    } else if (state.currentPosition) {
      feedPosition(state.currentPosition, { originLabel: state.simulatedOriginLabel });
    }
    updateSystemState();
  }

  function claimCanvas() {
    if (!placeholderContext) return elements.canvas;
    const replacement = elements.canvas.cloneNode(false);
    elements.canvas.replaceWith(replacement);
    elements.canvas = replacement;
    placeholderContext = null;
    return replacement;
  }

  function runtimeFailed(message) {
    state.runtimeReady = false;
    elements.dialogRuntime.textContent = message;
    setFeedback(message, "error");
    updateSystemState();
  }

  function networkChanged() {
    state.runtime?.setNetwork(navigator.onLine ? 1 : 0);
    elements.dialogNetwork.textContent = navigator.onLine ? "在线" : "离线";
    elements.rideConnection.textContent = navigator.onLine ? "在线" : "离线";
    if (!navigator.onLine && state.navigating) {
      setRideAlert("网络已断开，继续沿用已缓存路线；恢复后自动刷新。");
    } else if (navigator.onLine && state.navigating) {
      setRideAlert("");
      state.runtime?.tick(Date.now());
    }
  }

  elements.locationButton.addEventListener("click", requestLocation);
  for (const button of document.querySelectorAll("[data-sim-origin]")) {
    button.addEventListener("click", () => {
      const [latText, lonText, label] = button.dataset.simOrigin.split(",");
      applySimulatedOrigin(Number(latText), Number(lonText), label);
    });
  }
  for (const button of elements.quickSearches?.querySelectorAll("[data-quick-query]") ?? []) {
    button.addEventListener("click", () => {
      if (!state.currentPosition) {
        if (button.dataset.quickQuery.includes("Osaka")) {
          applySimulatedOrigin(34.702485, 135.495951, "大阪梅田");
        } else if (button.dataset.quickQuery === "济南西站") {
          applySimulatedOrigin(35.104672, 118.356448, "临沂兰山");
        } else {
          applySimulatedOrigin(36.674804, 117.122449, "济南历下");
        }
      }
      elements.destinationQuery.value = button.dataset.quickQuery;
      searchPlaces(button.dataset.quickQuery);
    });
  }
  elements.preferenceChips?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-pref]");
    if (!button) return;
    state.routePreference = button.dataset.pref;
    for (const peer of elements.preferenceChips.querySelectorAll("button[data-pref]")) {
      peer.classList.toggle("is-active", peer === button);
    }
    if (state.destination) loadRoutePreviewOptions();
  });
  for (const container of [elements.ridePagePills, elements.simPagePills]) {
    container?.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-page]");
      if (!btn || !state.runtime) return;
      const page = Number(btn.dataset.page);
      state.runtime.demoPage(page);
      syncPagePills(page);
    });
  }
  elements.openSimLab?.addEventListener("click", openSimulationLab);
  elements.simBack?.addEventListener("click", () => {
    state.scenarioPlayer?.pause();
    setView("setup");
  });
  elements.simScenarioSelect?.addEventListener("change", () => {
    state.scenarioPlayer?.loadScenario(elements.simScenarioSelect.value, { autoPlay: true });
    elements.simPlayToggle.textContent = "暂停回放";
  });
  elements.simPlayToggle?.addEventListener("click", () => {
    const nowPlaying = state.scenarioPlayer?.toggle();
    elements.simPlayToggle.textContent = nowPlaying ? "暂停回放" : "继续回放";
  });
  elements.simSpeedGroup?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-speed]");
    if (!btn) return;
    for (const peer of elements.simSpeedGroup.querySelectorAll("button[data-speed]")) {
      peer.classList.toggle("is-active", peer === btn);
    }
    state.scenarioPlayer?.setSpeed(Number(btn.dataset.speed));
  });
  elements.simSlider?.addEventListener("input", () => {
    state.scenarioPlayer?.seek(Number(elements.simSlider.value));
  });

  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    window.clearTimeout(state.searchTimer);
    searchPlaces(elements.destinationQuery.value);
  });
  elements.destinationQuery.addEventListener("input", () => {
    window.clearTimeout(state.searchTimer);
    const query = elements.destinationQuery.value;
    elements.clearSearch.hidden = query.length === 0;
    state.searchTimer = window.setTimeout(() => searchPlaces(query), 380);
  });
  elements.clearSearch.addEventListener("click", () => {
    elements.destinationQuery.value = "";
    elements.placeResults.replaceChildren();
    elements.clearSearch.hidden = true;
    setFeedback("输入城市和目的地名称。", "info");
    elements.destinationQuery.focus();
  });
  elements.routeBack.addEventListener("click", () => cancelNavigation());
  elements.startNavigation.addEventListener("click", startNavigation);
  elements.endNavigation.addEventListener("click", () => cancelNavigation({ confirmEnd: true }));
  elements.homeButton.addEventListener("click", () => {
    if (state.view !== "setup") cancelNavigation({ confirmEnd: state.navigating });
  });
  elements.systemState.addEventListener("click", () => elements.statusDialog.showModal());
  window.addEventListener("online", networkChanged);
  window.addEventListener("offline", networkChanged);

  window.MotoNavController = Object.freeze({
    attachRuntime,
    claimCanvas,
    runtimeFailed,
    handleRouteRequest,
    handleTrafficRequest,
    handleMusicCommand,
  });

  drawPlaceholder();
  setView("setup");
  updateSystemState();
  checkBackend();
  window.setInterval(() => {
    if (state.runtimeReady && state.view !== "sim") {
      // A simulated origin models a stationary receiver with a live lock: keep
      // its 1 Hz fix stream going, or NavCore correctly flags GNSS as stale
      // after 5 s. Real geolocation is left to the browser's own stream.
      const coords = state.simulatedOriginLabel ? state.currentPosition?.coords : null;
      if (coords) {
        state.runtime.fix(coords.latitude, coords.longitude, coords.accuracy, 0, Number.NaN, Date.now());
      }
      state.runtime.tick(Date.now());
    }
    updateRideReadouts();
  }, 1000);
})();

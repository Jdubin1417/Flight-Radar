// ===========================================================================
// Flight-Radar — 🛰️ satellites · ✈️ aircraft · 🚢 ships on one 3D globe.
// Aircraft are the FULL global feed (OpenSky /states/all — every plane at once).
// Click a plane for rich details + its route; search to filter the fleet.
// Layers filter in/out with the toggles; zoom is just for navigating.
// ===========================================================================

// --- Icons (inline SVG, nose/bow pointing "up" = north) ---
const PLANE_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24">
     <path fill="#ffd24d" stroke="#7a5a00" stroke-width="0.6"
       d="M12 2 13 9 22 14 22 16 13 13 13 19 16 21 16 22 12 21 8 22 8 21 11 19 11 13 2 16 2 14 11 9Z"/>
   </svg>`);
const SHIP_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24">
     <path fill="#5bd6ff" stroke="#04364a" stroke-width="0.6"
       d="M12 2 15 8 15 14 9 14 9 8Z M5 15 19 15 17 21 7 21Z"/>
   </svg>`);
// Extended-feed planes (FlightRadar24, incl. satellite ADS-B over open ocean)
// get a distinct green so they're obviously "extra" coverage.
const PLANE_SVG_EXT = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24">
     <path fill="#3ce97a" stroke="#0a4a24" stroke-width="0.6"
       d="M12 2 13 9 22 14 22 16 13 13 13 19 16 21 16 22 12 21 8 22 8 21 11 19 11 13 2 16 2 14 11 9Z"/>
   </svg>`);
const planeIcon = `data:image/svg+xml,${PLANE_SVG}`;
const planeIconExt = `data:image/svg+xml,${PLANE_SVG_EXT}`;
const shipIcon = `data:image/svg+xml,${SHIP_SVG}`;

// --- Layer visibility filters (NOT controlled by zoom) ---
const LAYER = { sats: true, planes: true, ships: true };

// --- Trails ---
const TRAIL = { sats: false, planes: false, ships: false };
const TRAIL_SEC = { sats: 20 * 60, planes: 10 * 60, ships: 60 * 60 };
const TRAIL_COL = { sats: '#8ab4ff', planes: '#ffd24d', ships: '#5bd6ff' };
const STALE_MS = 120_000;   // drop objects not heard from in this long
const MIN_TIME = Cesium.JulianDate.fromIso8601('2000-01-01');
const PLANE_SCALE = 0.7, PLANE_SEL_SCALE = 1.3;
// Billboards/points skip the GPU depth test entirely (the globe's depth buffer
// is unreliable for small sprites near the surface — most planes vanish if we
// depth-test them). Far-side-of-the-globe hiding is done analytically instead:
// see cullBehindGlobe(), which runs on a short interval.

let viewer, aircraftLayer, shipLayer, routeDS, trackDS, baseMapLayer;
const aircraft = new Map();    // icao -> { entity, pos, lastSeen, meta, enriched, queued, _detail }
const shipEntities = new Map();// mmsi -> { entity, pos, lastSeen }
const satData = [];            // { entity, satrec, pos }
let aisEnabled = false;
let owmEnabled = false; // OpenWeatherMap key present → global rain overlay available
let extEnabled = false;  // FlightRadar24 extended feed accepted & running
const HOME_ALTITUDE = 2_500_000;
let homeView = { lat: 50.9, lon: 4.5, height: HOME_ALTITUDE };

let SEARCH = '';
let selectedId = null;
let selectedType = null;
let routeDrawnFor = null;
const enrichQueue = [];
let enriching = false;

boot().catch((e) => {
  console.error(e);
  document.getElementById('brand').textContent = 'Failed to start — see console';
});

async function boot() {
  Cesium.Ion.defaultAccessToken = undefined;

  viewer = new Cesium.Viewer('cesiumContainer', {
    baseLayer: Cesium.ImageryLayer.fromProviderAsync(
      Cesium.ArcGisMapServerImageryProvider.fromUrl(
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
      ), {}),
    baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, animation: false,
    timeline: false, infoBox: false, selectionIndicator: false, fullscreenButton: false,
    requestRenderMode: false,
  });
  const referenceLayer = viewer.imageryLayers.addImageryProvider(
    await Cesium.ArcGisMapServerImageryProvider.fromUrl(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer'
    )
  );
  referenceLayer.show = true;

  const scene = viewer.scene;
  scene.globe.enableLighting = true;
  scene.skyAtmosphere.show = true;
  scene.highDynamicRange = false;
  configureCameraController(scene.screenSpaceCameraController);
  viewer.clock.shouldAnimate = true;
  baseMapLayer = viewer.imageryLayers.get(0);
  // Cesium's default double-click locks the camera onto an entity ("tracking")
  // with no obvious way out — a major source of "camera went crazy" reports.
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
    Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  window.viewer = viewer;
  window.__fr = {
    get aircraft() { return aircraft; },
    get ships() { return shipEntities; },
    get sats() { return satData; },
    get track() { return trackDS; },
    get viewer() { return viewer; },
    selectAircraft, selectShip, selectSat, deselect, resetView,
  }; // debug hook
  aircraftLayer = new Cesium.CustomDataSource('aircraft');
  shipLayer = new Cesium.CustomDataSource('ships');
  routeDS = new Cesium.CustomDataSource('routes');
  trackDS = new Cesium.CustomDataSource('track');
  viewer.dataSources.add(aircraftLayer);
  viewer.dataSources.add(shipLayer);
  viewer.dataSources.add(routeDS);
  viewer.dataSources.add(trackDS);

  const start = await guessHome();
  homeView = { lat: start.lat, lon: start.lon, height: HOME_ALTITUDE };
  resetView(0);

  await loadSatellites();
  setupHover();
  setupSelect();
  setupLayerToggles();
  setupTrailToggles();
  setupMapToggles(referenceLayer);
  setupSearch();
  setupCameraReset();
  setupSettings();
  setupExtendedFeed();
  setupWelcome();

  setInterval(tickSatellites, 1500);
  setInterval(cullBehindGlobe, 400);
  setInterval(pruneEverything, 20_000);
  pollAircraftLoop();
  pollLocalAircraftLoop();
  pollExtLoop();
  pollShipsLoop();

  try {
    const s = await (await fetch('/api/status')).json();
    aisEnabled = s.aisEnabled;
    owmEnabled = s.owmEnabled;
    document.getElementById('aisWarn').classList.toggle('hidden', aisEnabled);
  } catch {}
}

function configureCameraController(controller) {
  if (!controller) return;
  controller.enableCollisionDetection = true;
  controller.minimumZoomDistance = 150;
  controller.maximumZoomDistance = 80_000_000;
  controller.enableZoom = true;
  controller.enableTilt = true;
  controller.enableRotate = true;
  controller.enableTranslate = true;
  controller.enableLook = true;
  controller.inertiaSpin = 0.85;
  controller.inertiaZoom = 0.8;
}

function resetView(duration = 1.2) {
  if (!viewer || !homeView) return;
  viewer.trackedEntity = undefined;
  viewer.camera.cancelFlight();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(homeView.lon, homeView.lat, homeView.height),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
    duration,
  });
}

function setupCameraReset() {
  document.getElementById('resetViewBtn')?.addEventListener('click', () => resetView());
  document.getElementById('camHome')?.addEventListener('click', () => resetView());
  document.getElementById('camIn')?.addEventListener('click', () =>
    viewer.camera.zoomIn(Math.max(500, camHeight() * 0.35)));
  document.getElementById('camOut')?.addEventListener('click', () =>
    viewer.camera.zoomOut(Math.max(500, camHeight() * 0.6)));
  // Straighten up: keep the current spot but face north, looking straight down.
  document.getElementById('camNorth')?.addEventListener('click', () => {
    const center = cameraCenter();
    const h = camHeight();
    viewer.trackedEntity = undefined;
    viewer.camera.cancelFlight();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        center ? center.lon : 0, center ? center.lat : 0, h),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 0.8,
    });
  });
}

// Free base maps: Esri (no token) + NASA GIBS daily true-color imagery, which
// shows the actual clouds photographed from orbit (yesterday UTC, so the
// mosaic is complete around the whole globe).
const esriBase = (name) => () => Cesium.ArcGisMapServerImageryProvider.fromUrl(
  `https://services.arcgisonline.com/ArcGIS/rest/services/${name}/MapServer`);
const BASE_MAPS = {
  imagery: esriBase('World_Imagery'),
  streets: esriBase('World_Street_Map'),
  topo: esriBase('World_Topo_Map'),
  natgeo: esriBase('NatGeo_World_Map'),
  live: async () => {
    const date = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    return new Cesium.UrlTemplateImageryProvider({
      url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
      maximumLevel: 9,
      credit: 'NASA GIBS / VIIRS',
    });
  },
};

function setupMapToggles(referenceLayer) {
  const labelsBtn = document.getElementById('labelsToggle');
  const weatherBtn = document.getElementById('weatherToggle');
  const baseSel = document.getElementById('baseMapSel');
  let baseLoading = false;

  baseSel?.addEventListener('change', async () => {
    const makeProvider = BASE_MAPS[baseSel.value];
    if (!makeProvider || baseLoading) return;
    baseLoading = true;
    try {
      const provider = await makeProvider();
      const next = viewer.imageryLayers.addImageryProvider(provider, 0);
      if (baseMapLayer) viewer.imageryLayers.remove(baseMapLayer, true);
      baseMapLayer = next;
    } catch (e) {
      console.warn('base map switch failed', e);
    } finally { baseLoading = false; }
  });
  let weatherLayer = null;
  let weatherFramePath = null;
  let weatherEnabled = false;
  let weatherRefresh = null;
  let weatherLoading = null;

  if (window.__fr) {
    window.__fr.overlayState = () => ({
      labels: !!referenceLayer?.show,
      weather: !!weatherLayer?.show,
      weatherFramePath,
      imageryLayers: viewer.imageryLayers.length,
    });
  }

  labelsBtn?.classList.toggle('off', !referenceLayer.show);
  labelsBtn?.addEventListener('click', () => {
    referenceLayer.show = !referenceLayer.show;
    labelsBtn.classList.toggle('off', !referenceLayer.show);
  });

  // 🌦 Global rain — OpenWeatherMap tiles via our server proxy. Modeled data,
  // so it covers oceans and countries with no ground radar. Needs a free key.
  const rainBtn = document.getElementById('rainToggle');
  const mapMsg = document.getElementById('mapMsg');
  let rainLayer = null;
  let rainEnabled = false;
  function showMapMsg(text, kind = '') {
    if (!mapMsg) return;
    mapMsg.textContent = text;
    mapMsg.className = kind; // '', 'ok' or 'warn'
    mapMsg.classList.remove('hidden');
  }
  function hideMapMsg() { if (mapMsg) mapMsg.classList.add('hidden'); }

  rainBtn?.addEventListener('click', async () => {
    // Turning the layer OFF.
    if (rainEnabled) {
      rainEnabled = false;
      rainBtn.classList.add('off');
      if (rainLayer) rainLayer.show = false;
      hideMapMsg();
      return;
    }
    // Turning ON but no key yet — send the user to Settings with an explanation.
    if (!owmEnabled) {
      document.getElementById('settingsBtn').click();
      const msg = document.getElementById('setMsg');
      msg.className = 'err';
      msg.textContent = 'Global rain needs a free OpenWeatherMap key — add it below and Save.';
      return;
    }
    // A key is set — probe one tile first so we can report auth/activation
    // problems instead of silently showing a blank layer (a 401 here means the
    // key is wrong or not yet activated, which is otherwise invisible).
    rainBtn.disabled = true;
    showMapMsg('🌦️ Loading global rain…', '');
    let status = 0;
    try { status = (await fetch('/api/owm/0/0/0', { cache: 'no-store' })).status; }
    catch { status = 0; }
    rainBtn.disabled = false;
    if (status !== 200) {
      if (status === 401 || status === 403) {
        showMapMsg(`🌦️ OpenWeatherMap rejected the key (HTTP ${status}). A brand-new key can take ` +
          'up to ~2 hours to activate — try again later, or re-check it in ⚙️ Settings.', 'warn');
      } else if (status === 404) {
        showMapMsg('🌦️ No OpenWeatherMap key set — add one in ⚙️ Settings.', 'warn');
      } else {
        showMapMsg(`🌦️ Global rain unavailable right now (${status || 'network error'}). ` +
          'Try again shortly.', 'warn');
      }
      return; // stay off
    }
    // Key works — enable the layer.
    rainEnabled = true;
    rainBtn.classList.remove('off');
    if (!rainLayer) {
      rainLayer = viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: '/api/owm/{z}/{x}/{y}',
          maximumLevel: 12,
          credit: 'OpenWeatherMap',
        }));
      rainLayer.alpha = 0.85;
      try { viewer.imageryLayers.raiseToTop(referenceLayer); } catch {}
    }
    rainLayer.show = true;
    // Precipitation tiles are transparent wherever it isn't raining, so most of
    // the globe stays clear — say so, or a working layer still looks "broken".
    showMapMsg('🌦️ Global rain on — colored blotches are precipitation; clear areas mean no rain.', 'ok');
    setTimeout(() => { if (rainEnabled) hideMapMsg(); }, 7000);
  });

  weatherBtn?.addEventListener('click', async () => {
    weatherEnabled = !weatherEnabled;
    weatherBtn.classList.toggle('off', !weatherEnabled);
    if (!weatherEnabled) {
      if (weatherLayer) weatherLayer.show = false;
      stopWeatherRefresh();
      return;
    }
    if (weatherLayer) weatherLayer.show = true;
    startWeatherRefresh();
    await loadWeatherLayer().catch((e) => {
      console.warn('Weather radar unavailable', e);
      weatherEnabled = false;
      weatherBtn.classList.add('off');
      stopWeatherRefresh();
    });
  });

  function startWeatherRefresh() {
    if (!weatherRefresh) weatherRefresh = setInterval(() => {
      loadWeatherLayer().catch((e) => console.warn('Weather radar refresh failed', e));
    }, 5 * 60 * 1000);
  }

  function stopWeatherRefresh() {
    if (weatherRefresh) clearInterval(weatherRefresh);
    weatherRefresh = null;
  }

  async function loadWeatherLayer() {
    if (weatherLoading) return weatherLoading;
    weatherLoading = (async () => {
      const res = await fetch('/api/weather', { cache: 'no-store' });
      if (!res.ok) throw new Error(`weather ${res.status}`);
      const data = await res.json();
      const latest = data?.radar?.past?.at(-1);
      if (!data?.host || !latest?.path) throw new Error('weather feed missing radar frames');
      if (latest.path === weatherFramePath && weatherLayer) {
        weatherLayer.show = weatherEnabled;
        return;
      }

      const url = `${data.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`;
      const nextLayer = viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({ url, credit: 'RainViewer' })
      );
      nextLayer.alpha = 0.75;
      nextLayer.show = weatherEnabled;
      if (weatherLayer) viewer.imageryLayers.remove(weatherLayer, false);
      weatherLayer = nextLayer;
      weatherFramePath = latest.path;
      // Keep place/boundary labels readable above the radar tiles.
      try { viewer.imageryLayers.raiseToTop(referenceLayer); } catch {}
    })().finally(() => { weatherLoading = null; });
    return weatherLoading;
  }
}

function guessHome() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ lat: 50.9, lon: 4.5 });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => resolve({ lat: 50.9, lon: 4.5 }),
      { timeout: 4000 }
    );
  });
}

// --- Shared builders for smooth motion + trails --------------------------
function makePos(extrapolateSec) {
  const p = new Cesium.SampledPositionProperty();
  p.setInterpolationOptions({ interpolationDegree: 1, interpolationAlgorithm: Cesium.LinearApproximation });
  p.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
  if (extrapolateSec) {
    p.forwardExtrapolationType = Cesium.ExtrapolationType.EXTRAPOLATE;
    p.forwardExtrapolationDuration = extrapolateSec;
  } else {
    p.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
  }
  return p;
}

function makePath(type) {
  return {
    show: TRAIL[type],
    leadTime: 0,
    trailTime: TRAIL_SEC[type],
    width: type === 'sats' ? 1.5 : 2.5,
    resolution: type === 'sats' ? 20 : 5,
    material: new Cesium.PolylineGlowMaterialProperty({
      glowPower: 0.25,
      color: Cesium.Color.fromCssColorString(TRAIL_COL[type]).withAlpha(0.85),
    }),
  };
}

function pruneSamples(pos, trailSec) {
  const cutoff = Cesium.JulianDate.addSeconds(
    viewer.clock.currentTime, -(trailSec + 30), new Cesium.JulianDate());
  try { pos.removeSamples(new Cesium.TimeInterval({ start: MIN_TIME, stop: cutoff })); } catch {}
}

// --- Far-side culling -----------------------------------------------------
// Our sprites render without a depth test (see note near the top), so anything
// past the horizon would shine through the globe. Hide those analytically.
const cullScratch = new Cesium.Cartesian3();
function cullBehindGlobe() {
  if (!viewer) return;
  const occ = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, viewer.camera.positionWC);
  const t = viewer.clock.currentTime;
  for (const o of aircraft.values()) {
    const p = o.pos.getValue(t, cullScratch);
    const behind = !!p && !occ.isPointVisible(p);
    if (behind !== !!o.behindGlobe) {
      o.behindGlobe = behind;
      o.entity.show = LAYER.planes && !behind && matchesSearch(o.meta);
    }
  }
  for (const o of shipEntities.values()) {
    const p = o.pos.getValue(t, cullScratch);
    const behind = !!p && !occ.isPointVisible(p);
    if (behind !== !!o.behindGlobe) {
      o.behindGlobe = behind;
      o.entity.show = !behind; // layer on/off is handled by shipLayer.show
    }
  }
  for (const s of satData) {
    const p = s.pos.getValue(t, cullScratch);
    const behind = !!p && !occ.isPointVisible(p);
    if (behind !== !!s.behindGlobe) {
      s.behindGlobe = behind;
      s.entity.show = LAYER.sats && !behind && matchesSat(s);
    }
  }
}

function pruneEverything() {
  const now = Date.now();
  const planeKeep = TRAIL.planes ? TRAIL_SEC.planes : 90; // keep samples small when no trail
  for (const [id, o] of aircraft) {
    if (now - o.lastSeen > STALE_MS) {
      if (id === selectedId) deselect();
      aircraftLayer.entities.remove(o.entity); aircraft.delete(id);
    } else {
      // The selected plane keeps a long history so its trail stays visible.
      const keep = (id === selectedId && selectedType === 'aircraft') ? 900 : planeKeep;
      pruneSamples(o.pos, keep);
    }
  }
  for (const [id, o] of shipEntities) {
    if (now - o.lastSeen > STALE_MS) { shipLayer.entities.remove(o.entity); shipEntities.delete(id); }
    else pruneSamples(o.pos, TRAIL_SEC.ships);
  }
  for (const s of satData) pruneSamples(s.pos, TRAIL.sats ? TRAIL_SEC.sats : 60);
  document.getElementById('cShips').textContent = shipEntities.size;
}

// ===========================================================================
// 🛰️  SATELLITES
// ===========================================================================
const GROUP_COLOR = {
  stations: '#ff5d5d', starlink: '#8ab4ff', 'gps-ops': '#ffd24d',
  science: '#7dffa8', visual: '#e0e0ff',
};

async function loadSatellites() {
  let list = [];
  try { list = (await (await fetch('/api/satellites')).json()).satellites || []; }
  catch (e) { console.warn('satellite load failed', e); return; }

  viewer.entities.suspendEvents();
  for (const s of list) {
    let satrec;
    try { satrec = satellite.twoline2satrec(s.tle1, s.tle2); } catch { continue; }
    if (!satrec || satrec.error) continue;
    const satId = satData.length;
    const color = GROUP_COLOR[s.group] || '#cfd8ff';
    const pos = makePos(0);
    const entity = viewer.entities.add({
      show: false,
      position: pos,
      point: {
        pixelSize: s.group === 'stations' ? 10 : 6, // big enough to actually click
        color: Cesium.Color.fromCssColorString(color),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(1e6, 1.4, 5e7, 0.55),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      path: makePath('sats'),
    });
    entity.satId = satId;
    entity.tt = { title: `🛰️ ${s.name}`, rows: [['group', s.group]] };
    satData.push({ id: satId, entity, satrec, pos, name: s.name, group: s.group });
  }
  viewer.entities.resumeEvents();
  document.getElementById('cSats').textContent = satData.length;
}

function tickSatellites() {
  if (!satData.length) return;
  const jd = viewer.clock.currentTime;
  const now = Cesium.JulianDate.toDate(jd);
  const gmst = satellite.gstime(now);
  for (const s of satData) {
    if (!LAYER.sats) { if (s.entity.show) s.entity.show = false; continue; }
    let pv;
    try { pv = satellite.propagate(s.satrec, now); } catch { continue; }
    if (!pv || !pv.position) { s.entity.show = false; continue; }
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    const lon = satellite.degreesLong(geo.longitude);
    const lat = satellite.degreesLat(geo.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) { s.entity.show = false; continue; }
    s.pos.addSample(jd, Cesium.Cartesian3.fromDegrees(lon, lat, geo.height * 1000));
    s.entity.show = !s.behindGlobe && matchesSat(s);
  }
  if (selectedType === 'sat') {
    const s = getSat(selectedId);
    if (s) fillSatDetail(s);
  }
}

// ===========================================================================
// ✈️  AIRCRAFT  (global) — OpenSky
// ===========================================================================
async function pollAircraftLoop() {
  try {
    aircraftLayer.show = LAYER.planes;
    if (LAYER.planes) await pollAircraft();
  } catch (e) { console.warn(e); }
  setTimeout(pollAircraftLoop, 12_000);
}

async function pollAircraft() {
  const data = await (await fetch('/api/aircraft')).json();
  const list = data.aircraft || [];
  const jd = viewer.clock.currentTime;
  aircraftLayer.entities.suspendEvents(); // batch: ~11k updates per poll
  for (const a of list) upsertAircraft(a, jd);
  aircraftLayer.entities.resumeEvents();
  applyAircraftFilter();
  if (selectedType === 'aircraft' && selectedId && aircraft.has(selectedId)) fillDetail(aircraft.get(selectedId), null);
}

// Upsert one aircraft (from OpenSky global OR a local aggregator) into the
// shared map, keyed by icao24 so the two sources merge/dedupe automatically.
function upsertAircraft(a, jd) {
  const pos3 = Cesium.Cartesian3.fromDegrees(a.lon, a.lat, Math.max(15, a.alt * 0.3048));
  let o = aircraft.get(a.id);
  if (!o) {
    const pos = makePos(120); // dead-reckon through missed polls instead of blinking out
    const entity = aircraftLayer.entities.add({
      position: pos,
      billboard: {
        image: planeIcon, scale: PLANE_SCALE,
        rotation: Cesium.Math.toRadians(-a.track),
        alignedAxis: Cesium.Cartesian3.ZERO,
        scaleByDistance: new Cesium.NearFarScalar(3e5, 0.9, 8e6, 0.32),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      path: TRAIL.planes ? makePath('planes') : undefined,
    });
    entity.acId = a.id;
    o = { entity, pos, lastSeen: 0, meta: {}, enriched: false, lastSampleMs: 0, lastPos3: null,
      lastGroundMs: 0, lastExtMs: 0, extColored: false };
    aircraft.set(a.id, o);
  }
  // Runaway-plane guard. Position is linearly EXTRAPOLATED from the last two
  // samples, so two samples close in time but far apart in space imply an
  // impossible velocity that streaks the icon off the map. With two async feeds
  // (OpenSky + local aggregators) stamping positions of differing real ages,
  // that pairing is common. Enforce a minimum sample spacing, and on a
  // physically impossible jump snap to the new spot instead of streaking to it.
  const nowMs = Date.now();
  const dt = o.lastSampleMs ? (nowMs - o.lastSampleMs) / 1000 : Infinity;
  if (dt >= 2.5) {
    const gapM = o.lastPos3 ? Cesium.Cartesian3.distance(o.lastPos3, pos3) : 0;
    const impliedKt = o.lastPos3 && dt < Infinity ? (gapM / dt) * 1.94384 : 0;
    if (impliedKt > 1500) {
      // Teleport-sized jump (no aircraft flies this fast) → drop history so the
      // bad pair can't form a fast slope; the plane snaps and holds.
      try { o.pos.removeSamples(new Cesium.TimeInterval({ start: MIN_TIME, stop: jd })); } catch {}
    }
    o.pos.addSample(jd, pos3);
    o.lastSampleMs = nowMs;
    o.lastPos3 = pos3;
  }
  // dt < 2.5s: a near-simultaneous sample from the other feed — skip it (adding
  // it would create the steep slope) but still refresh heading/details below.
  o.entity.billboard.rotation = Cesium.Math.toRadians(-a.track);
  o.lastSeen = nowMs;
  // Colour extended-feed-only aircraft (green) so they're easy to spot. A plane
  // counts as "extended" if FR24 is providing it and no ground network (OpenSky
  // /aggregators) has reported it recently — that's exactly the open-ocean /
  // remote traffic the ground feeds physically can't see. Planes over land that
  // both sources see stay the normal yellow. Only swap the image on a real state
  // change to avoid texture churn.
  if (a.source === 'fr24') o.lastExtMs = nowMs; else o.lastGroundMs = nowMs;
  o.meta.source = a.source || o.meta.source;
  const isExt = !!o.lastExtMs && (!o.lastGroundMs || nowMs - o.lastGroundMs > 30_000);
  if (isExt !== o.extColored) {
    o.extColored = isExt;
    o.entity.billboard.image = isExt ? planeIconExt : planeIcon;
  }
  Object.assign(o.meta, {
    icao: a.id, flight: a.flight, squawk: a.squawk,
    alt: a.alt, gs: a.gs, track: a.track, vrate: a.vrate, onGround: a.onGround,
  });
  if (a.country) o.meta.country = a.country; // aggregators omit it — keep OpenSky's
  // Aggregator feeds carry reg/type/owner directly, so fill them in for an
  // instant detail panel. Leave enriched=false so a click still fetches the
  // route + photo from adsbdb.
  if (a.reg && !o.meta.reg) o.meta.reg = a.reg;
  if (a.type && !o.meta.type) o.meta.type = a.type;
  if (a.operator && !o.meta.operator) o.meta.operator = a.operator;
  o.entity.tt = { title: `✈️ ${a.flight}`, rows: [
    ['alt', a.onGround ? 'on ground' : `${a.alt.toLocaleString()} ft`],
    ['speed', `${a.gs} kt`],
    ['country', o.meta.country || '—'],
  ]};
  return o;
}

// Poll the free community aggregators around the current view for dense, fast
// local coverage (planes OpenSky misses). Merged into the same map as OpenSky.
async function pollLocalAircraftLoop() {
  try {
    if (LAYER.planes) await pollLocalAircraft();
  } catch (e) { console.warn('local aircraft poll failed', e); }
  setTimeout(pollLocalAircraftLoop, 6_000);
}

async function pollLocalAircraft() {
  const c = cameraCenter();
  if (!c) return;
  // Cover roughly the visible area, capped at the aggregators' 250 nm limit.
  const distNm = Math.min(250, Math.max(20, Math.round((camHeight() / 1000) * 0.3)));
  const url = `/api/aircraft/local?lat=${c.lat.toFixed(3)}&lon=${c.lon.toFixed(3)}&dist=${distNm}`;
  const data = await (await fetch(url)).json();
  const list = data.aircraft || [];
  if (!list.length) return;
  const jd = viewer.clock.currentTime;
  aircraftLayer.entities.suspendEvents();
  for (const a of list) upsertAircraft(a, jd);
  aircraftLayer.entities.resumeEvents();
  applyAircraftFilter();
  if (selectedType === 'aircraft' && selectedId && aircraft.has(selectedId)) fillDetail(aircraft.get(selectedId), null);
}

// Extended feed (FlightRadar24) — optional, user-accepted. FR24 aggregates
// satellite ADS-B, so this is the only free way to see aircraft over open ocean
// and other spots the ground-receiver networks can't reach. Merged into the
// same map as everything else, so paths/details/filters all work unchanged.
let extEmptyStreak = 0; // consecutive empty polls → likely provider throttling
async function pollExtLoop() {
  try {
    if (extEnabled && LAYER.planes) await pollExt();
  } catch (e) { console.warn('extended feed poll failed', e); }
  // Poll gently: ocean flights move slowly, and a longer interval keeps us well
  // under FR24's per-IP request budget so the feed doesn't get throttled.
  setTimeout(pollExtLoop, 12_000);
}

async function pollExt() {
  const c = cameraCenter();
  if (!c) return;
  // FR24 wants a lat/lon box (n,s,w,e) and caps the result count, so scaling a
  // generous box to the view keeps ocean views useful without flooding.
  const half = Math.max(3, Math.min(45, (camHeight() / 1000) * 0.006));
  const n = Math.min(85, c.lat + half), s = Math.max(-85, c.lat - half);
  const w = c.lon - half * 1.6, e = c.lon + half * 1.6;
  const bounds = `${n.toFixed(2)},${s.toFixed(2)},${w.toFixed(2)},${e.toFixed(2)}`;
  const data = await (await fetch(`/api/aircraft/fr24?bounds=${bounds}`)).json();
  const list = data.aircraft || [];
  const extMsg = document.getElementById('mapMsg');
  if (!list.length) {
    // FR24 keeps replying with a global full_count but an empty aircraft list
    // when it throttles an IP, so a run of empties almost always means the
    // provider is rate-limiting us — say so instead of silently showing nothing.
    if (++extEmptyStreak >= 3 && extMsg) {
      extMsg.textContent = '🌐 Extended feed is on but the provider returned no ' +
        'aircraft right now — it may be temporarily rate-limiting us. It should ' +
        'recover on its own; other data is unaffected.';
      extMsg.className = 'warn';
      extMsg.classList.remove('hidden');
    }
    return;
  }
  if (extEmptyStreak >= 3 && extMsg) extMsg.classList.add('hidden'); // recovered
  extEmptyStreak = 0;
  const jd = viewer.clock.currentTime;
  aircraftLayer.entities.suspendEvents();
  for (const a of list) upsertAircraft(a, jd);
  aircraftLayer.entities.resumeEvents();
  applyAircraftFilter();
  if (selectedType === 'aircraft' && selectedId && aircraft.has(selectedId)) fillDetail(aircraft.get(selectedId), null);
}

// Toggle button + disclaimer for the extended feed. The disclaimer is shown
// EVERY time the user enables it, so the experimental / third-party nature is
// always re-confirmed before any FR24 request is made.
function setupExtendedFeed() {
  const btn = document.getElementById('extToggle');
  const overlay = document.getElementById('extOverlay');
  if (!btn || !overlay) return;
  const accept = document.getElementById('extAccept');
  const cancel = document.getElementById('extCancel');

  function enable() {
    extEnabled = true;
    btn.classList.remove('off');
    pollExt().catch(() => {}); // fetch immediately instead of waiting a full cycle
  }
  function disable() {
    extEnabled = false;
    btn.classList.add('off');
    extEmptyStreak = 0;
    const msg = document.getElementById('mapMsg');
    if (msg && msg.className === 'warn') msg.classList.add('hidden');
    // Leave existing planes alone — the staleness reaper clears any FR24-only
    // aircraft within ~2 min once we stop refreshing them.
  }
  function closeOverlay() { overlay.classList.add('hidden'); }

  btn.addEventListener('click', () => {
    if (extEnabled) { disable(); return; }
    overlay.classList.remove('hidden'); // always confirm before enabling
  });
  accept?.addEventListener('click', () => {
    closeOverlay();
    enable();
  });
  cancel?.addEventListener('click', closeOverlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
}

// First-launch welcome/guide. Shows once automatically (remembered), and can be
// reopened anytime with the ❔ Guide button.
function setupWelcome() {
  const overlay = document.getElementById('welcomeOverlay');
  if (!overlay) return;
  const SEEN_KEY = 'frWelcomeSeen';
  const open = () => overlay.classList.remove('hidden');
  const close = () => { overlay.classList.add('hidden'); localStorage.setItem(SEEN_KEY, '1'); };

  document.getElementById('welcomeClose')?.addEventListener('click', close);
  document.getElementById('welcomeStart')?.addEventListener('click', close);
  document.getElementById('welcomeSettings')?.addEventListener('click', () => {
    close();
    document.getElementById('settingsBtn')?.click();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('helpBtn')?.addEventListener('click', open);

  if (localStorage.getItem(SEEN_KEY) !== '1') open(); // first launch
}

// ===========================================================================
// 🚢  SHIPS  (regional AIS)
// ===========================================================================
async function pollShipsLoop() {
  try {
    shipLayer.show = LAYER.ships;
    const c = cameraCenter();
    if (c && LAYER.ships) await pollShips(c, camHeight());
  } catch (e) { console.warn(e); }
  // No key yet → just check occasionally whether AIS got enabled.
  setTimeout(pollShipsLoop, aisEnabled ? 3000 : 8000);
}

function shipBbox(center, height) {
  let latHalf = Math.max(0.15, height / 110_000);
  let lonHalf = latHalf / Math.max(0.25, Math.cos(Cesium.Math.toRadians(center.lat)));
  try {
    const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if (rect) {
      let lonSpan = Cesium.Math.toDegrees(rect.east - rect.west);
      if (lonSpan < 0) lonSpan += 360;
      latHalf = Math.max(latHalf, Cesium.Math.toDegrees(rect.north - rect.south) * 0.6);
      lonHalf = Math.max(lonHalf, lonSpan * 0.6);
    }
  } catch {}
  latHalf = Math.min(35, latHalf);
  lonHalf = Math.min(70, lonHalf);
  return {
    south: Math.max(-85, center.lat - latHalf),
    north: Math.min(85, center.lat + latHalf),
    west: Math.max(-180, center.lon - lonHalf),
    east: Math.min(180, center.lon + lonHalf),
  };
}

async function pollShips(center, height) {
  const bbox = shipBbox(center, height);
  await fetch('/api/ships/bbox', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bbox),
  }).catch(() => {});

  const data = await (await fetch('/api/ships')).json();
  aisEnabled = data.aisEnabled;
  document.getElementById('aisWarn').classList.toggle('hidden', aisEnabled);
  const jd = viewer.clock.currentTime;
  shipLayer.entities.suspendEvents();
  for (const s of data.ships || []) {
    const lon = num(s.lon), lat = num(s.lat);
    if (lon == null || lat == null) continue;
    const pos3 = Cesium.Cartesian3.fromDegrees(lon, lat, 15);
    const rot = Cesium.Math.toRadians(-(s.heading || s.cog || 0));
    let o = shipEntities.get(s.mmsi);
    if (!o) {
      const pos = makePos(120);
      const entity = shipLayer.entities.add({
        position: pos,
        billboard: {
          image: shipIcon, scale: 0.75, rotation: rot,
          alignedAxis: Cesium.Cartesian3.ZERO,
          // Shrink + fade with distance so thousands of ships don't bury the map.
          scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 5e6, 0.25),
          translucencyByDistance: new Cesium.NearFarScalar(1.5e6, 1.0, 8e6, 0.5),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        path: makePath('ships'),
      });
      entity.shipId = s.mmsi;
      o = { entity, pos, lastSeen: 0, meta: {} };
      shipEntities.set(s.mmsi, o);
    }
    o.entity.shipId = s.mmsi;
    o.pos.addSample(jd, pos3);
    o.entity.billboard.rotation = rot;
    o.lastSeen = Date.now();
    o.meta = { ...s };
    o.entity.tt = { title: `🚢 ${s.name}`, rows: [
      ['speed', `${(s.sog || 0).toFixed(1)} kt`],
      ['course', `${Math.round(s.cog || 0)}°`], ['MMSI', s.mmsi]] };
  }
  shipLayer.entities.resumeEvents();
  if (selectedType === 'ship') {
    const o = getShip(selectedId);
    if (o) fillShipDetail(o);
  }
  document.getElementById('cShips').textContent = shipEntities.size;
}

// ===========================================================================
// Search / filter
// ===========================================================================
function matchesSearch(m) {
  if (!SEARCH) return true;
  const hay = [m.flight, m.country, m.icao, m.squawk, m.type, m.reg, m.operator]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(SEARCH);
}

// Satellites are searchable by name or group (e.g. "iss", "starlink", "gps").
function matchesSat(s) {
  if (!SEARCH) return true;
  return `${s.name || ''} ${s.group || ''}`.toLowerCase().includes(SEARCH);
}

// Update the satellite count to reflect the active filter. The per-tick show
// logic (tickSatellites / cullBehindGlobe) already honours matchesSat.
function applySatFilter() {
  let shown = 0;
  for (const s of satData) if (matchesSat(s)) shown++;
  const el = document.getElementById('cSats');
  if (el) el.textContent = SEARCH ? `${shown}/${satData.length}` : satData.length;
}

function applyAircraftFilter() {
  let shown = 0;
  for (const o of aircraft.values()) {
    const matches = LAYER.planes && matchesSearch(o.meta);
    o.entity.show = matches && !o.behindGlobe;
    if (matches) shown++;
  }
  document.getElementById('cPlanes').textContent = SEARCH ? `${shown}/${aircraft.size}` : aircraft.size;
}

function setupSearch() {
  const input = document.getElementById('search');
  let t;
  input.addEventListener('input', () => {
    SEARCH = input.value.trim().toLowerCase();
    applyAircraftFilter();
    applySatFilter();
    clearTimeout(t);
    if (SEARCH) t = setTimeout(queueEnrichVisible, 300); // enrich so type/reg become searchable
  });
  document.getElementById('searchClear').addEventListener('click', () => {
    input.value = ''; SEARCH = ''; applyAircraftFilter(); applySatFilter();
  });
}

// Lazily enrich the planes currently in view (only while the user is filtering),
// so type/registration/operator become searchable. Gentle on the free adsbdb API.
function inView(o) {
  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return true;
  const p = o.pos.getValue(viewer.clock.currentTime);
  const c = p && Cesium.Cartographic.fromCartesian(p);
  if (!c) return false;
  return c.longitude >= rect.west && c.longitude <= rect.east &&
         c.latitude >= rect.south && c.latitude <= rect.north;
}

function queueEnrichVisible() {
  let added = 0;
  for (const [id, o] of aircraft) {
    if (o.enriched || o.queued || !o.entity.show) continue;
    if (!inView(o)) continue;
    o.queued = true; enrichQueue.push(id); added++;
    if (enrichQueue.length > 300) break;
  }
  if (added) runEnrich();
}

async function runEnrich() {
  if (enriching) return;
  enriching = true;
  while (enrichQueue.length) {
    const id = enrichQueue.shift();
    const o = aircraft.get(id);
    if (!o || o.enriched) continue;
    await enrichOne(id, o);
    applyAircraftFilter();
    await new Promise((r) => setTimeout(r, 250)); // ~4 req/sec
  }
  enriching = false;
}

async function enrichOne(id, o) {
  try {
    const cs = encodeURIComponent(o.meta.flight || '');
    const d = await (await fetch(`/api/flight/${id}?callsign=${cs}`)).json();
    if (d.aircraft) {
      o.meta.type = [d.aircraft.icao_type, d.aircraft.type].filter(Boolean).join(' — ');
      o.meta.reg = d.aircraft.registration || null;
      o.meta.operator = d.aircraft.registered_owner || null;
    }
    o.enriched = true;
    o._detail = d;
    return d;
  } catch { o.enriched = true; return null; }
}

// ===========================================================================
// Selection + detail panel + route line
// ===========================================================================
const MMSI_MIDS = {
  201: ['🇦🇱', 'Albania'], 205: ['🇧🇪', 'Belgium'], 209: ['🇨🇾', 'Cyprus'],
  211: ['🇩🇪', 'Germany'], 215: ['🇲🇹', 'Malta'], 218: ['🇩🇪', 'Germany'],
  219: ['🇩🇰', 'Denmark'], 220: ['🇩🇰', 'Denmark'], 224: ['🇪🇸', 'Spain'],
  226: ['🇫🇷', 'France'], 227: ['🇫🇷', 'France'], 232: ['🇬🇧', 'United Kingdom'],
  235: ['🇬🇧', 'United Kingdom'], 236: ['🇬🇮', 'Gibraltar'], 244: ['🇳🇱', 'Netherlands'],
  245: ['🇳🇱', 'Netherlands'], 246: ['🇳🇱', 'Netherlands'], 247: ['🇮🇹', 'Italy'],
  248: ['🇲🇹', 'Malta'], 249: ['🇲🇹', 'Malta'], 255: ['🇵🇹', 'Portugal'],
  256: ['🇲🇹', 'Malta'], 257: ['🇳🇴', 'Norway'], 258: ['🇳🇴', 'Norway'],
  259: ['🇳🇴', 'Norway'], 261: ['🇵🇱', 'Poland'], 263: ['🇵🇹', 'Portugal'],
  265: ['🇸🇪', 'Sweden'], 266: ['🇸🇪', 'Sweden'], 271: ['🇹🇷', 'Turkey'],
  303: ['🇺🇸', 'United States'], 316: ['🇨🇦', 'Canada'], 338: ['🇺🇸', 'United States'],
  366: ['🇺🇸', 'United States'], 367: ['🇺🇸', 'United States'], 368: ['🇺🇸', 'United States'],
  369: ['🇺🇸', 'United States'], 372: ['🇵🇦', 'Panama'], 373: ['🇵🇦', 'Panama'],
  374: ['🇵🇦', 'Panama'], 412: ['🇨🇳', 'China'], 413: ['🇨🇳', 'China'],
  431: ['🇯🇵', 'Japan'], 440: ['🇰🇷', 'South Korea'], 477: ['🇭🇰', 'Hong Kong'],
  503: ['🇦🇺', 'Australia'], 538: ['🇲🇭', 'Marshall Islands'], 563: ['🇸🇬', 'Singapore'],
  564: ['🇸🇬', 'Singapore'], 565: ['🇸🇬', 'Singapore'], 566: ['🇸🇬', 'Singapore'],
  636: ['🇱🇷', 'Liberia'], 710: ['🇧🇷', 'Brazil'], 725: ['🇨🇱', 'Chile'],
};

function esc(v) {
  return String(v ?? '—').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtFixed(v, digits, unit = '') {
  const n = num(v);
  return n == null ? '—' : `${n.toFixed(digits)}${unit}`;
}

function fmtDeg(v) {
  const n = num(v);
  // 360 (COG) and 511 (heading) mean "not available" in AIS.
  return n == null || n >= 360 ? '—' : `${Math.round(n)}°`;
}

function countryFromMmsi(mmsi) {
  const mid = String(mmsi ?? '').replace(/\D/g, '').slice(0, 3);
  if (!mid) return '—';
  const hit = MMSI_MIDS[mid];
  return hit ? `${hit[0]} ${hit[1]}` : `MID ${mid}`;
}

function getShip(id) {
  if (shipEntities.has(id)) return shipEntities.get(id);
  const asString = String(id);
  if (shipEntities.has(asString)) return shipEntities.get(asString);
  const asNumber = Number(id);
  return Number.isFinite(asNumber) ? shipEntities.get(asNumber) : undefined;
}

function getSat(id) {
  const asNumber = Number(id);
  return satData.find((s) => String(s.id) === String(id)) ||
    (Number.isInteger(asNumber) ? satData[asNumber] : undefined);
}

// Live trail of the selected plane — same color/width as the fetched flown
// track so the two read as one continuous line behind the aircraft.
const TRACK_COLOR = '#ff9d4d';
function makeSelectedPlanePath() {
  const path = makePath('planes');
  path.show = true;
  path.width = 3;
  path.trailTime = 900;
  path.material = new Cesium.PolylineGlowMaterialProperty({
    glowPower: 0.2,
    color: Cesium.Color.fromCssColorString(TRACK_COLOR).withAlpha(0.95),
  });
  return path;
}

// Live trail of the selected ship. Ship positions are retained for
// TRAIL_SEC.ships (1h) in o.pos regardless of the global Trails toggle (see
// pruneEverything), so a path with that trailTime renders the whole observed
// track the instant the ship is selected and then keeps growing live —
// exactly like the plane trail. AIS offers no free voyage history, so this
// session-accumulated track is the most path we can honestly show for a ship.
const SHIP_TRACK_COLOR = '#5bd6ff';
function makeSelectedShipPath() {
  const path = makePath('ships');
  path.show = true;
  path.width = 3;
  path.trailTime = TRAIL_SEC.ships;
  path.material = new Cesium.PolylineGlowMaterialProperty({
    glowPower: 0.2,
    color: Cesium.Color.fromCssColorString(SHIP_TRACK_COLOR).withAlpha(0.95),
  });
  return path;
}

// Draw a satellite's full orbital path by propagating its SGP4 record across
// one orbital period (half behind, half ahead of "now"). Purely client-side —
// no API call — and richer than the plane's flown track: it shows the entire
// orbit. We propagate one full period in the inertial (ECI) frame, then rotate
// the whole ellipse into the globe's CURRENT orientation with a single gmst.
// Drawing per-point Earth-fixed subpoints instead would smear a high orbit
// (e.g. GPS, whose 12 h period lets Earth rotate 180°) into a weird pretzel;
// the snapshot keeps it a clean closed ring that the live marker sits on.
const SAT_TRACK_COLOR = '#8ab4ff';
function drawSatOrbit(s) {
  const noRadPerMin = s.satrec && s.satrec.no > 0 ? s.satrec.no : null;
  const periodSec = noRadPerMin ? ((Math.PI * 2) / noRadPerMin) * 60 : 92 * 60;
  const half = periodSec / 2;
  const step = Math.max(10, periodSec / 240); // ~240 samples around the orbit
  const baseMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
  // One rotation angle for the whole ring: the orbital plane as it is oriented
  // right now, aligned with the globe. (Per-point gmst would draw the rotating-
  // frame ground track instead, which pretzels for high/slow orbits.)
  const gmstNow = satellite.gstime(new Date(baseMs));
  const positions = [];
  for (let dt = -half; dt <= half; dt += step) {
    const t = new Date(baseMs + dt * 1000);
    let pv;
    try { pv = satellite.propagate(s.satrec, t); } catch { continue; }
    if (!pv || !pv.position) continue;
    const ecf = satellite.eciToEcf(pv.position, gmstNow); // km, snapshot rotation
    if (!ecf || !Number.isFinite(ecf.x) || !Number.isFinite(ecf.y) || !Number.isFinite(ecf.z)) continue;
    positions.push(new Cesium.Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000));
  }
  if (positions.length < 2) return;
  trackDS.entities.add({
    polyline: {
      positions,
      width: 2,
      arcType: Cesium.ArcType.NONE,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.2,
        color: Cesium.Color.fromCssColorString(SAT_TRACK_COLOR).withAlpha(0.9),
      }),
    },
  });
}

function restoreSelectionVisuals() {
  if (selectedType === 'aircraft') {
    const o = aircraft.get(selectedId);
    if (o) {
      o.entity.billboard.scale = PLANE_SCALE;
      o.entity.path = TRAIL.planes ? new Cesium.PathGraphics(makePath('planes')) : undefined;
    }
  } else if (selectedType === 'ship') {
    const o = getShip(selectedId);
    if (o) o.entity.path = new Cesium.PathGraphics(makePath('ships'));
  }
}

// Tolerant picking: search a small window around the cursor — planes/ships/sats
// are small targets and often overlap, so a bare scene.pick() misses or hits
// the wrong layer. Of everything in the window, take whatever is closest to
// the cursor.
function pickAt(windowPos, size = 12) {
  let picks = [];
  try { picks = viewer.scene.drillPick(windowPos, 8, size, size) || []; } catch {}
  let best = null, bestDist = Infinity;
  for (const p of picks) {
    const ent = p && p.id;
    if (!ent) continue;
    let type = null;
    if (ent.acId && aircraft.has(ent.acId)) type = 'aircraft';
    else if (ent.shipId != null && getShip(ent.shipId)) type = 'ship';
    else if (ent.satId != null && getSat(ent.satId)) type = 'sat';
    if (!type) continue;
    let d = 0;
    try {
      const pos = ent.position?.getValue(viewer.clock.currentTime);
      const sp = pos && Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, pos);
      d = sp ? Math.hypot(sp.x - windowPos.x, sp.y - windowPos.y) : 0;
    } catch {}
    if (d < bestDist) { bestDist = d; best = { type, ent }; }
  }
  return best;
}

function setupSelect() {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction((click) => {
    const hit = pickAt(click.position);
    if (!hit) return deselect();
    if (hit.type === 'aircraft') selectAircraft(hit.ent.acId);
    else if (hit.type === 'ship') selectShip(hit.ent.shipId);
    else selectSat(hit.ent.satId);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  document.getElementById('panelClose').addEventListener('click', deselect);
}

async function selectAircraft(id) {
  const o = aircraft.get(id);
  if (!o) return;
  if (selectedType || selectedId != null) deselect();
  selectedType = 'aircraft';
  selectedId = id;
  routeDrawnFor = null;
  clearOverlays();
  o.entity.billboard.scale = PLANE_SEL_SCALE;
  o.entity.path = new Cesium.PathGraphics(makeSelectedPlanePath());
  document.getElementById('panel').classList.remove('hidden');
  fillDetail(o, o._detail || null);
  drawFlownTrack(id); // async — draws the real path flown so far
  if (!o.enriched) {
    const d = await enrichOne(id, o);
    if (selectedType === 'aircraft' && selectedId === id) fillDetail(o, d);
  }
}

// Draw the waypoints this plane has actually flown (OpenSky track history) so
// clicking a plane shows its full path immediately — the live trail only
// accumulates from the moment of selection onward.
async function drawFlownTrack(id) {
  try {
    const d = await (await fetch(`/api/track/${encodeURIComponent(id)}`)).json();
    if (selectedType !== 'aircraft' || selectedId !== id) return; // stale response
    const wpts = (d.path || []).filter((w) => Number.isFinite(w?.[1]) && Number.isFinite(w?.[2]));
    if (wpts.length < 2) return;
    const positions = wpts.map((w) =>
      Cesium.Cartesian3.fromDegrees(w[2], w[1], Math.max(30, w[3] || 0)));
    const cur = aircraft.get(id)?.pos.getValue(viewer.clock.currentTime);
    // OpenSky /tracks returns the aircraft's MOST-RECENT track, which can be a
    // PREVIOUS flight if this plane isn't being live-tracked right now. Those
    // waypoints end far from where the plane is now, so drawing them (plus a
    // connector to the live position) paints a wrong line jumping across the
    // map that won't match the route. If the track doesn't reach the plane's
    // current position, treat it as stale and skip it — the live trail and the
    // dashed route still convey the path.
    const STALE_TRACK_M = 500_000; // 500 km — well beyond normal tracking lag
    if (cur) {
      const gap = Cesium.Cartesian3.distance(positions[positions.length - 1], cur);
      if (gap > STALE_TRACK_M) return;
      positions.push(cur);
    }
    if (positions.length < 2) return;
    trackDS.entities.add({
      polyline: {
        positions,
        width: 3,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.2,
          color: Cesium.Color.fromCssColorString(TRACK_COLOR).withAlpha(0.95),
        }),
      },
    });
  } catch (e) { console.warn('track load failed', e); }
}

function selectShip(id) {
  const o = getShip(id);
  if (!o) return;
  if (selectedType || selectedId != null) deselect();
  selectedType = 'ship';
  selectedId = o.entity.shipId;
  routeDrawnFor = null;
  clearOverlays();
  document.getElementById('panel').classList.remove('hidden');
  fillShipDetail(o);
  // Show the ship's accumulated track the same way a selected plane shows its
  // trail. o.pos already holds up to 1h of positions, so this renders at once.
  o.entity.path = new Cesium.PathGraphics(makeSelectedShipPath());
}

function selectSat(id) {
  const s = getSat(id);
  if (!s) return;
  if (selectedType || selectedId != null) deselect();
  selectedType = 'sat';
  selectedId = s.id;
  routeDrawnFor = null;
  clearOverlays();
  document.getElementById('panel').classList.remove('hidden');
  fillSatDetail(s);
  drawSatOrbit(s); // full past+future orbit path
}

function deselect() {
  restoreSelectionVisuals();
  selectedId = null;
  selectedType = null;
  routeDrawnFor = null;
  document.getElementById('panel').classList.add('hidden');
  clearOverlays();
}

function fillDetail(o, d) {
  if (d) o._detail = d; else d = o._detail;
  const m = o.meta;
  const ac = d && d.aircraft;
  const rt = d && d.route;
  const altStr = m.onGround ? 'On ground' : (m.alt ? m.alt.toLocaleString() + ' ft' : '—');
  const sub = [m.type, m.operator].filter(Boolean).join(' · ') || (o.enriched ? 'Type unknown' : 'Loading…');
  const photo = ac && typeof ac.url_photo_thumbnail === 'string' &&
    /^https?:\/\//i.test(ac.url_photo_thumbnail) ? ac.url_photo_thumbnail : null;
  let html = `
    <div class="p-title">✈️ ${esc(m.flight || m.icao)}</div>
    <div class="p-sub">${esc(sub)}</div>
    ${photo ? `<img class="p-photo" src="${esc(photo)}" alt="">` : ''}
    <div class="p-grid">
      <div><span>Altitude</span>${esc(altStr)}</div>
      <div><span>Speed</span>${m.gs != null ? esc(m.gs) + ' kt' : '—'}</div>
      <div><span>Heading</span>${m.track != null ? Math.round(m.track) + '°' : '—'}</div>
      <div><span>Vert. rate</span>${m.vrate != null ? esc(m.vrate) + ' fpm' : '—'}</div>
      <div><span>Registration</span>${esc(m.reg || '—')}</div>
      <div><span>Squawk</span>${esc(m.squawk || '—')}</div>
      <div><span>Country</span>${esc(m.country || '—')}</div>
      <div><span>ICAO24</span>${esc(m.icao)}</div>
    </div>`;
  if (rt && rt.origin && rt.destination) {
    html += `
      <div class="p-route">
        <div class="p-air"><b>${esc(rt.origin.iata_code || rt.origin.icao_code || '?')}</b>
          <span>${esc(rt.origin.municipality || rt.origin.name || '')}</span></div>
        <div class="p-arrow">✈</div>
        <div class="p-air"><b>${esc(rt.destination.iata_code || rt.destination.icao_code || '?')}</b>
          <span>${esc(rt.destination.municipality || rt.destination.name || '')}</span></div>
      </div>
      ${rt.airline ? `<div class="p-airline">${esc(rt.airline.name || '')}</div>` : ''}`;
    if (routeDrawnFor !== selectedId) { drawRoute(rt, o); routeDrawnFor = selectedId; }
  } else if (o.enriched) {
    html += `<div class="p-noroute">No published route for this callsign</div>`;
  }
  document.getElementById('panelBody').innerHTML = html;
}

function fillShipDetail(o) {
  const s = o.meta || {};
  const name = s.name || s.mmsi || 'Unknown vessel';
  document.getElementById('panelBody').innerHTML = `
    <div class="p-title">🚢 ${esc(name)}</div>
    <div class="p-sub">${esc(countryFromMmsi(s.mmsi))}</div>
    <div class="p-grid">
      <div><span>Speed</span>${esc(fmtFixed(s.sog, 1, ' kt'))}</div>
      <div><span>Course</span>${esc(fmtDeg(s.cog))}</div>
      <div><span>Heading</span>${esc(fmtDeg(s.heading))}</div>
      <div><span>MMSI</span>${esc(s.mmsi)}</div>
      <div><span>Country</span>${esc(countryFromMmsi(s.mmsi))}</div>
    </div>`;
}

function satCurrent(s) {
  const now = Cesium.JulianDate.toDate(viewer.clock.currentTime);
  let pv;
  try { pv = satellite.propagate(s.satrec, now); } catch { return null; }
  if (!pv || !pv.position) return null;
  const gmst = satellite.gstime(now);
  const geo = satellite.eciToGeodetic(pv.position, gmst);
  const vel = pv.velocity ? Math.sqrt(
    pv.velocity.x ** 2 + pv.velocity.y ** 2 + pv.velocity.z ** 2) : null;
  return {
    altKm: geo.height,
    velocityKms: vel,
    lat: satellite.degreesLat(geo.latitude),
    lon: satellite.degreesLong(geo.longitude),
  };
}

function fillSatDetail(s) {
  const cur = satCurrent(s) || {};
  const inc = num(s.satrec.inclo);
  const no = num(s.satrec.no);
  const period = no && no > 0 ? (Math.PI * 2) / no : null;
  document.getElementById('panelBody').innerHTML = `
    <div class="p-title">🛰️ ${esc(s.name || 'Satellite')}</div>
    <div class="p-sub">${esc(s.group || '—')}</div>
    <div class="p-grid">
      <div><span>Group</span>${esc(s.group || '—')}</div>
      <div><span>Altitude</span>${esc(cur.altKm != null ? `${cur.altKm.toFixed(0)} km` : '—')}</div>
      <div><span>Velocity</span>${esc(cur.velocityKms != null ? `${cur.velocityKms.toFixed(2)} km/s` : '—')}</div>
      <div><span>Latitude</span>${esc(cur.lat != null ? `${cur.lat.toFixed(3)}°` : '—')}</div>
      <div><span>Longitude</span>${esc(cur.lon != null ? `${cur.lon.toFixed(3)}°` : '—')}</div>
      <div><span>NORAD</span>${esc(s.satrec.satnum || '—')}</div>
      <div><span>Inclination</span>${esc(inc != null ? `${Cesium.Math.toDegrees(inc).toFixed(1)}°` : '—')}</div>
      <div><span>Period</span>${esc(period != null ? `${period.toFixed(1)} min` : '—')}</div>
    </div>`;
}

function clearRoute() { if (routeDS) routeDS.entities.removeAll(); }

// Route + flown track are cleared together on select/deselect, but drawRoute()
// must only clear the route — it runs after enrichment and would otherwise
// wipe a track that was just drawn.
function clearOverlays() {
  clearRoute();
  if (trackDS) trackDS.entities.removeAll();
}

function drawRoute(rt, o) {
  clearRoute();
  const oLon = +rt.origin.longitude, oLat = +rt.origin.latitude;
  const dLon = +rt.destination.longitude, dLat = +rt.destination.latitude;
  if (![oLon, oLat, dLon, dLat].every(Number.isFinite)) return;
  // Dashed = what's LEFT to fly: plane → destination, starting at the plane's
  // live position and altitude. The history behind the plane is the solid
  // orange flown track (drawFlownTrack) — drawing the full origin→destination
  // great-circle as well just produced a second line that never matched the
  // path actually flown.
  const destPos = Cesium.Cartesian3.fromDegrees(dLon, dLat, 30);
  routeDS.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        const p = o && o.pos.getValue(viewer.clock.currentTime);
        return p ? [p, destPos] : [destPos, destPos];
      }, false),
      width: 2.5, arcType: Cesium.ArcType.GEODESIC,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString('#ffd24d').withAlpha(0.9),
        dashLength: 16,
      }),
    },
  });
  for (const [lon, lat, label] of [
    [oLon, oLat, rt.origin.iata_code], [dLon, dLat, rt.destination.iata_code]]) {
    routeDS.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 20),
      point: { pixelSize: 7, color: Cesium.Color.fromCssColorString('#ffd24d'),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: label || '', font: 'bold 12px sans-serif', fillColor: Cesium.Color.WHITE,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3, outlineColor: Cesium.Color.BLACK,
        pixelOffset: new Cesium.Cartesian2(0, -15),
        disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
  }
}

// ===========================================================================
// Layer filters + trail toggles
// ===========================================================================
function setupLayerToggles() {
  document.querySelectorAll('.layer-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.layer;
      LAYER[type] = !LAYER[type];
      btn.classList.toggle('off', !LAYER[type]);
      applyLayer(type);
    });
  });
}

function applyLayer(type) {
  if (type === 'sats') {
    if (!LAYER.sats) for (const s of satData) s.entity.show = false;
  } else if (type === 'planes') {
    aircraftLayer.show = LAYER.planes; applyAircraftFilter();
  } else if (type === 'ships') {
    shipLayer.show = LAYER.ships;
  }
}

function setupTrailToggles() {
  document.querySelectorAll('.trail-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.trail;
      TRAIL[type] = !TRAIL[type];
      btn.classList.toggle('on', TRAIL[type]);
      applyTrail(type);
    });
  });
}

function applyTrail(type) {
  const on = TRAIL[type];
  if (type === 'sats') for (const s of satData) s.entity.path.show = on;
  if (type === 'ships') for (const o of shipEntities.values()) o.entity.path.show = on;
  if (type === 'planes') {
    // Planes are ~10k entities — attach path graphics only while trails are on.
    for (const o of aircraft.values()) {
      if (on) o.entity.path = new Cesium.PathGraphics(makePath('planes'));
      else o.entity.path = undefined;
    }
  }
}

// ===========================================================================
// Helpers + hover tooltip
// ===========================================================================
function camHeight() {
  const carto = viewer.camera.positionCartographic;
  return carto ? carto.height : 1e7;
}
function cameraCenter() {
  const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(
    viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2));
  const p = ray && viewer.scene.globe.pick(ray, viewer.scene);
  const src = p || viewer.camera.position;
  const c = Cesium.Cartographic.fromCartesian(src);
  if (!c) return null;
  return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
}

function setupHover() {
  const tip = document.getElementById('tooltip');
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction((movement) => {
    const hit = pickAt(movement.endPosition, 8);
    const ent = hit && hit.ent;
    if (ent && ent.tt) {
      tip.innerHTML = `<div class="t-title">${ent.tt.title}</div>` +
        ent.tt.rows.map(([k, v]) => `<div class="t-row"><span>${k}:</span> ${v}</div>`).join('');
      tip.style.left = movement.endPosition.x + 'px';
      tip.style.top = movement.endPosition.y + 'px';
      tip.classList.remove('hidden');
      viewer.canvas.style.cursor = 'pointer';
    } else {
      tip.classList.add('hidden');
      viewer.canvas.style.cursor = 'default';
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

function extractOpenSkyCredentials(data) {
  const ids = [];
  const secrets = [];
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function scoreKey(kind, key, path) {
    const k = norm(key);
    const p = norm(path.join(' '));
    if (kind === 'id') {
      if (['clientid', 'openskyclientid', 'openskyid'].includes(k)) return 100;
      if (k.endsWith('clientid')) return 90;
      if (k === 'id' && (p.includes('client') || p.includes('opensky'))) return 65;
    } else {
      if (['clientsecret', 'openskyclientsecret', 'openskysecret'].includes(k)) return 100;
      if (k.endsWith('clientsecret')) return 90;
      if (k === 'secret' && (p.includes('client') || p.includes('opensky'))) return 70;
      if (k.includes('secret')) return 50;
    }
    return 0;
  }

  function addCandidate(list, score, value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (score > 0 && text) list.push({ score, value: text });
  }

  function walk(value, path = []) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, path.concat(String(i))));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      addCandidate(ids, scoreKey('id', key, path), child);
      addCandidate(secrets, scoreKey('secret', key, path), child);
      walk(child, path.concat(key));
    }
  }

  walk(data);
  ids.sort((a, b) => b.score - a.score);
  secrets.sort((a, b) => b.score - a.score);
  return { clientId: ids[0]?.value || '', clientSecret: secrets[0]?.value || '' };
}

// --- Settings modal: let users add API keys from the web app -----------------
function setupSettings() {
  const overlay = document.getElementById('settingsOverlay');
  const open = document.getElementById('settingsBtn');
  const close = document.getElementById('settingsClose');
  const save = document.getElementById('settingsSave');
  const msg = document.getElementById('setMsg');
  const aisIn = document.getElementById('setAis');
  const idIn = document.getElementById('setOskyId');
  const secIn = document.getElementById('setOskySecret');
  const owmIn = document.getElementById('setOwm');
  const aisStatus = document.getElementById('setAisStatus');
  const oskyStatus = document.getElementById('setOskyStatus');
  const owmStatus = document.getElementById('setOwmStatus');
  const oskyDropzone = document.getElementById('oskyDropzone');
  const oskyFile = document.getElementById('oskyFile');

  async function refreshStatus() {
    try {
      const s = await (await fetch('/api/settings')).json();
      aisStatus.textContent = s.aisstream.set ? `set (${s.aisstream.hint})` : 'not set';
      aisStatus.classList.toggle('on', s.aisstream.set);
      oskyStatus.textContent = s.opensky.set ? `authenticated (${s.opensky.idHint})` : 'anonymous';
      oskyStatus.classList.toggle('on', s.opensky.set);
      owmStatus.textContent = s.owm?.set ? `set (${s.owm.hint})` : 'not set';
      owmStatus.classList.toggle('on', !!s.owm?.set);
      owmEnabled = !!s.owm?.set;
      // Keys already set stay hidden — placeholder keeps the field name so you
      // still know what each box is for, and notes that a value is saved.
      aisIn.placeholder = s.aisstream.set ? 'AISSTREAM_API_KEY — saved, type to replace' : 'AISSTREAM_API_KEY';
      idIn.placeholder = s.opensky.set ? 'OPENSKY_CLIENT_ID — saved, type to replace' : 'OPENSKY_CLIENT_ID';
      secIn.placeholder = s.opensky.set ? 'OPENSKY_CLIENT_SECRET — saved, type to replace' : 'OPENSKY_CLIENT_SECRET';
      owmIn.placeholder = s.owm?.set ? 'OWM_API_KEY — saved, type to replace' : 'OWM_API_KEY';
    } catch {}
  }

  function show() { msg.textContent = ''; msg.className = '';
    aisIn.value = idIn.value = secIn.value = owmIn.value = '';
    refreshStatus(); overlay.classList.remove('hidden'); }
  function hide() { overlay.classList.add('hidden'); }

  function showDropError(text) {
    msg.className = 'err';
    msg.textContent = text;
  }

  async function readFileText(file) {
    if (file.text) return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.readAsText(file);
    });
  }

  async function loadOpenSkyFile(file) {
    if (!file) return;
    try {
      const text = await readFileText(file);
      const parsed = JSON.parse(text);
      const creds = extractOpenSkyCredentials(parsed);
      if (!creds.clientId || !creds.clientSecret) {
        showDropError('Could not find clientId and clientSecret in that JSON file.');
        return;
      }
      idIn.value = creds.clientId;
      secIn.value = creds.clientSecret;
      msg.className = 'ok';
      msg.textContent = `Loaded credentials for ${creds.clientId} — click Save.`;
    } catch (e) {
      showDropError('Please choose a valid OpenSky credentials JSON file.');
      console.warn('OpenSky credentials import failed', e);
    }
  }

  open.addEventListener('click', show);
  close.addEventListener('click', hide);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hide(); });
  for (const type of ['dragenter', 'dragover', 'drop']) {
    overlay.addEventListener(type, (e) => {
      if (!overlay.classList.contains('hidden')) e.preventDefault();
    });
  }
  if (oskyDropzone && oskyFile) {
    oskyDropzone.addEventListener('click', () => oskyFile.click());
    oskyDropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        oskyFile.click();
      }
    });
    oskyDropzone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      oskyDropzone.classList.add('dragover');
    });
    oskyDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      oskyDropzone.classList.add('dragover');
    });
    oskyDropzone.addEventListener('dragleave', () => oskyDropzone.classList.remove('dragover'));
    oskyDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      oskyDropzone.classList.remove('dragover');
      loadOpenSkyFile(e.dataTransfer?.files?.[0]);
    });
    oskyFile.addEventListener('change', () => {
      loadOpenSkyFile(oskyFile.files?.[0]);
      oskyFile.value = '';
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) hide();
  });

  save.addEventListener('click', async () => {
    // Only send fields the user actually typed into — omitted keys are left intact.
    const body = {};
    if (aisIn.value.trim()) body.AISSTREAM_API_KEY = aisIn.value.trim();
    if (idIn.value.trim()) body.OPENSKY_CLIENT_ID = idIn.value.trim();
    if (secIn.value.trim()) body.OPENSKY_CLIENT_SECRET = secIn.value.trim();
    if (owmIn.value.trim()) body.OWM_API_KEY = owmIn.value.trim();
    if (!Object.keys(body).length) { msg.className = ''; msg.textContent = 'Nothing to save.'; return; }

    save.disabled = true; msg.className = ''; msg.textContent = 'Saving…';
    try {
      const r = await fetch('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const out = await r.json();
      if (!out.ok) throw new Error(out.error || 'save failed');
      aisEnabled = out.aisEnabled;
      owmEnabled = out.owmEnabled;
      document.getElementById('aisWarn').classList.toggle('hidden', aisEnabled);
      msg.className = 'ok';
      // Report exactly what was saved — not the global state — so saving
      // OpenSky keys doesn't misleadingly claim ships are on their way.
      const parts = [];
      if (body.OPENSKY_CLIENT_ID || body.OPENSKY_CLIENT_SECRET) parts.push('OpenSky credentials');
      if (body.OWM_API_KEY) parts.push('rain key');
      if (body.AISSTREAM_API_KEY) parts.push('AIS key');
      let m = parts.length ? `Saved ${parts.join(' + ')}.` : 'Saved!';
      if (body.AISSTREAM_API_KEY && out.aisEnabled) m += ' Ships will appear shortly.';
      msg.textContent = m;
      aisIn.value = idIn.value = secIn.value = owmIn.value = '';
      refreshStatus();
    } catch (e) {
      msg.className = 'err'; msg.textContent = 'Error: ' + (e.message || e);
    } finally {
      save.disabled = false;
    }
  });
}

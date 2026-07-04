import express from 'express';
import { WebSocket } from 'ws';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Writable data dir for the saved-keys .env. Defaults to the app folder, but the
// Electron wrapper overrides it (FR_DATA_DIR) to a per-user writable location,
// since a packaged app's own files are read-only.
const DATA_DIR = process.env.FR_DATA_DIR || __dirname;
const ENV_PATH = join(DATA_DIR, '.env');

// --- Minimal .env loader (no external dependency) ---
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = process.env.PORT || 8787;

// Live-editable config. Keys can be set at startup (env / .env) OR later from the
// web app via /api/settings — changes persist to .env and re-apply without a restart.
const config = {
  AISSTREAM_API_KEY: (process.env.AISSTREAM_API_KEY || '').trim(),
  OPENSKY_CLIENT_ID: (process.env.OPENSKY_CLIENT_ID || '').trim(),
  OPENSKY_CLIENT_SECRET: (process.env.OPENSKY_CLIENT_SECRET || '').trim(),
  OWM_API_KEY: (process.env.OWM_API_KEY || '').trim(),
};

// Persist a set of KEY=value pairs into .env, preserving any other lines.
function persistEnv(updates) {
  const lines = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, 'utf8').replace(/\n+$/, '').split('\n')
    : [];
  const keys = Object.keys(updates);
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && keys.includes(m[1])) { seen.add(m[1]); return `${m[1]}=${updates[m[1]]}`; }
    return line;
  });
  for (const k of keys) if (!seen.has(k)) out.push(`${k}=${updates[k]}`);
  writeFileSync(ENV_PATH, out.join('\n') + '\n');
}

// Show only a safe hint of a secret (never the raw value) to the browser.
const mask = (v) => (v ? '•'.repeat(Math.max(0, v.length - 4)) + v.slice(-4) : '');

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/api/weather', async (_req, res) => {
  try {
    const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`rainviewer ${r.status}`);
    res.set('Cache-Control', 'public, max-age=120');
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// 🌦  GLOBAL RAIN  — OpenWeatherMap precipitation tiles, proxied so the API
//     key never reaches the browser. Modeled data → covers the whole world,
//     unlike ground radar.
// ---------------------------------------------------------------------------
app.get('/api/owm/:z/:x/:y', async (req, res) => {
  if (!config.OWM_API_KEY) {
    return res.status(404).json({ error: 'no OpenWeatherMap key — add one in ⚙️ Settings' });
  }
  const z = parseInt(req.params.z, 10), x = parseInt(req.params.x, 10), y = parseInt(req.params.y, 10);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 14 || x < 0 || y < 0) {
    return res.status(400).end();
  }
  try {
    const r = await fetch(
      `https://tile.openweathermap.org/map/precipitation_new/${z}/${x}/${y}.png?appid=${config.OWM_API_KEY}`,
      { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// ✈️  AIRCRAFT  — OpenSky /states/all: ALL aircraft worldwide in one call.
//     Cached server-side to respect rate limits; optional OAuth2 auth.
// ---------------------------------------------------------------------------
let osToken = { value: null, exp: 0 };
async function openskyToken() {
  if (!config.OPENSKY_CLIENT_ID || !config.OPENSKY_CLIENT_SECRET) return null;
  if (osToken.value && Date.now() < osToken.exp) return osToken.value;
  const r = await fetch(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.OPENSKY_CLIENT_ID,
        client_secret: config.OPENSKY_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(12000),
    });
  if (!r.ok) throw new Error(`opensky auth ${r.status}`);
  const j = await r.json();
  osToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return osToken.value;
}

let acCache = { at: 0, data: null, time: 0 };
const AC_TTL = 12_000; // don't hit OpenSky more often than this

app.get('/api/aircraft', async (_req, res) => {
  if (acCache.data && Date.now() - acCache.at < AC_TTL) {
    return res.json({ cached: true, time: acCache.time, count: acCache.data.length, aircraft: acCache.data });
  }
  try {
    const headers = {};
    const token = await openskyToken().catch(() => null);
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch('https://opensky-network.org/api/states/all', {
      headers, signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`opensky ${r.status}`);
    const data = await r.json();
    // State-vector indices: 0 icao24,1 callsign,2 country,5 lon,6 lat,7 baroAlt,
    // 8 onGround,9 velocity(m/s),10 track,11 vertRate(m/s),13 geoAlt,14 squawk
    const ac = (data.states || [])
      .filter((s) => Number.isFinite(s[5]) && Number.isFinite(s[6]))
      .map((s) => ({
        id: s[0],
        flight: (s[1] || '').trim() || s[0],
        country: s[2] || null,
        lat: s[6],
        lon: s[5],
        alt: Math.round(((s[13] ?? s[7]) || 0) * 3.28084), // m -> ft
        onGround: !!s[8],
        gs: s[9] != null ? Math.round(s[9] * 1.94384) : 0, // m/s -> kt
        track: s[10] || 0,
        vrate: s[11] != null ? Math.round(s[11] * 196.85) : 0, // m/s -> ft/min
        squawk: s[14] || null,
      }));
    acCache = { at: Date.now(), data: ac, time: data.time };
    res.json({ cached: false, time: data.time, count: ac.length, aircraft: ac });
  } catch (e) {
    // On failure (e.g. rate limit) keep serving the last good snapshot.
    if (acCache.data) {
      return res.json({ cached: true, stale: true, error: String(e.message || e),
        time: acCache.time, count: acCache.data.length, aircraft: acCache.data });
    }
    res.status(502).json({ error: String(e.message || e), aircraft: [] });
  }
});

// ---------------------------------------------------------------------------
// ✈️  LOCAL AIRCRAFT  — free community ADS-B aggregators (adsb.lol, airplanes.live,
//     adsb.fi). These have denser coverage + faster updates than OpenSky in many
//     regions, but only serve a radius (≤250 nm) around a point. We query around
//     the map's view center and merge/dedupe with OpenSky on the client. Bonus:
//     each record carries registration/type/owner directly.
// ---------------------------------------------------------------------------
const localCache = new Map(); // "lat,lon,dist" -> { at, data }
const LOCAL_TTL = 5_000;

function normReadsb(r, source) {
  const lat = Number(r.lat), lon = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const ground = r.alt_baro === 'ground';
  const altFt = ground ? 0 : Number(r.alt_baro ?? r.alt_geom);
  const vrate = Number.isFinite(r.baro_rate) ? r.baro_rate
    : (Number.isFinite(r.geom_rate) ? r.geom_rate : 0);
  const id = String(r.hex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!id) return null;
  return {
    id,
    flight: (r.flight || '').trim() || id,
    country: null,
    lat, lon,
    alt: Number.isFinite(altFt) ? Math.round(altFt) : 0,
    onGround: ground,
    gs: Number.isFinite(r.gs) ? Math.round(r.gs) : 0,
    track: Number.isFinite(r.track) ? r.track
      : (Number.isFinite(r.true_heading) ? r.true_heading : 0),
    vrate: Math.round(vrate) || 0,
    squawk: r.squawk || null,
    reg: r.r || null,
    type: [r.t, r.desc].filter(Boolean).join(' — ') || null,
    operator: r.ownOp || null,
    source,
  };
}

async function fetchAgg(url, source) {
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Flight-Radar/1.0' },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.ac || []).map((x) => normReadsb(x, source)).filter(Boolean);
  } catch { return []; }
}

app.get('/api/aircraft/local', async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat/lon required', aircraft: [] });
  }
  const dist = Math.max(5, Math.min(250, Math.round(Number(req.query.dist) || 100)));
  const key = `${lat.toFixed(1)},${lon.toFixed(1)},${dist}`;
  const hit = localCache.get(key);
  if (hit && Date.now() - hit.at < LOCAL_TTL) {
    return res.json({ cached: true, count: hit.data.length, aircraft: hit.data });
  }
  const results = await Promise.all([
    fetchAgg(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`, 'adsb.lol'),
    fetchAgg(`https://api.airplanes.live/v2/point/${lat}/${lon}/${dist}`, 'airplanes.live'),
    fetchAgg(`https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${dist}`, 'adsb.fi'),
  ]);
  const merged = new Map();
  for (const list of results) for (const a of list) if (!merged.has(a.id)) merged.set(a.id, a);
  const data = [...merged.values()];
  if (localCache.size > 64) localCache.clear(); // single-user: keep it tiny
  localCache.set(key, { at: Date.now(), data });
  res.json({ cached: false, count: data.length, aircraft: data });
});

// ---------------------------------------------------------------------------
// 🌐  EXTENDED AIRCRAFT FEED  — FlightRadar24 unofficial zone feed.
//     FR24 aggregates satellite-based ADS-B, so this fills open-ocean and other
//     gaps the ground-receiver networks (OpenSky / adsb.lol / airplanes.live)
//     physically can't see. It is an UNOFFICIAL endpoint (no public API, no
//     key): gray-area terms, and may be rate-limited or blocked without notice.
//     It's gated behind an in-app disclaimer the user must accept, and kept
//     fully optional so the app still works if FR24 ever changes/breaks it.
// ---------------------------------------------------------------------------
const FR24_HOST = 'https://data-cloud.flightradar24.com';
const FR24_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://www.flightradar24.com/',
  Origin: 'https://www.flightradar24.com',
  Accept: 'application/json',
};
const fr24Cache = new Map(); // "n,s,w,e" -> { at, data }
const FR24_TTL = 6_000;

// FR24 packs each aircraft into a positional array. Map the fields we use.
// [0]=modeS hex [1]=lat [2]=lon [3]=track [4]=alt(ft) [5]=gs(kt) [6]=squawk
// [8]=type [9]=reg [11]=origin [12]=dest [13]=flight# [14]=on_ground
// [15]=vspeed [16]=callsign [18]=airline ICAO
function normFr24(fr24Key, a) {
  if (!Array.isArray(a)) return null;
  const lat = Number(a[1]), lon = Number(a[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const id = String(a[0] || fr24Key || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!id) return null;
  const callsign = (a[16] || a[13] || '').toString().trim();
  return {
    id,
    flight: callsign || id,
    country: null,
    lat, lon,
    alt: Number.isFinite(Number(a[4])) ? Math.round(Number(a[4])) : 0,
    onGround: a[14] === 1 || a[14] === '1',
    gs: Number.isFinite(Number(a[5])) ? Math.round(Number(a[5])) : 0,
    track: Number.isFinite(Number(a[3])) ? Number(a[3]) : 0,
    vrate: Number.isFinite(Number(a[15])) ? Math.round(Number(a[15])) : 0,
    squawk: a[6] || null,
    reg: (a[9] || '').toString().trim() || null,
    type: (a[8] || '').toString().trim() || null,
    operator: (a[18] || '').toString().trim() || null,
    origin: (a[11] || '').toString().trim() || null,
    dest: (a[12] || '').toString().trim() || null,
    source: 'fr24',
  };
}

app.get('/api/aircraft/fr24', async (req, res) => {
  // bounds = north,south,west,east (FR24 order). Validate & clamp.
  const parts = String(req.query.bounds || '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'bounds=n,s,w,e required', aircraft: [] });
  }
  const n = Math.max(-85, Math.min(85, parts[0]));
  const s = Math.max(-85, Math.min(85, parts[1]));
  const w = Math.max(-180, Math.min(180, parts[2]));
  const e = Math.max(-180, Math.min(180, parts[3]));
  const key = `${n.toFixed(1)},${s.toFixed(1)},${w.toFixed(1)},${e.toFixed(1)}`;
  const hit = fr24Cache.get(key);
  if (hit && Date.now() - hit.at < FR24_TTL) {
    return res.json({ cached: true, count: hit.data.length, aircraft: hit.data });
  }
  try {
    const url = `${FR24_HOST}/zones/fcgi/feed.js?bounds=${key}` +
      '&faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=0&air=1' +
      '&vehicles=0&estimated=1&maxage=14400&gliders=0&stats=0';
    const r = await fetch(url, { headers: FR24_HEADERS, signal: AbortSignal.timeout(9000) });
    if (!r.ok) return res.status(502).json({ error: `fr24 ${r.status}`, aircraft: [] });
    const j = await r.json();
    const data = [];
    for (const k of Object.keys(j)) {
      if (k === 'full_count' || k === 'version' || k === 'stats') continue;
      const norm = normFr24(k, j[k]);
      if (norm) data.push(norm);
    }
    if (fr24Cache.size > 64) fr24Cache.clear();
    fr24Cache.set(key, { at: Date.now(), data });
    res.json({ cached: false, count: data.length, aircraft: data });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err), aircraft: [] });
  }
});

// ---------------------------------------------------------------------------
// ✈️  FLIGHT DETAIL  — adsbdb (free, no key): aircraft type/reg/owner + route.
// ---------------------------------------------------------------------------
const acInfoCache = new Map();  // icao     -> aircraft info (or null)
const routeCache = new Map();   // callsign -> route info (or null)

async function adsbdb(path) {
  const r = await fetch(`https://api.adsbdb.com/v0/${path}`, { signal: AbortSignal.timeout(12000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`adsbdb ${r.status}`);
  return (await r.json()).response;
}

app.get('/api/flight/:icao', async (req, res) => {
  const icao = String(req.params.icao || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  const callsign = String(req.query.callsign || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  const out = { aircraft: null, route: null };
  try {
    if (icao) {
      if (acInfoCache.has(icao)) out.aircraft = acInfoCache.get(icao);
      else {
        const resp = await adsbdb(`aircraft/${icao}`).catch(() => null);
        out.aircraft = resp?.aircraft || null;
        acInfoCache.set(icao, out.aircraft);
      }
    }
    if (callsign) {
      if (routeCache.has(callsign)) out.route = routeCache.get(callsign);
      else {
        const resp = await adsbdb(`callsign/${callsign}`).catch(() => null);
        out.route = resp?.flightroute || null;
        routeCache.set(callsign, out.route);
      }
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e), ...out });
  }
});

// ---------------------------------------------------------------------------
// ✈️  FLIGHT TRACK  — OpenSky /tracks/all: the waypoints actually flown, so a
//     clicked plane can show its real path immediately (not just from now on).
// ---------------------------------------------------------------------------
const trackCache = new Map(); // icao -> { at, data }
const TRACK_TTL = 60_000;

app.get('/api/track/:icao', async (req, res) => {
  const icao = String(req.params.icao || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!icao) return res.status(400).json({ error: 'bad icao24', path: [] });
  const hit = trackCache.get(icao);
  if (hit && Date.now() - hit.at < TRACK_TTL) return res.json(hit.data);
  try {
    const headers = {};
    const token = await openskyToken().catch(() => null);
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`https://opensky-network.org/api/tracks/all?icao24=${icao}&time=0`, {
      headers, signal: AbortSignal.timeout(15000),
    });
    let data;
    if (r.status === 404) {
      data = { icao24: icao, path: [] }; // no recent track known for this aircraft
    } else {
      if (!r.ok) throw new Error(`opensky tracks ${r.status}`);
      const j = await r.json();
      data = {
        icao24: icao,
        callsign: (j.callsign || '').trim(),
        startTime: j.startTime,
        endTime: j.endTime,
        // waypoints: [time, lat, lon, baro_altitude_m, true_track, on_ground]
        path: (j.path || []).filter((w) => Number.isFinite(w?.[1]) && Number.isFinite(w?.[2])),
      };
    }
    trackCache.set(icao, { at: Date.now(), data });
    if (trackCache.size > 500) {
      for (const k of trackCache.keys()) { if (trackCache.size <= 400) break; trackCache.delete(k); }
    }
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e), path: [] });
  }
});

// ---------------------------------------------------------------------------
// 🛰️  SATELLITES  — Celestrak TLEs (free). Cached; client propagates orbits.
// ---------------------------------------------------------------------------
const SAT_GROUPS = [
  { group: 'stations', cap: 50 },
  { group: 'visual', cap: 160 },
  { group: 'gps-ops', cap: 40 },
  { group: 'science', cap: 60 },
  { group: 'starlink', cap: 400 },
];
let satCache = { at: 0, data: null };
const SAT_TTL = 2 * 60 * 60 * 1000; // 2h — TLEs don't change quickly

async function fetchGroup(group, cap) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${group} ${r.status}`);
  const lines = (await r.text()).split('\n').map((l) => l.replace(/\r/g, ''));
  const sats = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (name && l1.startsWith('1 ') && l2.startsWith('2 ')) {
      sats.push({ name, tle1: l1, tle2: l2, group });
    }
    if (sats.length >= cap) break;
  }
  return sats;
}

app.get('/api/satellites', async (_req, res) => {
  if (satCache.data && Date.now() - satCache.at < SAT_TTL) {
    return res.json({ cached: true, count: satCache.data.length, satellites: satCache.data });
  }
  try {
    const groups = await Promise.allSettled(SAT_GROUPS.map((g) => fetchGroup(g.group, g.cap)));
    const all = [];
    for (const g of groups) if (g.status === 'fulfilled') all.push(...g.value);
    if (!all.length) throw new Error('no TLEs fetched');
    satCache = { at: Date.now(), data: all };
    res.json({ cached: false, count: all.length, satellites: all });
  } catch (e) {
    if (satCache.data) return res.json({ cached: true, stale: true, satellites: satCache.data });
    res.status(502).json({ error: String(e.message || e), satellites: [] });
  }
});

// ---------------------------------------------------------------------------
// 🚢  SHIPS  — aisstream.io websocket (free key). Backend keeps live cache.
// ---------------------------------------------------------------------------
const ships = new Map(); // mmsi -> {mmsi,name,lat,lon,cog,sog,heading,ts}
let aisSocket = null;
let aisBBox = [[[-90, -180], [90, 180]]]; // [[[lat,lon],[lat,lon]]]
let aisReconnectTimer = null;

function pruneShips() {
  const cutoff = Date.now() - 6 * 60 * 1000;
  for (const [mmsi, s] of ships) if (s.ts < cutoff) ships.delete(mmsi);
}
setInterval(pruneShips, 30000);

function subscribeAis() {
  if (!aisSocket || aisSocket.readyState !== WebSocket.OPEN) return;
  aisSocket.send(JSON.stringify({
    APIKey: config.AISSTREAM_API_KEY,
    BoundingBoxes: aisBBox,
    FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
  }));
}

function connectAis() {
  if (!config.AISSTREAM_API_KEY) return; // ships disabled without a free key
  aisSocket = new WebSocket('wss://stream.aisstream.io/v0/stream');
  aisSocket.on('open', () => {
    console.log('🚢 AIS stream connected');
    subscribeAis();
  });
  aisSocket.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const meta = msg.MetaData || {};
    const mmsi = meta.MMSI;
    if (!mmsi) return;
    const prev = ships.get(mmsi) || {};
    if (msg.MessageType === 'PositionReport') {
      const p = msg.Message.PositionReport;
      ships.set(mmsi, {
        mmsi,
        name: prev.name || (meta.ShipName || '').trim() || String(mmsi),
        lat: p.Latitude, lon: p.Longitude,
        cog: p.Cog ?? prev.cog ?? 0,
        sog: p.Sog ?? prev.sog ?? 0,
        heading: (p.TrueHeading != null && p.TrueHeading < 511) ? p.TrueHeading : (p.Cog ?? 0),
        ts: Date.now(),
      });
    } else if (msg.MessageType === 'ShipStaticData') {
      const name = (msg.Message.ShipStaticData?.Name || meta.ShipName || '').trim();
      if (name) ships.set(mmsi, { ...prev, mmsi, name, ts: prev.ts || Date.now() });
    }
  });
  const retry = () => {
    if (aisReconnectTimer) return;
    aisReconnectTimer = setTimeout(() => { aisReconnectTimer = null; connectAis(); }, 4000);
  };
  aisSocket.on('close', () => { console.log('🚢 AIS stream closed, retrying…'); retry(); });
  aisSocket.on('error', (e) => { console.log('🚢 AIS error:', e.message); try { aisSocket.close(); } catch {} });
}

// Tear down any existing AIS connection and reconnect with the current key.
// Called after the key changes via /api/settings so it takes effect immediately.
function reconnectAis() {
  if (aisReconnectTimer) { clearTimeout(aisReconnectTimer); aisReconnectTimer = null; }
  if (aisSocket) {
    try { aisSocket.removeAllListeners(); aisSocket.close(); } catch {}
    aisSocket = null;
  }
  ships.clear();
  connectAis();
}

// Frontend tells us where it's looking so we only stream ships in view.
app.post('/api/ships/bbox', (req, res) => {
  const { south, west, north, east } = req.body || {};
  if ([south, west, north, east].every((v) => Number.isFinite(v))) {
    aisBBox = [[[south, west], [north, east]]];
    subscribeAis();
  }
  res.json({ ok: true, aisEnabled: !!config.AISSTREAM_API_KEY });
});

app.get('/api/ships', (_req, res) => {
  pruneShips();
  // Only send ships inside the client's current view box — the AIS stream may
  // have cached a global backlog (from before the first bbox arrived) that
  // would otherwise flood the globe.
  const [[[south, west], [north, east]]] = aisBBox;
  let inView = Array.from(ships.values()).filter((s) =>
    Number.isFinite(s.lat) && Number.isFinite(s.lon) &&
    s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east);
  // Dense regions (e.g. the North Sea) can exceed what the globe renders
  // comfortably — keep the freshest ships.
  const MAX_SHIPS = 5000;
  if (inView.length > MAX_SHIPS) {
    inView.sort((a, b) => b.ts - a.ts);
    inView = inView.slice(0, MAX_SHIPS);
  }
  res.json({
    aisEnabled: !!config.AISSTREAM_API_KEY,
    count: inView.length,
    ships: inView,
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    aisEnabled: !!config.AISSTREAM_API_KEY,
    openskyAuth: !!(config.OPENSKY_CLIENT_ID && config.OPENSKY_CLIENT_SECRET),
    owmEnabled: !!config.OWM_API_KEY,
    ships: ships.size,
    satellitesCached: !!satCache.data,
  });
});

// ---------------------------------------------------------------------------
// ⚙️  SETTINGS  — let non-technical users add API keys from the web app.
//     GET reports which keys are configured (masked — never the raw secret).
//     POST saves keys to .env and re-applies them live (no restart needed).
// ---------------------------------------------------------------------------
app.get('/api/settings', (_req, res) => {
  res.json({
    aisstream: { set: !!config.AISSTREAM_API_KEY, hint: mask(config.AISSTREAM_API_KEY) },
    opensky: {
      set: !!(config.OPENSKY_CLIENT_ID && config.OPENSKY_CLIENT_SECRET),
      idHint: mask(config.OPENSKY_CLIENT_ID),
      secretHint: mask(config.OPENSKY_CLIENT_SECRET),
    },
    owm: { set: !!config.OWM_API_KEY, hint: mask(config.OWM_API_KEY) },
  });
});

app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const FIELDS = ['AISSTREAM_API_KEY', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET', 'OWM_API_KEY'];
  const updates = {};
  let aisChanged = false, openskyChanged = false;

  for (const k of FIELDS) {
    // Only apply fields explicitly present as strings; ignore omitted ones so a
    // partial save doesn't wipe existing keys.
    if (typeof body[k] !== 'string') continue;
    const val = body[k].trim();
    if (val === config[k]) continue;
    config[k] = val;
    updates[k] = val;
    if (k === 'AISSTREAM_API_KEY') aisChanged = true;
    else if (k === 'OPENSKY_CLIENT_ID' || k === 'OPENSKY_CLIENT_SECRET') openskyChanged = true;
  }

  try {
    if (Object.keys(updates).length) persistEnv(updates);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `could not write .env: ${e.message}` });
  }

  if (aisChanged) reconnectAis();
  if (openskyChanged) { osToken = { value: null, exp: 0 }; acCache.at = 0; }

  res.json({
    ok: true,
    aisEnabled: !!config.AISSTREAM_API_KEY,
    openskyAuth: !!(config.OPENSKY_CLIENT_ID && config.OPENSKY_CLIENT_SECRET),
    owmEnabled: !!config.OWM_API_KEY,
  });
});

connectAis();
app.listen(PORT, () => {
  console.log(`\n🌍 Flight-Radar running →  http://localhost:${PORT}`);
  console.log(`   ✈️  aircraft: OpenSky /states/all — ALL planes globally ${config.OPENSKY_CLIENT_ID ? '(authenticated)' : '(anonymous — add OpenSky keys in ⚙️ Settings for higher limits)'}`);
  console.log(`   🛰️  satellites: Celestrak TLE (free)`);
  console.log(`   🚢  ships: ${config.AISSTREAM_API_KEY ? 'aisstream.io connected' : 'DISABLED — add an aisstream.io key in ⚙️ Settings for the sea view'}\n`);
});

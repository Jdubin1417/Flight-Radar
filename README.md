# 🌍 Flight-Radar — Sea · Sky · Orbit

A self-hosted tracker on a 3D globe showing **three live layers you filter in and
out** — no zoom gating, everything stays put at any zoom level:

| Layer | Shows | Data source (all free) |
|-------|-------|------------------------|
| 🛰️ **Orbit** | Live satellites (ISS, Starlink, GPS…) | [Celestrak](https://celestrak.org) TLEs |
| ✈️ **Sky** | **Every aircraft on Earth at once** (ADS-B) | [OpenSky Network](https://opensky-network.org) |
| 🚢 **Sea** | Live ships (AIS) | [aisstream.io](https://aisstream.io) |

Plane details (type, operator, registration, photo, and origin→destination route)
are enriched from [adsbdb.com](https://www.adsbdb.com) — also free.

No paid subscription, no USB stick required — the data comes from free public
feeds aggregated from volunteer receivers worldwide.

## Using it

- **Show** row (top-left): click 🛰️ ✈️ 🚢 to filter each layer in or out. Counts
  update live. Nothing is tied to zoom — planes stay visible whether you're in
  low orbit or skimming the runway.
- **Click any plane** for a detail panel: altitude, speed, heading, vertical rate,
  registration, squawk, country, ICAO24, plus aircraft type, operator and the
  flight's origin→destination airports. The globe draws the **path the plane has
  actually flown** (solid orange, behind the plane) and the **remaining route to
  its destination** (dashed yellow, ahead of it).
- **Click any ship or satellite** for its own detail panel (speed/course/MMSI/flag
  for ships; altitude/velocity/orbit for satellites).
- **Map** row: pick a base map — 🛰 Satellite, 🗺 Streets, ⛰ Terrain, 🌍 Atlas, or
  🌥 **Live clouds** (NASA's daily satellite photo of Earth, real clouds included) —
  toggle country/city **Labels**, and overlay precipitation two ways:
  **🌧️ Radar** (RainViewer — live ground radar, only exists in radar-covered
  regions) and **🌦️ Rain** (OpenWeatherMap — modeled, covers the whole world;
  needs a free key, see Settings). **🌐 Extended** adds extra flights from a
  third-party feed (FlightRadar24) that also carries **satellite ADS-B**, so it
  can show aircraft over the **open ocean** and other remote areas the free
  ground networks can't see — these planes are drawn in **green**. It's optional
  and experimental; a disclaimer appears each time you enable it.
- **Camera** cluster (bottom-right): zoom ＋/－, 🧭 face north looking straight
  down, ⌂ return to the home view. **↺ Reset view** (top-left) does the same.
- **Find** box: type a callsign, airline, aircraft type, country, or **satellite
  name** to filter everything down to matches — e.g. type `iss` to find the
  International Space Station.
- **Trails** row: toggle 🛰️ ✈️ 🚢 to draw each object's recent path.
- **❔ Guide** button: reopens the welcome screen, which explains the data sources
  and every control. It appears automatically on first launch.

## Get the app (for everyone)

Flight-Radar ships as a normal **desktop app** — its own window and icon, with
everything (the server + Node runtime) bundled inside. Nothing to install, no
terminal, no Node required.

1. Download the file for your computer from the project's **Releases** page:
   - **macOS (Apple Silicon)** — `Flight-Radar-x.y.z-arm64.dmg`. Open the `.dmg`
     and drag Flight-Radar to Applications.
   - **Windows (Intel/AMD, 64-bit)** — `Flight-Radar-Setup-x.y.z-x64.exe`. Run it
     and follow the installer. (This is the right one for almost all PCs.)
   - **Windows (ARM64)** — `Flight-Radar-Setup-x.y.z-arm64.exe`. For ARM-based
     Windows PCs (e.g. Snapdragon / Surface Pro X).
   - **Linux** — `Flight-Radar-x.y.z.AppImage`. Mark it executable and run it.
2. Launch it like any other app. The globe opens in its own window.

> **First launch (important):** because the app isn't notarized by Apple, your OS
> warns you the first time. This is normal — the download is fine.
>
> - **macOS:** double-click the app once (it will be blocked), then open
>   **System Settings → Privacy & Security**, scroll down, and click
>   **“Open Anyway”** next to Flight-Radar. Confirm with **Open**. After that it
>   launches normally.
>   *If macOS instead says the app is “damaged,”* open **Terminal** and run:
>   `xattr -cr /Applications/Flight-Radar.app` — then open it again.
> - **Windows:** on the blue “Windows protected your PC” screen, click
>   **More info → Run anyway**.
>
> Want a seamless, warning-free install? That requires a paid Apple Developer
> account ($99/yr) for notarization on macOS — see the notes in the release.

It still needs an internet connection — this is *live* flight/ship/satellite data.

## Run from source (developers)

```bash
npm install
npm start          # plain server, open http://localhost:8787
# — or —
npm run app        # run the desktop app (Electron) against your source
```

Satellites and aircraft work immediately — no keys needed.

## Building the installers yourself

The cross-platform installers are built on each OS's native runner. Two options:

- **Automatic (recommended):** push this repo to GitHub. The included workflow
  (`.github/workflows/build.yml`) builds macOS, Windows, and Linux apps on every
  `v*` tag (e.g. `git tag v1.0.0 && git push --tags`) and attaches them to a
  GitHub Release — no local setup needed.
- **Locally:** run `npm run dist` on the OS you want to build for
  (`npm run dist:mac`, `dist:win`, or `dist:linux`). Output lands in `dist/`.
  You can only reliably build for the OS you're currently on.

## Adding API keys — the easy way (⚙️ Settings)

Some layers use free API keys. **You don't need to touch any files** — just launch
the app and click **⚙️ Settings** in the top-left, paste your key(s), and hit
**Save**. Keys are stored on your own computer (in a local `.env` file) and take
effect instantly — no restart. There are three optional keys:

### 🚢 Ships (AIS) — needed for the sea view
1. Sign up at <https://aisstream.io> and create an API key.
2. Open **⚙️ Settings**, paste it into the **Ships (AIS)** box, click **Save**.
   Ships start appearing within seconds.

### ✈️ Aircraft (OpenSky) — optional, for a higher rate limit
Planes load worldwide with no key at all, but OpenSky's **anonymous** access has a
strict daily limit (~100 world queries/day). If the plane count occasionally
freezes or goes stale, you've hit that cap. A **free** OpenSky account raises it ~10×:
1. Register at <https://opensky-network.org>, then create an API client
   (Account → API clients). OpenSky gives you a `credentials.json` download.
2. Open **⚙️ Settings** and **drag that .json file onto the drop zone** (or click
   it to browse) — the client ID and secret fill in automatically — then **Save**.
   Pasting the two values by hand works too.

### 🌦️ Global rain (OpenWeatherMap) — for worldwide precipitation
The 🌧️ Radar overlay is real ground radar, which only exists over parts of the
world (N. America, Europe, Japan, Australia…). The 🌦️ Rain overlay fills the rest
of the planet with modeled precipitation:
1. Sign up at <https://openweathermap.org> and copy an API key (API keys tab).
2. Open **⚙️ Settings**, paste it into the **Global rain** box, click **Save**.

> Prefer editing files? You can still copy `.env.example` to `.env` and fill in the
> keys by hand — the Settings panel just writes that same file for you.

## How it works

- **`electron/main.js`** — the desktop wrapper. Picks a free port, starts the
  embedded server, points its own Chromium window at it, and stores saved API keys
  in a per-user writable folder. Bundling this with `electron-builder` is what
  makes the runtime + server "baked in" — users install nothing.
- **`server.js`** — local Node/Express backend. Pulls the whole world's aircraft
  from OpenSky's `/states/all` (cached ~12s, serves the last snapshot if the feed
  rate-limits), enriches individual planes on demand from adsbdb, caches Celestrak
  TLEs, and keeps a live AIS ship cache from an aisstream.io websocket. It also
  saves API keys entered in the web app (`/api/settings` → `.env`) and re-applies
  them live. Serves the frontend.
- **`public/`** — [CesiumJS](https://cesium.com/platform/cesiumjs/) 3D globe with
  Esri World Imagery (no token needed). `app.js` streams the global fleet, smooths
  each object's motion between updates, and propagates satellite orbits in-browser
  with [satellite.js](https://github.com/shashwatak/satellite-js).

Hover any plane, ship, or satellite for a quick label; click a plane for the full
detail panel.

**Trails:** the HUD has a **Trails** row with 🛰️ ✈️ 🚢 toggles. Turn one on and
that layer draws each object's recent path — satellites trace their orbit arc,
planes and ships leave a breadcrumb of where they've been. Trails build up from
the moment you enable them and fade out after a time window.

## Notes & honest limits

- The whole global fleet (~11k aircraft) loads at once. Aircraft type / operator /
  route come from adsbdb and aren't available for *every* plane — unknown ones
  show the live ADS-B fields only.
- Online feeds have fair-use rate limits (see the optional OpenSky account above).
  If you ever want fully offline, unlimited reception, a ~$25 RTL-SDR USB dongle +
  `readsb`/`tar1090` receives ADS-B straight from the air — but then you're
  limited to your antenna's ~150 mi range instead of the whole globe.

// The living clock of the harbour. This is the first wiring of the retained
// simulation engine into the walkable world: it borrows the book's calendar
// (src/core/time.js — an 06:00–24:00 active day in named blocks) and turns the
// passage of time into light. The sun arcs and changes colour from dawn through
// midday to dusk; the sky and fog recolour with it; the street lamps warm up at
// night. Lighting is a pure function of the clock — no randomness — so the same
// minute always looks the same.
//
// This drives ambient world-time only (it loops the active day). Spending time
// through gameplay — shifts, travel, sleep — lands in a later milestone on top
// of the same core/time.js minute model.

import * as THREE from "three";
import { fmtClock, blockFor, DAY_START_MIN, DAY_END_MIN } from "../core/time.js";

// In-game minutes that pass per real second while you walk. The active day is
// 18h (1080 min); at 1.5/s a full day passes in ~12 real minutes — continuous
// enough to feel, quick enough to watch the sun move.
const MINUTES_PER_SECOND = 1.5;
const ACTIVE_SPAN = DAY_END_MIN - DAY_START_MIN; // 1080

// The sun travels a fixed arc across the day; only its azimuth/elevation, colour
// and strength change. Radius is well outside the scene (a directional light, so
// only the direction matters for lighting; the radius keeps the shadow camera in
// range as it swings).
const SUN_R = 58;
const AZ0 = 0.18 * Math.PI;   // azimuth at dawn
const AZ_SPAN = 0.82 * Math.PI; // swept by dusk

// Lighting keyframes across the active day — data-driven targets the renderer
// lerps between. `elev` is the sun's elevation in radians (negative = below the
// horizon → night). `sunI`/`hemi`/`amb`/`lamp` are intensities; colours are hex.
// `sky` is the [day, dusk, night] blend of the three painted sky panels at this
// hour (lerped + normalised below, then cross-faded onto the dome via
// world.setSkyBlend) — so the sky's mood tracks the same clock as the light.
const KEYS = [
  { min: 360,  sun: 0xffc59a, sunI: 0.5,  elev: 0.06, hemi: 0.42, amb: 0.11, top: 0x24344f, bot: 0xc98a64, fog: 0xb89a86, lamp: 0.55, mist: 0.85, sky: [0.15, 0.45, 0.40] }, // 06:00 dawn
  { min: 540,  sun: 0xffe9cf, sunI: 1.7,  elev: 0.44, hemi: 0.78, amb: 0.17, top: 0x3f6aa3, bot: 0xbcc4cf, fog: 0xb9c2cc, lamp: 0.10, mist: 0.30, sky: [0.90, 0.10, 0.00] }, // 09:00 morning
  { min: 720,  sun: 0xfff4e2, sunI: 2.3,  elev: 0.98, hemi: 0.98, amb: 0.21, top: 0x3f74c0, bot: 0xcfe0ee, fog: 0xcdd9e6, lamp: 0.0 , mist: 0.00, sky: [1.00, 0.00, 0.00] }, // 12:00 midday
  { min: 1020, sun: 0xffd6a0, sunI: 1.5,  elev: 0.40, hemi: 0.70, amb: 0.16, top: 0x37567f, bot: 0xd6a473, fog: 0xc6a486, lamp: 0.14, mist: 0.08, sky: [0.78, 0.22, 0.00] }, // 17:00 afternoon
  { min: 1140, sun: 0xff8a46, sunI: 0.75, elev: 0.05, hemi: 0.42, amb: 0.12, top: 0x2a3350, bot: 0xd07a45, fog: 0xb07a55, lamp: 0.5 , mist: 0.50, sky: [0.05, 0.95, 0.00] }, // 19:00 dusk
  { min: 1290, sun: 0x9fb4e0, sunI: 0.06, elev:-0.10, hemi: 0.22, amb: 0.08, top: 0x0c1422, bot: 0x1b2740, fog: 0x16203a, lamp: 1.0 , mist: 0.22, sky: [0.00, 0.30, 0.70] }, // 21:30 night
  { min: 1440, sun: 0x8fa6d8, sunI: 0.04, elev:-0.18, hemi: 0.18, amb: 0.07, top: 0x080f1a, bot: 0x131d31, fog: 0x101830, lamp: 1.0 , mist: 0.28, sky: [0.00, 0.00, 1.00] }, // 24:00 deep night
];

const lerp = (a, b, t) => a + (b - a) * t;

export function createDayCycle(world, scene, opts = {}) {
  const rate = opts.minutesPerSecond ?? MINUTES_PER_SECOND;
  let minutes = clampMin(opts.startMin ?? 480); // open at 08:00, a bright morning
  let day = 1;
  let lastPaintedMin = -999;

  // Precompute key colours once; reuse temp colours each frame (no hot-loop alloc).
  for (const k of KEYS) { k.sunC = new THREE.Color(k.sun); k.topC = new THREE.Color(k.top); k.botC = new THREE.Color(k.bot); k.fogC = new THREE.Color(k.fog); }
  const _sun = new THREE.Color(), _top = new THREE.Color(), _bot = new THREE.Color(), _fog = new THREE.Color();

  const { sun, hemi, ambient, lampHeads, paintSky, setSkyBlend, tintClouds, setMoon, setLampGlow, setWindowGlow, setWaterGlow, setSunGlitter, setBrazierGlow, setWaterMist, setBeacon, setBoatLights } = world;

  function clampMin(m) {
    return Math.min(DAY_END_MIN - 0.001, Math.max(DAY_START_MIN, m));
  }

  function bracket(m) {
    for (let i = 0; i < KEYS.length - 1; i++) {
      if (m < KEYS[i + 1].min) {
        const a = KEYS[i], b = KEYS[i + 1];
        return { a, b, t: (m - a.min) / (b.min - a.min) };
      }
    }
    const last = KEYS[KEYS.length - 1];
    return { a: last, b: last, t: 0 };
  }

  function applyAt(m) {
    const { a, b, t } = bracket(m);
    const sunI = lerp(a.sunI, b.sunI, t);
    const elev = lerp(a.elev, b.elev, t);
    _sun.copy(a.sunC).lerp(b.sunC, t);
    _top.copy(a.topC).lerp(b.topC, t);
    _bot.copy(a.botC).lerp(b.botC, t);
    _fog.copy(a.fogC).lerp(b.fogC, t);

    // Sun position along its arc, and whether it casts (off below the horizon).
    const az = AZ0 + ((m - DAY_START_MIN) / ACTIVE_SPAN) * AZ_SPAN;
    const ce = Math.cos(elev), se = Math.sin(elev);
    sun.position.set(Math.cos(az) * ce * SUN_R, se * SUN_R, Math.sin(az) * ce * SUN_R);
    sun.color.copy(_sun);
    sun.intensity = sunI;
    sun.castShadow = se > 0.02 && sunI > 0.2;

    if (hemi) hemi.intensity = lerp(a.hemi, b.hemi, t);
    if (ambient) ambient.intensity = lerp(a.amb, b.amb, t);
    if (scene.fog) scene.fog.color.copy(_fog);

    const lampI = lerp(a.lamp, b.lamp, t);
    for (const h of lampHeads) h.material.emissiveIntensity = lampI;
    if (setLampGlow) setLampGlow(lampI); // the lamps pool warm light on the wet stones
    if (setWindowGlow) setWindowGlow(lampI); // the town's windows warm up with the lamps at dusk
    if (setBrazierGlow) setBrazierGlow(lampI); // the brazier throws hot firelight on the cobbles

    // Mist breathes on the water at the cool ends of the day (its own curve, not the
    // lamp's): thick at dawn, a haze at dusk, burning off under bright midday.
    if (setWaterMist) setWaterMist(lerp(a.mist, b.mist, t));

    // Repaint the sky gradient (the fallback base) at most once per in-game
    // minute (cheap, throttled), cross-fade the painted day/dusk/night panels by
    // the same clock, and retint the drifting clouds with the horizon colour +
    // sun strength.
    const mi = Math.floor(m);
    if (mi !== lastPaintedMin) {
      lastPaintedMin = mi;
      if (paintSky) paintSky(_top, _bot);
      if (setSkyBlend) {
        const wd = lerp(a.sky[0], b.sky[0], t);
        const wk = lerp(a.sky[1], b.sky[1], t);
        const wn = lerp(a.sky[2], b.sky[2], t);
        const ws = wd + wk + wn || 1;
        setSkyBlend(wd / ws, wk / ws, wn / ws);
        if (setMoon) setMoon(wn / ws); // moon rides the night-blend weight
        if (setWaterGlow) setWaterGlow(wn / ws); // reflections catch the moon/lamps on the water
        if (setSunGlitter) setSunGlitter(wd / ws); // sun dazzles on the day water (inverse of the moon)
        if (setBeacon) setBeacon(wn / ws); // the lighthouse lantern shines across the bay at night
        if (setBoatLights) setBoatLights(wn / ws); // the moored boats carry warm running lanterns
      }
      if (tintClouds) tintClouds(_bot, sunI);
    }
  }

  applyAt(minutes); // light the very first frame correctly

  return {
    get minutes() { return minutes; },
    get day() { return day; },
    update(dt) {
      minutes += dt * rate;
      while (minutes >= DAY_END_MIN) { minutes -= ACTIVE_SPAN; day += 1; }
      applyAt(minutes);
    },
    // Test / debug hook: jump straight to a minute-of-day and relight.
    setMinutes(m) { minutes = clampMin(m); applyAt(minutes); },
    // Restore a validated saved date along with its time; retained for the
    // real worker/meal/rest persistence loop (not a separate fake game clock).
    setDate(d, m) {
      if (!Number.isSafeInteger(d) || d < 1 || d > 1000 || !Number.isFinite(m)) return false;
      day = d;
      minutes = clampMin(m);
      applyAt(minutes);
      return true;
    },
    // fmtClock/blockFor expect whole minutes (the sim advances in integer steps);
    // our clock flows continuously, so floor before formatting.
    label() { const m = Math.floor(minutes); return `Day ${day} · ${fmtClock(m)} · ${blockFor(m).label}`; },
  };
}

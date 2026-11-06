// City of Small Chances — full-screen Three.js entry.
// Boots a WebGL renderer over the whole viewport, builds the Old Harbour, drops in
// a player you walk with WASD/arrows behind an orbiting third-person camera, and
// runs the frame loop. The simulation engine (src/core, src/data, src/systems) is
// retained for wiring real days/economy into the world in later iterations.

import * as THREE from "three";
import { buildWorld } from "./world.js";
import { createDayCycle } from "./daycycle.js";
import { createInteractions } from "./interactions.js";
import { createInteractionUI, createStatsHUD } from "./ui.js";
import { createPlayerState, restoreHarborPocket } from "./playerstate.js";
import { createFigure } from "./player.js";
import { Input } from "./input.js";
import { createAudio } from "./audio.js";

const MOVE_SPEED = 4.2;            // metres / second
const CAM = { yaw: 0, pitch: 0.34, dist: 9, height: 1.4 };

// The harbour's weather, day by day (Batch 21, fx-002). Deterministic — no RNG —
// so a given day always dawns the same: day 1 opens clear so you meet the world
// dry, then a fixed six-day cycle of working-port weather rolls through — a morning
// mist, a clear day, a soft rain, a proper wet day, a clearing drizzle. rain & fog
// are 0..1 intensities the HUD turns into the rain/fog/mist overlay. Grounded,
// never a storm: rain peaks at a steady drift, fog at a low veil off the water.
const WEATHER_CYCLE = [
  { rain: 0.0,  fog: 0.0  }, // clear — the world you arrive into
  { rain: 0.0,  fog: 0.34 }, // a low morning mist off the water
  { rain: 0.0,  fog: 0.06 }, // clear, a breath of haze
  { rain: 0.45, fog: 0.40 }, // a soft rain sets in
  { rain: 0.85, fog: 0.62 }, // a proper grey, wet day
  { rain: 0.28, fog: 0.46 }, // the rain easing to a clearing drizzle
];
function weatherFor(dayNumber) {
  const i = ((Math.floor(dayNumber) - 1) % WEATHER_CYCLE.length + WEATHER_CYCLE.length) % WEATHER_CYCLE.length;
  return WEATHER_CYCLE[i];
}
// How overcast the sky goes for a given day's weather — rain leads, fog adds a
// little, capped so the time-of-day sky never fully vanishes behind the grey.
function wetnessFor(w) {
  return Math.max(0, Math.min(0.85, w.rain * 0.7 + w.fog * 0.5));
}

function fail(msg) {
  const boot = document.getElementById("boot");
  if (boot) {
    boot.classList.remove("gone");
    boot.innerHTML = `<div class="boot__title">Can't open the harbour</div>
      <div class="boot__sub">${msg}</div>`;
  }
}

function start() {
  const canvas = document.getElementById("game");
  if (!canvas) return;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch (e) {
    fail("This browser could not start WebGL.");
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 400);

  const world = buildWorld(scene);
  const day = createDayCycle(world, scene, { startMin: 480 }); // open at 08:00
  // Keep the same simulation pocket/clock across visits, never replay old wages.
  // A malformed or future-version save is ignored without crashing WebGL.
  const STORAGE_KEY = "city-small-chances:harbor-life:v1";
  let previousSave = null;
  try { previousSave = restoreHarborPocket(JSON.parse(localStorage.getItem(STORAGE_KEY))); } catch {}
  if(previousSave) day.setDate(previousSave.day, previousSave.minute);

  const clockEl = document.getElementById("clock");
  let lastClock = "";
  let lastDay = day.day; // watch for the midnight→dawn rollover to play the veil

  const player = createFigure("player");
  player.root.position.set(-3, 0, 16);
  player.root.rotation.y = Math.PI; // face down the street, away from camera
  scene.add(player.root);

  const input = new Input(canvas);

  // The player's pocket — money + energy — shown in the corner HUD.
  const pstate = createPlayerState(previousSave || {});
  const savePocket = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pstate.snapshot(day.day, day.minutes))); } catch {}
  };
  window.addEventListener("pagehide", savePocket);
  const hud = createStatsHUD();
  hud.set(pstate.money, pstate.energy);
  { const w = weatherFor(day.day); hud.setWeather(w.rain, w.fog); world.setOvercast(wetnessFor(w)); } // the day's sky

  // The harbour's procedural soundscape (resumes on first gesture; see audio.js).
  const audio = createAudio();
  audio.setTimeOfDay(day.minutes);
  hud.setMuted(audio.isMuted());
  hud.onMuteToggle(() => hud.setMuted(audio.toggleMute()));
  window.addEventListener("keydown", (e) => {
    if ((e.key === "m" || e.key === "M") && !e.repeat) hud.setMuted(audio.toggleMute());
  });

  // In-world interaction: proximity points + a prompt/panel overlay.
  const interactions = createInteractions(player);
  const ui = createInteractionUI();
  let interacting = false;
  let activePoint = null;
  let renderActive = () => {};
  let lastBoardMin = -1; // in-game minute the live board last rendered at
  ui.onClose(() => { interacting = false; activePoint = null; audio.panelClose(); });

  // Open an interactable: render its panel (live, if it builds from world state)
  // and wire up acting on it. Re-renders in place after each action.
  function openInteractable(near) {
    activePoint = near;
    pstate.lastWork = null; // a fresh visit starts without a stale result banner
    renderActive = () => {
      const data = near.build ? near.build({ nowMin: day.minutes, pstate }) : near.panel;
      ui.openPanel(data, near.act ? performAct : null);
      lastBoardMin = Math.floor(day.minutes);
    };
    renderActive();
    interacting = true;
    ui.hidePrompt();
    audio.panelOpen();
  }

  // Perform action #i on the open interactable (a click or a number key), then
  // refresh the panel and the stats HUD so the result shows immediately.
  function performAct(i) {
    if (!activePoint || !activePoint.act) return;
    const res = activePoint.act(i, { nowMin: day.minutes, pstate, day });
    hud.set(pstate.money, pstate.energy);
    if(res?.ok)savePocket();
    // A worked shift gets its own family texture (which ends in the coin payout)
    // plus a brief painted montage of the work (fx-007); any other successful act
    // just chimes the coins. A blocked one buzzes.
    if (res && res.ok) {
      audio.workShift(res.family);
      if (res.family) hud.playShiftScene(res.family);
    } else audio.deny();
    renderActive();
  }

  // Reusable vectors (no per-frame allocation in the hot loop).
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const clock = new THREE.Clock();
  // Reusable for the soaring gulls' yaw+bank composition (spr-029).
  const _gullUp = new THREE.Vector3(0, 1, 0);
  const _gullNose = new THREE.Vector3();
  const _gullYaw = new THREE.Quaternion();
  const _gullRoll = new THREE.Quaternion();
  let markerPhase = 0;
  let gullClock = 0; // seconds, drives the soaring gulls' wheel + wingbeat (Batch 70)
  let smokeClock = 0; // seconds, drives the homes' chimney plumes (spr-021)
  let critterClock = 0; // seconds, drives the real-body dog/cat idle (spr-022)

  function placeCamera() {
    const p = player.root.position;
    const cp = Math.cos(CAM.pitch);
    camera.position.set(
      p.x + Math.sin(CAM.yaw) * cp * CAM.dist,
      p.y + Math.sin(CAM.pitch) * CAM.dist + CAM.height,
      p.z + Math.cos(CAM.yaw) * cp * CAM.dist,
    );
    lookAt.set(p.x, p.y + 1.2, p.z);
    camera.lookAt(lookAt);
  }
  placeCamera();

  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);

    const drag = input.takeDrag(); // always consume so it never bursts on resume
    const act = input.takeAction();

    let speed = 0;
    if (interacting) {
      // Reading a panel: the world breathes on, but the player is still.
      if (act === "interact" || act === "cancel") ui.closePanel();
      else if (typeof act === "string" && act.startsWith("pick:")) performAct(Number(act.slice(5)) - 1);
    } else {
      // Drag orbits the camera around the player.
      CAM.yaw -= drag.yaw;
      CAM.pitch = Math.max(0.05, Math.min(1.15, CAM.pitch + drag.pitch));

      // Camera-relative movement on the ground plane.
      fwd.set(-Math.sin(CAM.yaw), 0, -Math.cos(CAM.yaw)).normalize();
      right.set(-fwd.z, 0, fwd.x);
      const a = input.axis();
      move.set(0, 0, 0).addScaledVector(fwd, a.z).addScaledVector(right, a.x);

      if (move.lengthSq() > 0) {
        move.normalize();
        const p = player.root.position;
        p.x += move.x * MOVE_SPEED * dt;
        p.z += move.z * MOVE_SPEED * dt;
        const b = world.bounds;
        p.x = Math.max(b.minX, Math.min(b.maxX, p.x));
        p.z = Math.max(b.minZ, Math.min(b.maxZ, p.z));
        player.root.rotation.y = Math.atan2(move.x, move.z);
        speed = MOVE_SPEED;
      }

      // Context prompt for the nearest point of interest; act to open it.
      const near = interactions.nearest();
      if (near) {
        ui.showPrompt(`[E] ${near.label}`);
        if (act === "interact") openInteractable(near);
      } else {
        ui.hidePrompt();
      }
    }

    player.update(dt, speed);
    audio.update(dt, speed);

    for (const c of world.citizens) c.update(dt);

    // The named cast notice you: come within a few metres and each turns from its work
    // to face you (easing round, not snapping), then drifts back to its home heading once
    // you move off. makeStanding leaves root.rotation.y free, so this owns it cleanly.
    const pp = player.root.position;
    for (const L of world.locals) {
      const dx = pp.x - L.x, dz = pp.z - L.z;
      const target = dx * dx + dz * dz < 12.25 ? Math.atan2(dx, dz) : L.homeYaw; // 3.5 m
      const d = Math.atan2(Math.sin(target - L.fig.root.rotation.y), Math.cos(target - L.fig.root.rotation.y));
      L.fig.root.rotation.y += d * Math.min(1, dt * 4);
    }

    // Turn each painted citizen billboard to face the camera (cylindrical: only
    // around Y, so the figures stay upright as the camera orbits and pitches).
    for (const b of world.billboards) {
      b.rotation.y = Math.atan2(camera.position.x - b.position.x, camera.position.z - b.position.z);
    }

    // Drift the clouds slowly across the sky (wrapping in x) and turn each to face
    // the camera, so the painted cards always read front-on against the dome.
    for (const c of world.clouds) {
      let x = c.mesh.position.x + c.speed * dt;
      if (x > c.wrap) x -= c.wrap * 2;
      c.mesh.position.x = x;
      c.mesh.rotation.y = Math.atan2(camera.position.x - x, camera.position.z - c.mesh.position.z);
    }

    // Wheel the soaring gulls (Batch 70 → spr-027 → spr-028 → spr-029): each is a real
    // `buildSoaringGull` body drifting a slow Lissajous path over the water, facing its OWN
    // heading (atan2 of the path velocity — no camera-facing). spr-028: it beats its wings to
    // CLIMB and sets them to GLIDE on the way down (`effort` = the climbing half of the
    // altitude bob). spr-029: it also BANKS into its turns — bank ∝ the signed horizontal
    // path curvature `vx·az − vz·ax`, which is ~0 mid-glide (flying straight) and peaks with
    // opposite signs at the two turn-arounds. Roll is composed as a quaternion (yaw about
    // world-up, THEN roll about the world-space nose axis) so heading and bank live on
    // separate axes — no Euler-order ambiguity, and `buildSoaringGull` stays untouched.
    gullClock += dt;
    for (const gl of world.soaringGulls) {
      const a = gullClock * gl.speed + gl.phase;
      const x = gl.x0 + gl.xAmp * Math.sin(a * 2);          // lateral sway (figure-eight)
      const y = gl.y0 + gl.yAmp * Math.sin(a * 0.8 + 1.3);  // gentle altitude bob
      const z = gl.z0 + gl.zAmp * Math.sin(a);              // primary glide along the quay
      const vx = gl.xAmp * Math.cos(a * 2) * 2 * gl.speed;  // path velocity
      const vz = gl.zAmp * Math.cos(a) * gl.speed;
      const ax = -gl.xAmp * Math.sin(a * 2) * 4 * gl.speed * gl.speed; // path acceleration
      const az = -gl.zAmp * Math.sin(a) * gl.speed * gl.speed;
      const heading = Math.atan2(-vz, vx); // body nose is local +x → Ry maps +x to (cos,−sin)
      const bank = Math.max(-0.5, Math.min(0.5, (vx * az - vz * ax) * 2.0)); // lean into the turn
      const effort = Math.max(0, Math.cos(a * 0.8 + 1.3));  // 1 climbing, 0 gliding down
      const beat = Math.sin((gullClock + gl.phase) * 7.0) * (0.06 + effort * 0.5); // flap to climb
      const dihedral = 0.15 + (1 - effort) * 0.12;          // wings held in a steeper V to glide
      gl.root.position.set(x, y, z);
      _gullNose.set(Math.cos(heading), 0, -Math.sin(heading)); // nose dir after yaw
      _gullYaw.setFromAxisAngle(_gullUp, heading);
      _gullRoll.setFromAxisAngle(_gullNose, bank);
      gl.root.quaternion.copy(_gullRoll).multiply(_gullYaw); // yaw first, then roll about the nose
      gl.leftWing.rotation.x = -dihedral - beat;
      gl.rightWing.rotation.x = dihedral + beat;
    }

    // Smoke rises from the homes' chimneys (spr-021): each puff loops a lifecycle
    // — rise, widen, drift on the wind, fade in then out. The puffs in a plume are
    // phase-staggered, so the column always carries smoke at every height. Sprites
    // self-billboard, so no facing math here. The same tick also drives Mei's bowl
    // STEAM (spr-042): a plume may carry its own column tuning (rise/drift/scale/
    // opacity); absent fields fall back to the chimney defaults, so the rooftop
    // smoke is byte-identical while the steam rides a short, tight, pale wisp.
    smokeClock += dt;
    for (const pl of world.smokePlumes) {
      for (const pf of pl.puffs) {
        let lt = (smokeClock * pf.speed + pf.phase) % 1; if (lt < 0) lt += 1;
        pf.sprite.position.y = pl.mouthY + lt * (pl.rise ?? 3.4);                  // rise
        pf.sprite.position.x = pl.mouthX + Math.sin((smokeClock + pf.phase * 10) * pf.sway) * ((pl.driftBase ?? 0.15) + lt * (pl.driftGain ?? 0.6)); // drift, widening
        const s = (pl.scaleBase ?? 0.4) + lt * (pl.scaleGain ?? 1.5);             // grow as it thins
        pf.sprite.scale.set(s, s, s);
        pf.sprite.material.opacity = Math.sin(lt * Math.PI) * (pl.maxOpacity ?? 0.42); // fade in then out
      }
    }

    // The harbour animals breathe (spr-022): the real-body dog and cat run their own
    // small idle — the dog wags and sniffs, the cat flicks its tail and watches the water.
    critterClock += dt;
    for (const c of world.critters) c.update(critterClock);
    // The washing sways on its lines in the harbour wind (spr-033) — same elapsed-seconds clock.
    for (const w of world.washing) w.update(critterClock);
    // The masthead burgee ripples in that same wind (spr-035).
    for (const f of world.flags) f.update(critterClock);

    // Bob the interaction markers so they catch the eye.
    markerPhase += dt * 2.2;
    for (let i = 0; i < world.markers.length; i++) {
      const m = world.markers[i];
      m.rotation.y += dt * 1.1;
      m.position.y = 2.4 + Math.sin(markerPhase + i) * 0.12;
    }

    // Advance the harbour clock and relight the world; refresh the HUD readout.
    day.update(dt);
    const label = day.label();
    if (label !== lastClock) {
      if (clockEl) clockEl.textContent = label;
      lastClock = label;
      audio.setTimeOfDay(day.minutes); // shift gulls/lamp-hum with the hour
    }

    // When the living clock rolls past midnight into a fresh dawn, play the
    // day-transition veil (Batch 19): the night draws the screen down and the
    // world re-emerges through a warm dawn wash.
    if (day.day !== lastDay) {
      lastDay = day.day;
      savePocket();
      hud.playDayTransition();
      const w = weatherFor(day.day); // the new day brings its own weather, masked
      hud.setWeather(w.rain, w.fog);  // by the transition veil so the swap is unseen
      world.setOvercast(wetnessFor(w)); // and greys the sky if the day is wet
    }

    // Keep a live panel (the notice board) honest with the moving clock: as the
    // minute ticks over, re-score the shifts so a window can open or close, a
    // requirement can lift, and the dimmed/open rows match reality while you read.
    if (interacting && activePoint && activePoint.build) {
      const m = Math.floor(day.minutes);
      if (m !== lastBoardMin) renderActive();
    }

    placeCamera();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  window.addEventListener("resize", onResize);

  // Debug / test hook: lets the headless smoke read state and drive the world.
  window.__game = { THREE, scene, camera, renderer, player, world, input, CAM, day, interactions, ui, pstate, hud, audio, savePocket };

  requestAnimationFrame(tick);

  // Drop the boot splash once the first frame is up.
  const boot = document.getElementById("boot");
  if (boot) {
    requestAnimationFrame(() => {
      boot.classList.add("gone");
      setTimeout(() => boot.remove(), 650);
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

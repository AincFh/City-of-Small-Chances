// The player's pocket: money, energy, and the rules for working a shift.
// Pure logic, no DOM and no Three.js — deterministic (no Math.random), so the
// same inputs always give the same outcome and the headless smoke can assert it.
//
// This is the second wiring of the retained engine into the walkable world: the
// notice board reads the real job tables (src/data/jobs.js) and working a shift
// spends the same minute-of-day clock the day cycle already runs on.

import { DAY_END_MIN } from "../core/time.js";

// Energy a shift burns, per job family — physical work costs more per minute.
// Clamped so even a short shift is felt and the hardest never wipes you in one go.
const ENERGY_RATE = { labour: 0.10, delivery: 0.09, admin: 0.05, service: 0.05 };

export function energyCost(job) {
  const rate = ENERGY_RATE[job.family] ?? 0.07;
  return Math.min(40, Math.max(6, Math.round(job.minutes * rate)));
}

// Is the shift offered at this minute-of-day? (A job can have several windows.)
export function windowOpen(job, nowMin) {
  return job.windows.some(([a, b]) => nowMin >= a && nowMin <= b);
}

// Shape the lightweight pocket into the state object the sim's job.requires(state)
// gates read — so the board honours the very same entry rules the engine declares
// (a bicycle for courier work, proven focus for the records desk). Skills and
// inventory aren't earnable in the walkable build yet, so those gates stay shut and
// say why; the energy floor is live from the player's own energy.
function simState(player) {
  return {
    condition: { energy: player.energy },
    inventory: player.inventory || {},
    skills: player.skills || {},
  };
}

// Why you can (or can't) work a job right now — legible, like the rest of the game.
export function jobStatus(job, nowMin, player) {
  const cost = energyCost(job);
  if (!windowOpen(job, nowMin)) return { workable: false, reason: "closed", cost };
  if (job.requires && !job.requires(simState(player)))
    return { workable: false, reason: "requires", cost, note: job.requiresNote };
  if (nowMin + job.minutes > DAY_END_MIN) return { workable: false, reason: "no-time", cost };
  if (player.energy < cost) return { workable: false, reason: "tired", cost };
  return { workable: true, cost };
}

/**
 * Three genuinely useful harbour services and one free time-for-energy rest.
 * Actions have hard cash, clock, stock and skill gates and apply atomically.
 * One-off bicycle and twice-practised focus open jobs previously unreachable.
 */
export const HARBOR_SERVICES = Object.freeze([
  { id: "noodles", name: "Eat a warm noodle bowl", cost: 12, minutes: 35, energy: 23,
    detail: "A proper meal restores 23 energy and takes 35 minutes." },
  { id: "rest", name: "Rest by the harbour", cost: 0, minutes: 130, energy: 27,
    detail: "Find a quiet seat; recover 27 energy, but lose two hours of daylight." },
  { id: "bicycle", name: "Buy a second-hand bicycle", cost: 95, minutes: 45,
    detail: "Unlocks real courier shifts on the notice board. One-time purchase." },
  { id: "study", name: "Practice filing at the stall", cost: 18, minutes: 80, energy: -8,
    detail: "Gain five focus per session; at 10 focus the civic records job opens." },
]);
const bounded = (n, lo, hi, fallback) =>
  Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : fallback;

export function serviceStatus(service, nowMin, player) {
  if (!service) return { workable: false, reason: "unknown" };
  if (!Number.isFinite(nowMin) || nowMin < 360 || nowMin + service.minutes > DAY_END_MIN)
    return { workable: false, reason: "no-time" };
  if (service.id === "bicycle" && player.inventory?.bicycle)
    return { workable: false, reason: "owned" };
  if (service.id === "study" && (player.skills?.focus ?? 0) >= 10)
    return { workable: false, reason: "trained" };
  if (player.money < service.cost) return { workable: false, reason: "money" };
  if (service.energy > 0 && player.energy >= 100)
    return { workable: false, reason: "rested" };
  if (service.energy < 0 && player.energy < -service.energy)
    return { workable: false, reason: "tired" };
  return { workable: true, reason: "" };
}

export function restoreHarborPocket(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) return null;
  // Ignore unknown inventory / skills. Import is never trusted with prototypes.
  return {
    money: bounded(raw.money, 0, 1000000, 240),
    energy: bounded(raw.energy, 0, 100, 100),
    shiftsWorked: bounded(raw.shiftsWorked, 0, 100000, 0),
    inventory: { bicycle: raw.inventory?.bicycle === true },
    skills: { focus: bounded(raw.skills?.focus, 0, 10, 0) },
    mealsEaten: bounded(raw.mealsEaten, 0, 100000, 0),
    restsTaken: bounded(raw.restsTaken, 0, 100000, 0),
    studySessions: bounded(raw.studySessions, 0, 2, 0),
    day: bounded(raw.day, 1, 1000, 1),
    minute: bounded(raw.minute, 360, 1439, 480),
  };
}

export function createPlayerState(opts = {}) {
  return {
    // $240 is the "Carried debt" starting cash from the book's opening: you
    // arrive in Haiyun City owing money, so every shift counts.
    money: opts.money ?? 240,
    energy: opts.energy ?? 100,
    shiftsWorked: opts.shiftsWorked ?? 0,
    inventory: { bicycle: opts.inventory?.bicycle === true },
    skills: { focus: opts.skills?.focus ?? 0 },
    mealsEaten: opts.mealsEaten ?? 0,
    restsTaken: opts.restsTaken ?? 0,
    studySessions: opts.studySessions ?? 0,
    lastWork: null, // a transient one-line result, shown on the board while it's open

    /** Snapshot that can be saved on every committed action or game-day boundary. */
    snapshot(day, minute) {
      return { version: 1, day: bounded(day, 1, 1000, 1),
        minute: bounded(minute, 360, 1439, 480),
        money: this.money, energy: this.energy, shiftsWorked: this.shiftsWorked,
        inventory: { bicycle: this.inventory.bicycle }, skills: { focus: this.skills.focus },
        mealsEaten: this.mealsEaten, restsTaken: this.restsTaken, studySessions: this.studySessions };
    },

    service(id, nowMin) {
      const entry = HARBOR_SERVICES.find(x => x.id === id);
      const status = serviceStatus(entry, nowMin, this);
      if (!status.workable) return { ok: false, reason: status.reason };
      // Validate all constraints before any mutation.
      this.money -= entry.cost;
      if (entry.energy) this.energy = Math.max(0, Math.min(100, this.energy + entry.energy));
      if (id === "bicycle") this.inventory.bicycle = true;
      if (id === "study") {
        this.skills.focus = Math.min(10, this.skills.focus + 5);
        this.studySessions += 1;
      }
      if (id === "noodles") this.mealsEaten += 1;
      if (id === "rest") this.restsTaken += 1;
      return { ok: true, name: entry.name, cost: entry.cost,
        minutes: entry.minutes, energy: entry.energy || 0,
        focus: this.skills.focus, bicycle: this.inventory.bicycle };
    },

    canWork(job, nowMin) {
      return jobStatus(job, nowMin, this).workable;
    },

    // Apply a shift: pay in hand, energy spent, a shift on the record. Returns the
    // deltas (the caller advances the world clock by `minutes`). No-op if not workable.
    work(job, nowMin) {
      const st = jobStatus(job, nowMin, this);
      if (!st.workable) return { ok: false, reason: st.reason };
      const pay = job.pay.base;
      this.money += pay;
      this.energy = Math.max(0, this.energy - st.cost);
      this.shiftsWorked += 1;
      return { ok: true, pay, energySpent: st.cost, minutes: job.minutes };
    },
  };
}

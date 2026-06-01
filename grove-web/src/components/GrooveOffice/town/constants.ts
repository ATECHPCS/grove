/**
 * Tuning constants + flavour text for the Grove "town" office.
 *
 * The pixel-office engine in this folder is adapted from Agent Town
 * (https://github.com/geezerrrr/agent-town, MIT) and rewired to render Grove's
 * own dashboard data. Numeric tuning preserves the original feel; the activity
 * / POI flavour text below is written for Grove's coding agents.
 */

// ── Game canvas (logical design size; camera fits to container) ──
export const GAME_WIDTH = 1296;
export const GAME_HEIGHT = 960;

// ── Pathfinder ───────────────────────────────────────────
export const PF_CELL_SIZE = 16;
export const PF_PADDING = 8;
export const PF_MAX_ITER = 20000;

// ── Worker wandering ─────────────────────────────────────
export const WANDER_MIN_DELAY = 3000;
export const WANDER_MAX_DELAY = 10000;
export const WANDER_STAGGER_MS = 1800;
export const WANDER_INITIAL_MIN = 500;
export const WANDER_INITIAL_MAX = 4000;

// ── Worker movement ──────────────────────────────────────
export const ARRIVE_THRESHOLD = 8;
export const WORKER_SPEED_FACTOR = 0.55;
export const STUCK_FRAME_LIMIT = 120;
export const STUCK_MOVE_THRESHOLD = 0.5;
export const TASK_RESULT_HOLD_MS = 4500;
export const TASK_BUBBLE_MS = 4000;
export const TASK_THINK_DELAY_MS = 4200;

export const POI_WANDER_CHANCE = 0.35;
export const POI_STAY_MIN = 3000;
export const POI_STAY_MAX = 6000;
export const STAGGER_EXTRA_MIN = 250;
export const STAGGER_EXTRA_MAX = 1200;

export const EMOTE_Y_OFFSET = 0.55;
export const BUBBLE_Y_OFFSET = 0.45;

// Physics body (fraction of the 48×96 sprite frame)
export const BODY_SIZE_RATIO_W = 0.5;
export const BODY_SIZE_RATIO_H = 0.2;
export const BODY_OFFSET_RATIO_X = 0.25;
export const BODY_OFFSET_RATIO_Y = 0.75;

// ── Worker idle-activity presets (Grove coding flavour) ──
export interface SeatActivityDef {
  emote: string;
  bubbles: string[];
  minDuration: number;
  maxDuration: number;
}

export const SEAT_ACTIVITIES: SeatActivityDef[] = [
  { emote: "emote:device", bubbles: ["Writing code~", "Refactoring...", "One more test..."], minDuration: 5000, maxDuration: 12000 },
  { emote: "emote:device", bubbles: ["Reading the diff", "Tracing a bug", "Grepping the repo"], minDuration: 5000, maxDuration: 10000 },
  { emote: "emote:thinking", bubbles: ["Hmm...", "Let me think...", "Planning the approach"], minDuration: 5000, maxDuration: 10000 },
  { emote: "emote:thinking", bubbles: ["Reading docs...", "Checking the spec", "Interesting~"], minDuration: 5000, maxDuration: 10000 },
  { emote: "emote:star", bubbles: ["Tests pass!", "Got it!", "Green build~"], minDuration: 2000, maxDuration: 4000 },
  { emote: "emote:dots", bubbles: ["Compiling...", "Running CI...", "Waiting on the build"], minDuration: 4000, maxDuration: 8000 },
  { emote: "emote:music", bubbles: ["~♪♪~", "In the zone~", "Good vibes~"], minDuration: 3000, maxDuration: 6000 },
  { emote: "emote:confused", bubbles: ["Huh?", "Why is this red?", "Flaky test again..."], minDuration: 3000, maxDuration: 6000 },
  { emote: "emote:sleep", bubbles: ["Zzz...", "*idle*", "Waiting for a task"], minDuration: 6000, maxDuration: 14000 },
];

// ── POI bubble text (keyed by substring of POI name) ─────
export const POI_BUBBLE_TEXTS: Record<string, string[]> = {
  water: ["Getting water...", "Staying hydrated!", "Refilling~"],
  printer: ["Checking prints...", "Printing logs...", "Paper jam again?"],
  book: ["Browsing the docs...", "Looking up a reference~", "Good read!"],
  whiteboard: ["Sketching the design~", "Reviewing the plan", "Hmm, let me think..."],
  sofa: ["Taking a break~", "Quick rest...", "Standup in 5"],
  bench: ["Tinkering...", "Side quest~", "Prototyping"],
};

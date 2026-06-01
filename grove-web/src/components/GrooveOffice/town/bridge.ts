import type { DashboardSnapshot } from "../../../api/dashboard";
import { WORKER_SPRITES } from "./config/animations";
import type { OfficeScene } from "./scenes/OfficeScene";
import type { SeatState } from "./types";

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Repo slug → readable name: "FB-Marketplace_lister" → "FB Marketplace Lister". */
function prettify(name: string): string {
  const out = name
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    // Title-case all-lowercase words; leave acronyms / CamelCase as written.
    .map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
  return out || name;
}

interface FlatAgent {
  id: string;
  agentKey: string;
  project: string;
  label: string;
  state: "active" | "idle" | "unknown";
  tokens: number;
}

function flatten(snap: DashboardSnapshot): FlatAgent[] {
  const out: FlatAgent[] = [];
  for (const p of snap.projects) {
    for (const a of p.agents) {
      out.push({
        id: a.id,
        agentKey: a.agent,
        project: p.name,
        label: a.label,
        state: a.state,
        tokens: a.tokens_total,
      });
    }
  }
  // Most "interesting" first: active, then by token volume.
  const rank = (s: FlatAgent["state"]) => (s === "active" ? 0 : s === "idle" ? 1 : 2);
  return out.sort((a, b) => rank(a.state) - rank(b.state) || b.tokens - a.tokens);
}

/**
 * Maps Grove's dashboard snapshot onto the fixed office desks. Agents are pinned
 * to a seat for as long as they exist (no churn between polls); when there are
 * more agents than desks, the most active/highest-volume agents get seated and
 * the rest wait in the lobby (surfaced as `overflow`).
 */
export class TownBridge {
  /** agentId -> seatId */
  private assignment = new Map<string, string>();
  overflow = 0;
  seated = 0;

  apply(scene: OfficeScene, snap: DashboardSnapshot) {
    const seatIds = scene.seatDefs.map((s) => s.seatId);
    if (seatIds.length === 0) return;

    const agents = flatten(snap);
    const byId = new Map(agents.map((a) => [a.id, a]));

    // 1. Release seats whose agent disappeared.
    for (const [agentId, seatId] of [...this.assignment]) {
      if (!byId.has(agentId)) this.assignment.delete(agentId);
      else void seatId;
    }

    // 2. Seat as many agents as there are desks (priority order from flatten()).
    const takenSeats = new Set(this.assignment.values());
    const freeSeats = seatIds.filter((s) => !takenSeats.has(s));
    const wanted = agents.slice(0, seatIds.length);
    for (const a of wanted) {
      if (this.assignment.has(a.id)) continue;
      const seat = freeSeats.shift();
      if (!seat) break;
      this.assignment.set(a.id, seat);
    }
    // Drop assignments for agents that lost priority (more agents than seats).
    const wantedIds = new Set(wanted.map((a) => a.id));
    for (const agentId of [...this.assignment.keys()]) {
      if (!wantedIds.has(agentId)) this.assignment.delete(agentId);
    }

    this.seated = this.assignment.size;
    this.overflow = Math.max(0, agents.length - this.seated);

    // 3. Build the seat list and sync sprites.
    const seatToAgent = new Map<string, FlatAgent>();
    for (const [agentId, seatId] of this.assignment) {
      const a = byId.get(agentId);
      if (a) seatToAgent.set(seatId, a);
    }
    const seats: SeatState[] = seatIds.map((seatId) => {
      const a = seatToAgent.get(seatId);
      if (!a) return { seatId, label: "", assigned: false };
      const sprite = WORKER_SPRITES[hash(a.id) % WORKER_SPRITES.length].key;
      return { seatId, label: prettify(a.project), assigned: true, spriteKey: sprite };
    });
    scene.syncWorkers(seats);

    // 4. Drive per-worker status + task bubble.
    for (const [seatId, a] of seatToAgent) {
      const w = scene.workerManager.findBySeatId(seatId);
      if (!w) continue;
      const active = a.state === "active";
      if (active) {
        if (w.assignedRunId !== a.id) {
          w.assignTask(a.id, a.label || `working in ${a.project}`);
        }
      } else if (w.status === "working") {
        w.completeTask();
      }
    }
  }
}

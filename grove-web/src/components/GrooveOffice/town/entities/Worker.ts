import * as Phaser from "phaser";
import { FRAME_HEIGHT, makeAnims, type Direction } from "../config/animations";
import { EMOTE_SHEET_KEY, EMOTE_ANIMS } from "../config/emotes";
import { ChatBubble } from "./ChatBubble";
import type { Pathfinder, PathPoint } from "../utils/Pathfinder";
import { buildSpriteFrames } from "../utils/MapHelpers";
import {
  WANDER_INITIAL_MIN,
  WANDER_INITIAL_MAX,
  EMOTE_Y_OFFSET,
  BUBBLE_Y_OFFSET,
} from "../constants";

// Sub-modules
import type { WorkerCtx, WorkerStatus, QueuedTask, POI } from "./worker/types";
import {
  BODY_WIDTH,
  BODY_HEIGHT,
  BODY_OFFSET_X,
  BODY_OFFSET_Y,
  updateMovement,
  navigateTo as movNavigateTo,
  navigateHome as movNavigateHome,
  isAtHomePose as movIsAtHomePose,
} from "./worker/movement";
import {
  resetWanderClock,
  scheduleWander as idleScheduleWander,
  stopIdleActivity as idleStopIdleActivity,
} from "./worker/idle";
import {
  assignTask as taskAssignTask,
  completeTask as taskCompleteTask,
  failTask as taskFailTask,
  abortTask as taskAbortTask,
  enqueueTask as taskEnqueueTask,
} from "./worker/task";

export { resetWanderClock };
export type { WorkerStatus, POI };

export class Worker implements WorkerCtx {
  sprite: Phaser.Physics.Arcade.Sprite;
  bubble: ChatBubble;
  readonly seatId: string;
  readonly label: string;
  readonly spriteKey: string;
  readonly homeX: number;
  readonly homeY: number;
  readonly scene: Phaser.Scene;
  readonly initialFacing: Direction;

  // Movement state (exposed for sub-modules via WorkerCtx)
  facing: Direction;
  moveTarget: { x: number; y: number } | null = null;
  currentPath: PathPoint[] = [];
  pathIndex = 0;
  isReturningHome = false;
  faceTarget: { x: number; y: number } | null = null;
  arrivalFacing: Direction | null = null;
  onArrival: (() => void) | null = null;
  stuckFrames = 0;
  lastX = 0;
  lastY = 0;
  pathfinder: Pathfinder | null = null;

  // Idle / wander state
  canWander = true;
  isWandering = false;
  pois: POI[] = [];
  wanderTimer: Phaser.Time.TimerEvent | null = null;
  activityTimer: Phaser.Time.TimerEvent | null = null;
  interactionLocked = false;

  // Task state
  _status: WorkerStatus = "idle";
  assignedRunId: string | null = null;
  currentTaskMessage: string | null = null;
  taskQueue: QueuedTask[] = [];
  taskVisualTimer: Phaser.Time.TimerEvent | null = null;

  // Internal
  private nameTag: Phaser.GameObjects.Text;
  private taskStatusText: Phaser.GameObjects.Text;
  private statusDot: Phaser.GameObjects.Arc;
  private emoteSprite: Phaser.GameObjects.Sprite | null = null;
  private currentEmoteKey: string | null = null;
  private initTimer: Phaser.Time.TimerEvent | null = null;
  private paused = false;
  private savedVx = 0;
  private savedVy = 0;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    spriteKey: string,
    seatId: string,
    label: string,
    facing: Direction = "up",
  ) {
    this.scene = scene;
    this.seatId = seatId;
    this.label = label;
    this.spriteKey = spriteKey;
    this.facing = facing;
    this.initialFacing = facing;
    this.homeX = x;
    this.homeY = y;

    this.ensureAnims(scene, spriteKey);

    this.sprite = scene.physics.add.sprite(x, y, spriteKey, 0);
    this.sprite.setDepth(5);
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.setSize(BODY_WIDTH, BODY_HEIGHT);
    body.setOffset(BODY_OFFSET_X, BODY_OFFSET_Y);
    body.allowGravity = false;
    body.pushable = false;
    body.mass = 999;

    this.sprite.anims.play(`${spriteKey}:idle-${facing}`);

    // Nameplate: a clean sans label (not the pixel font) for legibility, drawn
    // at 2× device resolution so it stays crisp under the pixel-art camera zoom.
    const NAME_FONT =
      'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
    const nameY = y + FRAME_HEIGHT / 2 + 2;
    this.nameTag = scene.add
      .text(x, nameY, label, {
        fontFamily: NAME_FONT,
        fontSize: "11px",
        fontStyle: "600",
        color: "#f2f4f8",
        backgroundColor: "rgba(17,19,26,0.82)",
        padding: { x: 5, y: 2 },
        align: "center",
      })
      .setResolution(Math.max(2, window.devicePixelRatio * 2))
      .setOrigin(0.5, 0)
      .setDepth(20);

    this.statusDot = scene.add.circle(x - this.nameTag.width / 2 - 7, nameY + 8, 3.5, 0x888888);
    this.statusDot.setDepth(20);

    this.taskStatusText = scene.add
      .text(x, nameY + 20, "", {
        fontFamily: NAME_FONT,
        fontSize: "10px",
        color: "#facc15",
        backgroundColor: "rgba(17,19,26,0.85)",
        padding: { x: 5, y: 2 },
        align: "center",
      })
      .setResolution(Math.max(2, window.devicePixelRatio * 2))
      .setOrigin(0.5, 0)
      .setDepth(20)
      .setVisible(false);

    this.bubble = new ChatBubble(scene);
    this.initEmoteSprite();

    const initialDelay = Phaser.Math.Between(WANDER_INITIAL_MIN, WANDER_INITIAL_MAX);
    this.initTimer = scene.time.delayedCall(initialDelay, () => {
      this.initTimer = null;
      this.scheduleWander();
    });
  }

  // ── Emote system ──────────────────────────────────────

  private initEmoteSprite() {
    if (!this.scene.textures.exists(EMOTE_SHEET_KEY)) return;

    this.emoteSprite = this.scene.add.sprite(
      this.sprite.x,
      this.sprite.y - FRAME_HEIGHT * EMOTE_Y_OFFSET,
      EMOTE_SHEET_KEY,
      0,
    );
    this.emoteSprite.setDepth(22);
    this.emoteSprite.setVisible(false);

    this.registerEmoteAnims();
  }

  private registerEmoteAnims() {
    for (const def of EMOTE_ANIMS) {
      if (this.scene.anims.exists(def.key)) continue;
      const frames = def.frames.map((f) => ({ key: EMOTE_SHEET_KEY, frame: f }));
      this.scene.anims.create({
        key: def.key,
        frames,
        frameRate: def.frameRate,
        repeat: def.repeat,
      });
    }
  }

  showEmote(emoteKey: string) {
    if (!this.emoteSprite) return;
    if (this.currentEmoteKey === emoteKey) return;

    this.bubble.hide();
    this.emoteSprite.removeAllListeners("animationcomplete");

    this.currentEmoteKey = emoteKey;
    this.emoteSprite.setVisible(true);
    this.emoteSprite.play(emoteKey);

    const anim = EMOTE_ANIMS.find((a) => a.key === emoteKey);
    if (anim && anim.repeat >= 0) {
      this.emoteSprite.once("animationcomplete", () => {
        if (!this.emoteSprite) return;
        this.emoteSprite.setVisible(false);
        this.currentEmoteKey = null;
      });
    }
  }

  hideEmote() {
    if (!this.emoteSprite) return;
    this.emoteSprite.removeAllListeners("animationcomplete");
    this.emoteSprite.setVisible(false);
    this.emoteSprite.stop();
    this.currentEmoteKey = null;
  }

  // ── Animation registration ────────────────────────────

  private ensureAnims(scene: Phaser.Scene, spriteKey: string) {
    if (scene.anims.exists(`${spriteKey}:idle-down`)) return;

    buildSpriteFrames(scene, spriteKey);

    const idleAnims = makeAnims(spriteKey, "idle", 1, 8);
    const walkAnims = makeAnims(spriteKey, "walk", 2, 10);
    for (const anim of [...idleAnims, ...walkAnims]) {
      const frames: Phaser.Types.Animations.AnimationFrame[] = [];
      for (let i = anim.start; i <= anim.end; i++) {
        frames.push({ key: spriteKey, frame: i });
      }
      scene.anims.create({
        key: anim.key,
        frames,
        frameRate: anim.frameRate,
        repeat: anim.repeat,
      });
    }
  }

  // ── Status ────────────────────────────────────────────

  get status(): WorkerStatus {
    return this._status;
  }

  setStatus(status: WorkerStatus) {
    this._status = status;
    const colors: Record<WorkerStatus, number> = {
      idle: 0x888888,
      working: 0xfacc15,
      done: 0x22c55e,
      failed: 0xef4444,
    };
    this.statusDot.setFillStyle(colors[status]);

    if (status === "idle") {
      this.canWander = true;
      this.scheduleWander();
    } else if (status === "working") {
      this.stopIdleActivity();
      this.canWander = false;
    } else {
      this.canWander = false;
    }
  }

  // ── Delegated: Movement ───────────────────────────────

  navigateTo(x: number, y: number, facePoi?: { x: number; y: number }) {
    movNavigateTo(this, x, y, facePoi);
  }

  navigateHome() {
    movNavigateHome(this);
  }

  isAtHomePose() {
    return movIsAtHomePose(this);
  }

  // ── Delegated: Task management ────────────────────────

  assignTask(runId: string, taskMessage: string, onReady?: () => void) {
    taskAssignTask(this, runId, taskMessage, onReady);
  }

  completeTask() {
    taskCompleteTask(this);
  }

  failTask() {
    taskFailTask(this);
  }

  abortTask(runId: string) {
    return taskAbortTask(this, runId);
  }

  enqueueTask(runId: string, message: string, onReady?: () => void) {
    taskEnqueueTask(this, runId, message, onReady);
  }

  // ── Delegated: Idle behavior ──────────────────────────

  stopIdleActivity() {
    idleStopIdleActivity(this);
  }

  scheduleWander() {
    idleScheduleWander(this);
  }

  // ── Bubble ────────────────────────────────────────────

  showBubble(message: string, ttl = 5000) {
    this.hideEmote();
    const bubbleX = this.sprite.x;
    const bubbleY = this.sprite.y - FRAME_HEIGHT * BUBBLE_Y_OFFSET;
    this.bubble.show(message, bubbleX, bubbleY, ttl);
  }

  // ── Public helpers ────────────────────────────────────

  setPOIs(pois: POI[]) {
    this.pois = pois;
  }

  setPathfinder(pf: Pathfinder) {
    this.pathfinder = pf;
  }

  canInteract() {
    return !this.interactionLocked;
  }

  isAwayFromDesk() {
    return this.moveTarget !== null || this.isWandering || !this.isAtHomePose();
  }

  rebindAssignedRun(previousRunId: string, nextRunId: string) {
    if (this.assignedRunId === previousRunId) {
      this.assignedRunId = nextRunId;
    }
  }

  // ── Pause / Resume (boss proximity) ──────────────────

  pause() {
    if (this.paused) return;
    this.paused = true;
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    this.savedVx = body.velocity.x;
    this.savedVy = body.velocity.y;
    body.setVelocity(0, 0);

    const idleKey = `${this.spriteKey}:idle-${this.facing}`;
    if (this.sprite.anims.currentAnim?.key !== idleKey) {
      this.sprite.anims.play(idleKey);
    }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.moveTarget) {
      const body = this.sprite.body as Phaser.Physics.Arcade.Body;
      body.setVelocity(this.savedVx, this.savedVy);
    }
  }

  // ── Update (call from scene.update) ───────────────────

  update() {
    if (!this.paused) updateMovement(this);

    const nameY = this.sprite.y + FRAME_HEIGHT / 2 + 2;
    this.nameTag.setPosition(this.sprite.x, nameY);
    this.statusDot.setPosition(this.sprite.x - this.nameTag.width / 2 - 7, nameY + 8);

    const hasTask = this.assignedRunId || this.taskQueue.length > 0;
    if (this.taskStatusText) {
      this.taskStatusText.setPosition(this.sprite.x, nameY + 20);
      if (hasTask) {
        const parts: string[] = [];
        if (this.currentTaskMessage) {
          const snip =
            this.currentTaskMessage.length > 20
              ? `${this.currentTaskMessage.slice(0, 20)}...`
              : this.currentTaskMessage;
          parts.push(`📋 ${snip}`);
        }
        if (this.taskQueue.length > 0) {
          parts.push(`Queue: ${this.taskQueue.length}`);
        }
        this.taskStatusText.setText(parts.join(" | "));
        this.taskStatusText.setVisible(true);
      } else {
        this.taskStatusText.setVisible(false);
      }
    }

    if (this.emoteSprite) {
      this.emoteSprite.setPosition(this.sprite.x, this.sprite.y - FRAME_HEIGHT * EMOTE_Y_OFFSET);
    }

    if (this.bubble) {
      this.bubble.updatePosition(this.sprite.x, this.sprite.y - FRAME_HEIGHT * BUBBLE_Y_OFFSET);
    }
  }

  // ── Cleanup ───────────────────────────────────────────

  destroy() {
    if (this.initTimer) {
      this.initTimer.destroy();
      this.initTimer = null;
    }
    this.interactionLocked = false;
    this.stopIdleActivity();
    if (this.taskVisualTimer) {
      this.taskVisualTimer.destroy();
      this.taskVisualTimer = null;
    }
    if (this.emoteSprite) {
      this.emoteSprite.removeAllListeners();
      this.emoteSprite.destroy();
      this.emoteSprite = null;
    }
    this.sprite.destroy();
    this.nameTag.destroy();
    this.taskStatusText.destroy();
    this.statusDot.destroy();
    this.bubble.destroy();
    this.pathfinder = null;
    this.onArrival = null;
  }
}

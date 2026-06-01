import * as Phaser from "phaser";
import { WORKER_SPRITES } from "../config/animations";
import { EMOTE_SHEET_KEY, EMOTE_SHEET_PATH, EMOTE_FRAME_SIZE } from "../config/emotes";
import { Pathfinder } from "../utils/Pathfinder";
import {
  buildSpriteFrames,
  parseSpawns,
  parsePOIs,
  buildCollisionRects,
  renderTileObjectLayer,
  type AnimatedProp,
  type SeatDef,
} from "../utils/MapHelpers";
import { resetWanderClock } from "../entities/Worker";
import { WorkerManager } from "../systems/WorkerManager";
import { PF_PADDING } from "../constants";
import type { SeatState } from "../types";

const MAP_KEY = "office";
const MAP_URL = "/office/town/maps/office2.json";
const TILESET_BASE = "/office/town/tilesets/";

/**
 * Read-only ambient office. Adapted from Agent Town (MIT) — renders its Tiled
 * office map + LimeZu tiles, then spawns "worker" characters that sit at desks,
 * wander to points of interest, and pop chat bubbles. There is no playable boss
 * or interaction layer here: the scene is a living TV-wall display driven by
 * Grove's dashboard snapshot via {@link syncWorkers}.
 */
export class OfficeScene extends Phaser.Scene {
  workerManager!: WorkerManager;
  seatDefs: SeatDef[] = [];
  private mapW = 0;
  private mapH = 0;
  private onReady?: (scene: OfficeScene) => void;

  constructor() {
    super({ key: "OfficeScene" });
  }

  init(data: { onReady?: (scene: OfficeScene) => void }) {
    this.onReady = data?.onReady;
  }

  preload() {
    this.load.tilemapTiledJSON(MAP_KEY, MAP_URL);

    this.load.once(`filecomplete-tilemapJSON-${MAP_KEY}`, () => {
      const cached = this.cache.tilemap.get(MAP_KEY);
      if (!cached?.data?.tilesets) return;
      for (const ts of cached.data.tilesets) {
        if (!ts.image) continue;
        const basename = (ts.image as string).split("/").pop()!;
        this.load.image(ts.name, `${TILESET_BASE}${basename}`);
      }
    });

    for (const ws of WORKER_SPRITES) this.load.image(ws.key, ws.path);

    this.load.spritesheet(EMOTE_SHEET_KEY, EMOTE_SHEET_PATH, {
      frameWidth: EMOTE_FRAME_SIZE,
      frameHeight: EMOTE_FRAME_SIZE,
    });
    this.load.spritesheet("anim-cauldron", "/office/town/sprites/animated_witch_cauldron_48x48.png", {
      frameWidth: 96,
      frameHeight: 96,
    });
  }

  create() {
    for (const ws of WORKER_SPRITES) buildSpriteFrames(this, ws.key);

    const map = this.make.tilemap({ key: MAP_KEY });
    this.mapW = map.widthInPixels;
    this.mapH = map.heightInPixels;

    const tilesets: Phaser.Tilemaps.Tileset[] = [];
    for (const ts of map.tilesets) {
      const added = map.addTilesetImage(ts.name, ts.name);
      if (added) tilesets.push(added);
    }
    if (tilesets.length === 0) {
      console.error("[town] no tilesets loaded");
      return;
    }

    // Tile layers (back → front)
    for (const name of ["floor", "walls", "ground", "furniture", "objects"]) {
      map.createLayer(name, tilesets);
    }

    // Object layers rendered as images (furniture/decor placed in Tiled)
    const animatedProps: AnimatedProp[] = [
      {
        tilesetName: "11_Halloween_48x48",
        anchorLocalId: 130,
        skipLocalIds: new Set([130, 131, 146, 147]),
        spriteKey: "anim-cauldron",
        frameWidth: 96,
        frameHeight: 96,
        endFrame: 11,
        frameRate: 8,
      },
    ];
    renderTileObjectLayer(this, map, "props", tilesets, 5, animatedProps);
    renderTileObjectLayer(this, map, "props-over", tilesets, 11);

    const overhead = map.createLayer("overhead", tilesets);
    if (overhead) overhead.setDepth(10);

    // Collisions + pathfinding
    const collisionGroup = this.physics.add.staticGroup();
    const collisionRects = buildCollisionRects(map, collisionGroup);
    const pathfinder = new Pathfinder(this.mapW, this.mapH, collisionRects, PF_PADDING);

    const { workerSpawns } = parseSpawns(map);
    const pois = parsePOIs(map);
    this.seatDefs = workerSpawns;

    this.physics.world.setBounds(0, 0, this.mapW, this.mapH);

    this.workerManager = new WorkerManager(this, workerSpawns, pois, pathfinder);

    resetWanderClock();
    this.fitCamera();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.fitCamera, this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.fitCamera, this);
      this.workerManager?.destroyAll();
    });

    this.onReady?.(this);
  }

  /** Center + zoom the camera so the whole office fills the viewport. */
  private fitCamera() {
    const cam = this.cameras.main;
    const vw = this.scale.width;
    const vh = this.scale.height;
    if (!vw || !vh || !this.mapW) return;
    const zoom = Math.min(vw / this.mapW, vh / this.mapH);
    cam.setZoom(zoom);
    cam.setBounds(0, 0, this.mapW, this.mapH);
    cam.centerOn(this.mapW / 2, this.mapH / 2);
  }

  /** Spawn/despawn worker sprites to match the given seat assignments. */
  syncWorkers(seats: SeatState[]) {
    this.workerManager?.syncWorkers(seats, () => {});
  }

  update() {
    this.workerManager?.updateAll();
  }
}

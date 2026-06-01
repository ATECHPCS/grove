import { useEffect, useRef } from "react";
import type { DashboardSnapshot } from "../../../api/dashboard";
import type { OfficeScene } from "./scenes/OfficeScene";
import type { TownBridge } from "./bridge";

/**
 * Mounts the Phaser pixel-office and feeds it Grove's dashboard snapshot.
 * Phaser (and the whole engine) is dynamically imported so it only loads on the
 * office route and stays out of the main app chunk.
 */
export function PhaserGame({ snapshot }: { snapshot: DashboardSnapshot | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const bridgeRef = useRef<TownBridge | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gameRef = useRef<any>(null);
  const pendingRef = useRef<DashboardSnapshot | null>(null);

  useEffect(() => {
    let destroyed = false;

    void (async () => {
      const mod = await import("phaser");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Phaser = ((mod as any).default ?? mod) as typeof import("phaser");
      const [{ OfficeScene }, { TownBridge }] = await Promise.all([
        import("./scenes/OfficeScene"),
        import("./bridge"),
      ]);
      if (destroyed || !containerRef.current) return;

      bridgeRef.current = new TownBridge();
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: containerRef.current,
        width: containerRef.current.clientWidth || 1280,
        height: containerRef.current.clientHeight || 720,
        pixelArt: true,
        antialias: false,
        roundPixels: true,
        backgroundColor: "#171320",
        scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER },
        physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 } } },
      });
      gameRef.current = game;

      game.scene.add("OfficeScene", OfficeScene, true, {
        onReady: (scene: OfficeScene) => {
          sceneRef.current = scene;
          if (pendingRef.current && bridgeRef.current) {
            bridgeRef.current.apply(scene, pendingRef.current);
            pendingRef.current = null;
          }
        },
      });
    })();

    return () => {
      destroyed = true;
      sceneRef.current = null;
      bridgeRef.current = null;
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    if (sceneRef.current && bridgeRef.current) {
      bridgeRef.current.apply(sceneRef.current, snapshot);
    } else {
      pendingRef.current = snapshot;
    }
  }, [snapshot]);

  return <div ref={containerRef} className="town-canvas" />;
}

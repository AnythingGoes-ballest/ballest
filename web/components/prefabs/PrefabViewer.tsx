"use client";
// A Prefab drawn in three.js, starting from its angle. It turns
// slowly on its own until someone grabs it (not under reduced motion); drag to turn, wheel
// or pinch to zoom, right-drag to pan. three loads only where a viewer is. A parent that
// needs to steer it takes useViewer() and passes its `attach`: home() goes back to the angle,
// and angleNow() reads the view it shows now.
import { useCallback, useEffect, useRef } from "react";

import { TURN_EVENT, VIEW_FOV, angleNow, buildScene, framing, loadThree, planesFor } from "./scene";
import type { PrefabFile } from "../../lib/prefab";
import type { PrefabAngle } from "../../lib/prefabs";

export function PrefabViewer({
  file,
  className,
  spin = true,
  controls: interactive = true,
  angle = null,
  water = null,
  attach,
  onTurn,
}: {
  file: PrefabFile;
  className?: string;
  spin?: boolean;
  controls?: boolean;
  angle?: PrefabAngle | null;
  /* the height of the water a Map sits in (scene.ts buildScene) */
  water?: number | null;
  attach?: (viewer: Viewer | null) => void;
  /* someone grabbed it to turn, zoom or pan */
  onTurn?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  /* read at each home(), so a new angle moves the camera there without rebuilding the
     scene; compared by value, so the same view arriving again doesn't */
  const home = useRef(angle);
  const goHome = useRef<(() => void) | null>(null);
  /* the latest onTurn, so a new one doesn't rebuild the scene */
  const turned = useRef(onTurn);
  useEffect(() => {
    turned.current = onTurn;
  }, [onTurn]);
  const view = JSON.stringify(angle);
  useEffect(() => {
    home.current = angle;
    goHome.current?.();
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps -- by value

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let stop: (() => void) | undefined;
    const run = { cancelled: false };
    void (async () => {
      const three = await loadThree();
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      if (run.cancelled) return;
      const { THREE } = three;
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      el.appendChild(renderer.domElement);
      const { scene, centre, radius } = buildScene(three, file, interactive, water);
      const camera = new THREE.PerspectiveCamera(VIEW_FOV, 1, ...planesFor(radius));
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enabled = interactive;
      controls.enableDamping = true;
      controls.autoRotate = spin && !matchMedia("(prefers-reduced-motion: reduce)").matches;
      controls.autoRotateSpeed = 1.6;
      /* the spin only says "this is 3D": the first grab stops it for good */
      controls.addEventListener("start", () => {
        controls.autoRotate = false;
        turned.current?.();
      });
      const toHome = () => {
        const view = framing(THREE, camera, centre, radius, home.current);
        camera.position.copy(view.position);
        controls.target.copy(view.target);
        controls.update();
      };
      goHome.current = toHome;
      attach?.({
        home: toHome,
        angleNow: () => angleNow(camera, controls.target, centre, radius),
      });
      const resize = () => {
        const { width, height } = el.getBoundingClientRect();
        renderer.setSize(width, height, false);
        camera.aspect = width / Math.max(height, 1);
        camera.updateProjectionMatrix();
        /* a resize clears the canvas, which the loop would draw again but a turned view
           (below) has stopped */
        if (turns > 0) renderer.render(scene, camera);
      };
      let turns = 0;
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();
      toHome();
      el.dataset.ready = "1";
      renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
      });
      /* a script drawing the view a frame at a time (scripts/map-spin.ts) sends the host
         TURN_EVENT: the first stops the loop for good, and each one turns the camera around
         the target by its detail in radians, the way a drag to the right does, and draws once,
         counting them in data-turns. Without the spin or easing, the controls take the
         camera where it was put, so a later home() still starts from the view drawn. */
      const turn = (e: Event) => {
        renderer.setAnimationLoop(null);
        controls.autoRotate = false;
        controls.enableDamping = false;
        const by = Number((e as CustomEvent<unknown>).detail) || 0;
        const offset = camera.position.clone().sub(controls.target);
        camera.position.copy(controls.target).add(offset.applyAxisAngle(camera.up, -by));
        controls.update();
        renderer.render(scene, camera);
        el.dataset.turns = String(++turns);
      };
      el.addEventListener(TURN_EVENT, turn);
      stop = () => {
        el.removeEventListener(TURN_EVENT, turn);
        delete el.dataset.turns;
        attach?.(null);
        goHome.current = null;
        ro.disconnect();
        renderer.setAnimationLoop(null);
        controls.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();
    return () => {
      run.cancelled = true;
      stop?.();
    };
  }, [file, spin, interactive, attach, water]);

  return <div ref={host} className={className ?? "pfv"} />;
}

interface Viewer {
  home: () => void;
  angleNow: () => PrefabAngle;
}

/* a handle on a viewer: pass `attach` to it; home() and angleNow() do nothing, or read null,
   until it has drawn */
export function useViewer() {
  const viewer = useRef<Viewer | null>(null);
  const attach = useCallback((v: Viewer | null) => {
    viewer.current = v;
  }, []);
  return {
    attach,
    home: () => viewer.current?.home(),
    angleNow: () => viewer.current?.angleNow() ?? null,
  };
}

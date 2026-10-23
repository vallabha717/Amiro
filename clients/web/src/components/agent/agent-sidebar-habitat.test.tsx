import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentSidebarHabitat,
  getMascotMotion,
} from "./agent-sidebar-habitat";

const habitatSource = readFileSync(
  path.join(import.meta.dirname, "agent-sidebar-habitat.tsx"),
  "utf8",
);

function renderHabitat(props: {
  bodyShape: string;
  paused?: boolean;
  prefersReducedMotion?: boolean;
}) {
  return renderToStaticMarkup(
    createElement(AgentSidebarHabitat, {
      name: "Amiro",
      traits: {
        bodyShape: props.bodyShape,
        eyeStyle: "curious",
        color: "orange",
      },
      accent: "#E9642F",
      paused: props.paused,
      prefersReducedMotion: props.prefersReducedMotion,
    }),
  );
}

function extractDataMotion(html: string): string | null {
  const match = html.match(/data-motion="([^"]+)"/);
  return match ? match[1] : null;
}

describe("AgentSidebarHabitat body-specific motion and reduced motion", () => {
  it("has body-specific dance/swim/sway/drift: blob, sprout, star, cloud each differ", () => {
    expect(habitatSource).toMatch(/case "blob"/);
    expect(habitatSource).toMatch(/case "sprout"/);
    expect(habitatSource).toMatch(/case "star"/);
    expect(habitatSource).toMatch(/case "cloud"/);

    // dance (blob): rhythmic bounce, side steps, squash bounce, ~1.6s loop
    expect(habitatSource).toMatch(/y: \[0, -10/);
    expect(habitatSource).toMatch(/x: \[0, -8, 8/);
    expect(habitatSource).toMatch(/scaleX: \[1.08, 0.94/);
    expect(habitatSource).toMatch(/scaleY: \[0.92, 1.06/);

    // swim (star): lateral glide back and forth, gentle roll and bob, ~4s loop
    expect(habitatSource).toMatch(/x: \[-24, 24, -24\]/);
    expect(habitatSource).toMatch(/y: \[0, -4, 0, -4, 0\]/);
    expect(habitatSource).toMatch(/rotate: \[-6, 6, -6\]/);

    // sway (sprout): gentle side sway
    expect(habitatSource).toMatch(/rotate: \[-5, 5, -5\]/);
    expect(habitatSource).toMatch(/y: \[0, -3, 0\]/);

    // drift (cloud): slow wide horizontal drift
    expect(habitatSource).toMatch(/x: \[-30, 30, -30\]/);
  });

  it("exposes distinct named data-motion attributes for each mascot form", () => {
    const blobHtml = renderHabitat({ bodyShape: "blob" });
    const starHtml = renderHabitat({ bodyShape: "star" });
    const sproutHtml = renderHabitat({ bodyShape: "sprout" });
    const cloudHtml = renderHabitat({ bodyShape: "cloud" });

    const blobMotion = extractDataMotion(blobHtml);
    const starMotion = extractDataMotion(starHtml);
    const sproutMotion = extractDataMotion(sproutHtml);
    const cloudMotion = extractDataMotion(cloudHtml);

    expect(blobMotion).toBe("dance");
    expect(starMotion).toBe("swim");
    expect(sproutMotion).toBe("sway");
    expect(cloudMotion).toBe("drift");

    const distinct = new Set([blobMotion, starMotion, sproutMotion, cloudMotion]);
    expect(distinct.size).toBe(4);
  });

  it("maps getMascotMotion helper correctly for all shapes", () => {
    expect(getMascotMotion("blob")).toBe("dance");
    expect(getMascotMotion("star")).toBe("swim");
    expect(getMascotMotion("sprout")).toBe("sway");
    expect(getMascotMotion("cloud")).toBe("drift");
    expect(getMascotMotion("ghost")).toBe("dance");
    expect(getMascotMotion("urchin")).toBe("dance");
  });

  it("sets data-motion to none when paused", () => {
    const blobPaused = renderHabitat({ bodyShape: "blob", paused: true });
    const starPaused = renderHabitat({ bodyShape: "star", paused: true });
    const sproutPaused = renderHabitat({ bodyShape: "sprout", paused: true });
    const cloudPaused = renderHabitat({ bodyShape: "cloud", paused: true });

    expect(extractDataMotion(blobPaused)).toBe("none");
    expect(extractDataMotion(starPaused)).toBe("none");
    expect(extractDataMotion(sproutPaused)).toBe("none");
    expect(extractDataMotion(cloudPaused)).toBe("none");
  });

  it("sets data-motion to none when prefers-reduced-motion is active", () => {
    const blobReduced = renderHabitat({
      bodyShape: "blob",
      prefersReducedMotion: true,
    });
    const starReduced = renderHabitat({
      bodyShape: "star",
      prefersReducedMotion: true,
    });
    const sproutReduced = renderHabitat({
      bodyShape: "sprout",
      prefersReducedMotion: true,
    });
    const cloudReduced = renderHabitat({
      bodyShape: "cloud",
      prefersReducedMotion: true,
    });

    expect(extractDataMotion(blobReduced)).toBe("none");
    expect(extractDataMotion(starReduced)).toBe("none");
    expect(extractDataMotion(sproutReduced)).toBe("none");
    expect(extractDataMotion(cloudReduced)).toBe("none");
  });

  it("normalizes legacy ghost and urchin shapes to blob dance", () => {
    const ghostHtml = renderHabitat({ bodyShape: "ghost" });
    const urchinHtml = renderHabitat({ bodyShape: "urchin" });

    expect(extractDataMotion(ghostHtml)).toBe("dance");
    expect(extractDataMotion(urchinHtml)).toBe("dance");
  });

  it("reduced motion preserves eyes: animated=false passed to avatar when reduceMotion", () => {
    expect(habitatSource).toMatch(/animated=\{!reduceMotion\}/);
    expect(habitatSource).toMatch(/if \(reduceMotion\) return \{ x: 0, y: 0, rotate: 0/);
  });

  it("cube per-shape motion exists alongside avatar motion", () => {
    expect(habitatSource).toMatch(/cubeAnim/);
    expect(habitatSource).toMatch(/cubeTransition/);
    expect(habitatSource).toContain("AgentCharacterAvatar");
  });

  it("keeps pause and play button labels and greeting interaction", () => {
    expect(habitatSource).toContain(
      'aria-label={paused ? "Play agent animation" : "Pause agent animation"}',
    );
    expect(habitatSource).toMatch(/onPointerEnter=\{.*setGreeting\(true\)\}/);
    expect(habitatSource).toMatch(/onPointerLeave=\{.*setGreeting\(false\)\}/);
  });
});

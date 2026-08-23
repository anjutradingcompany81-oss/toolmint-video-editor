import {
  buildDelogoFilter,
  buildWatermarkFilterParts,
  canvasToOutputScale,
  clampWatermarkRegion,
  scaleWatermarkRegion,
  type WatermarkRegion,
} from "./watermark.util";

const CANVAS = { width: 1920, height: 1080 };

function region(over: Partial<WatermarkRegion> = {}): WatermarkRegion {
  return { id: "r1", x: 100, y: 200, width: 300, height: 150, ...over };
}

describe("clampWatermarkRegion", () => {
  it("passes through a region that already sits well inside the frame", () => {
    expect(clampWatermarkRegion(region(), CANVAS)).toEqual({ x: 100, y: 200, w: 300, h: 150 });
  });

  it("keeps a region off the right and bottom edges, where delogo has nothing to sample", () => {
    // Flush to the far corner: without the margin ffmpeg aborts the whole
    // render with "Logo area is outside of the frame".
    const clamped = clampWatermarkRegion(region({ x: 1900, y: 1060, width: 200, height: 200 }), CANVAS)!;
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(CANVAS.width - 1);
    expect(clamped.y + clamped.h).toBeLessThanOrEqual(CANVAS.height - 1);
  });

  it("keeps a region off the top and left edges", () => {
    const clamped = clampWatermarkRegion(region({ x: 0, y: 0 }), CANVAS)!;
    expect(clamped.x).toBeGreaterThanOrEqual(1);
    expect(clamped.y).toBeGreaterThanOrEqual(1);
  });

  it("pulls a negative origin back into the frame instead of emitting it", () => {
    const clamped = clampWatermarkRegion(region({ x: -500, y: -500 }), CANVAS)!;
    expect(clamped.x).toBe(1);
    expect(clamped.y).toBe(1);
  });

  it("shrinks a region wider than the frame to fit", () => {
    const clamped = clampWatermarkRegion(region({ x: 10, y: 10, width: 99999, height: 99999 }), CANVAS)!;
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(CANVAS.width - 1);
    expect(clamped.y + clamped.h).toBeLessThanOrEqual(CANVAS.height - 1);
  });

  it("rejects a zero-sized region rather than emitting an invalid filter", () => {
    expect(clampWatermarkRegion(region({ width: 0, height: 0 }), CANVAS)).toBeNull();
  });

  it("rejects a region too thin to be meaningful", () => {
    expect(clampWatermarkRegion(region({ width: 1, height: 1 }), CANVAS)).toBeNull();
  });

  it("rejects everything on a frame too small to hold a region with margins", () => {
    expect(clampWatermarkRegion(region(), { width: 2, height: 2 })).toBeNull();
  });

  it("rounds to whole pixels — delogo takes integers", () => {
    const clamped = clampWatermarkRegion(region({ x: 10.6, y: 20.4, width: 30.5, height: 40.4 }), CANVAS)!;
    expect(Number.isInteger(clamped.x)).toBe(true);
    expect(Number.isInteger(clamped.y)).toBe(true);
    expect(Number.isInteger(clamped.w)).toBe(true);
    expect(Number.isInteger(clamped.h)).toBe(true);
  });
});

describe("buildDelogoFilter", () => {
  it("is empty when there is nothing to remove, so no filter stage is added at all", () => {
    expect(buildDelogoFilter([], CANVAS)).toBe("");
  });

  it("emits one delogo per region", () => {
    const filter = buildDelogoFilter([region({ id: "a" }), region({ id: "b", x: 800, y: 50, width: 200, height: 80 })], CANVAS);
    expect(filter).toBe("delogo=x=100:y=200:w=300:h=150,delogo=x=800:y=50:w=200:h=80");
  });

  it("drops unusable regions but keeps the rest, rather than failing the whole export", () => {
    const filter = buildDelogoFilter([region({ id: "bad", width: 0, height: 0 }), region({ id: "good" })], CANVAS);
    expect(filter).toBe("delogo=x=100:y=200:w=300:h=150");
  });

  it("produces an empty string when every region is unusable", () => {
    expect(buildDelogoFilter([region({ width: 0, height: 0 })], CANVAS)).toBe("");
  });
});

describe("canvasToOutputScale / scaleWatermarkRegion", () => {
  it("is identity when the export matches the source size (an Original export)", () => {
    const scale = canvasToOutputScale({ width: 1920, height: 1080 }, { width: 1920, height: 1080 });
    expect(scale).toEqual({ x: 1, y: 1 });
    expect(scaleWatermarkRegion(region(), scale)).toEqual(region());
  });

  it("moves and shrinks a region when exporting smaller than the source", () => {
    // 1920x1080 source exported at 1280x720: everything is 2/3 size.
    const scale = canvasToOutputScale({ width: 1920, height: 1080 }, { width: 1280, height: 720 });
    expect(scaleWatermarkRegion(region({ x: 1500, y: 60, width: 300, height: 150 }), scale)).toMatchObject({
      x: 1000,
      y: 40,
      width: 200,
      height: 100,
    });
  });

  it("grows a region when exporting larger than the source", () => {
    const scale = canvasToOutputScale({ width: 640, height: 360 }, { width: 1280, height: 720 });
    expect(scaleWatermarkRegion(region({ x: 100, y: 50, width: 60, height: 30 }), scale)).toMatchObject({
      x: 200,
      y: 100,
      width: 120,
      height: 60,
    });
  });

  it("stays inside the output frame after scaling, so delogo still has pixels to sample", () => {
    const scale = canvasToOutputScale({ width: 640, height: 360 }, { width: 1280, height: 720 });
    const scaled = scaleWatermarkRegion(region({ x: 500, y: 300, width: 139, height: 59 }), scale);
    const clamped = clampWatermarkRegion(scaled, { width: 1280, height: 720 })!;
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(1279);
    expect(clamped.y + clamped.h).toBeLessThanOrEqual(719);
  });

  it("falls back to 1:1 rather than Infinity when the canvas size is unknown", () => {
    expect(canvasToOutputScale({ width: 0, height: 0 }, { width: 1280, height: 720 })).toEqual({ x: 1, y: 1 });
  });
});

describe("buildWatermarkFilterParts", () => {
  const IN = "base";
  const OUT = "wmrm";

  it("returns nothing to do when there are no regions", () => {
    expect(buildWatermarkFilterParts([], CANVAS, IN, OUT)).toEqual([]);
  });

  it("collapses every reconstruct region into a single in-place chain", () => {
    const parts = buildWatermarkFilterParts([region({ id: "a" }), region({ id: "b", x: 900 })], CANVAS, IN, OUT);
    expect(parts).toEqual([`[base]delogo=x=100:y=200:w=300:h=150,delogo=x=900:y=200:w=300:h=150[wmrm]`]);
  });

  it("cuts out, blurs and pastes back a blur region", () => {
    // A blur can't filter in place the way delogo does — the area has to be
    // cropped, treated and overlaid back at the same coordinates.
    const parts = buildWatermarkFilterParts([region({ mode: "BLUR" })], CANVAS, IN, OUT);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("split=2");
    expect(parts[1]).toContain("crop=300:150:100:200");
    expect(parts[1]).toContain("boxblur=");
    expect(parts[2]).toContain("overlay=100:200[wmrm]");
  });

  it("throws detail away for pixelate rather than smoothing it", () => {
    const parts = buildWatermarkFilterParts([region({ mode: "PIXELATE" })], CANVAS, IN, OUT);
    expect(parts[1]).toContain("flags=neighbor");
    expect(parts[1]).toContain("scale=300:150:flags=neighbor");
  });

  it("threads several cut-out regions through one graph, ending at the output label", () => {
    const parts = buildWatermarkFilterParts(
      [region({ id: "a", mode: "BLUR" }), region({ id: "b", x: 900, mode: "PIXELATE" })],
      CANVAS,
      IN,
      OUT,
    );
    // Every intermediate label must be produced before it is consumed, or
    // ffmpeg rejects the whole graph.
    expect(parts[0]).toContain("[base]");
    expect(parts[parts.length - 1]).toContain(`[${OUT}]`);
    const produced = new Set<string>();
    for (const part of parts) {
      for (const label of part.matchAll(/\[([a-z0-9_]+)\]/gi)) produced.add(label[1]!);
    }
    expect(produced.has(OUT)).toBe(true);
  });

  it("mixes reconstruct and blur regions without losing either", () => {
    const parts = buildWatermarkFilterParts(
      [region({ id: "a" }), region({ id: "b", x: 900, mode: "BLUR" })],
      CANVAS,
      IN,
      OUT,
    );
    expect(parts.some((p) => p.includes("delogo="))).toBe(true);
    expect(parts.some((p) => p.includes("boxblur="))).toBe(true);
    expect(parts[parts.length - 1]).toContain(`[${OUT}]`);
  });

  it("keeps the blur radius under half the region, which ffmpeg requires", () => {
    const parts = buildWatermarkFilterParts([region({ width: 12, height: 10, mode: "BLUR" })], CANVAS, IN, OUT);
    const radius = Number(/boxblur=(\d+)/.exec(parts[1]!)![1]);
    expect(radius).toBeGreaterThanOrEqual(2);
    expect(radius).toBeLessThan(10 / 2);
  });

  it("drops an unusable region instead of emitting a broken graph", () => {
    expect(buildWatermarkFilterParts([region({ width: 0, height: 0, mode: "BLUR" })], CANVAS, IN, OUT)).toEqual([]);
  });
});

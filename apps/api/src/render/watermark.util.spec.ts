import { buildDelogoFilter, clampWatermarkRegion, type WatermarkRegion } from "./watermark.util";

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

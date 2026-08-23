import { planTransitions, type TransitionClip } from "./transition.util";

const T = "track_1";
function clip(over: Partial<TransitionClip> & { id: string }): TransitionClip {
  return { trackId: T, startMs: 0, durationMs: 5000, ...over };
}

describe("planTransitions", () => {
  it("plans nothing when no clip asks for a transition", () => {
    const plan = planTransitions([clip({ id: "a" }), clip({ id: "b", startMs: 5000 })]);
    expect(plan.get("b")?.dissolveInMs ?? 0).toBe(0);
    expect(plan.get("a")?.tailExtensionMs ?? 0).toBe(0);
  });

  it("dissolves into the clip that touches it, and holds its predecessor for the same length", () => {
    const plan = planTransitions([clip({ id: "a" }), clip({ id: "b", startMs: 5000, transitionInMs: 1000 })]);
    expect(plan.get("b")!.dissolveInMs).toBe(1000);
    // Without the tail, the outgoing clip would vanish the instant the
    // incoming one appeared and there would be nothing to mix with.
    expect(plan.get("a")!.tailExtensionMs).toBe(1000);
  });

  it("ignores a transition on the first clip, which has nothing to dissolve from", () => {
    const plan = planTransitions([clip({ id: "a", transitionInMs: 1000 })]);
    expect(plan.get("a")?.dissolveInMs ?? 0).toBe(0);
  });

  it("ignores a transition across a gap rather than dissolving out of black", () => {
    // Dissolving from black is what fadeInMs already means; quietly turning
    // one into the other would be surprising.
    const plan = planTransitions([clip({ id: "a" }), clip({ id: "b", startMs: 9000, transitionInMs: 1000 })]);
    expect(plan.get("b")?.dissolveInMs ?? 0).toBe(0);
    expect(plan.get("a")?.tailExtensionMs ?? 0).toBe(0);
  });

  it("tolerates a frame of rounding when deciding whether two clips touch", () => {
    const plan = planTransitions([clip({ id: "a", durationMs: 4980 }), clip({ id: "b", startMs: 5000, transitionInMs: 800 })]);
    expect(plan.get("b")!.dissolveInMs).toBe(800);
  });

  it("caps the dissolve at the incoming clip's length, so it always reaches full opacity", () => {
    const plan = planTransitions([clip({ id: "a" }), clip({ id: "b", startMs: 5000, durationMs: 600, transitionInMs: 2000 })]);
    expect(plan.get("b")!.dissolveInMs).toBe(600);
  });

  it("caps the dissolve at the outgoing clip's length, so it isn't mixing with a clip that already ended", () => {
    const plan = planTransitions([clip({ id: "a", durationMs: 700 }), clip({ id: "b", startMs: 700, durationMs: 5000, transitionInMs: 2000 })]);
    expect(plan.get("b")!.dissolveInMs).toBe(700);
  });

  it("gives a clip one tail long enough for its longest successor", () => {
    // Same clip can only be extended once however many neighbours ask.
    const plan = planTransitions([
      clip({ id: "a", durationMs: 5000 }),
      clip({ id: "b", startMs: 5000, durationMs: 5000, transitionInMs: 400 }),
      clip({ id: "c", startMs: 10000, durationMs: 5000, transitionInMs: 1200 }),
    ]);
    expect(plan.get("a")!.tailExtensionMs).toBe(400);
    expect(plan.get("b")!.tailExtensionMs).toBe(1200);
    expect(plan.get("c")!.dissolveInMs).toBe(1200);
  });

  it("keeps tracks independent — a clip cannot dissolve from one on another track", () => {
    const plan = planTransitions([
      clip({ id: "a", trackId: "track_other" }),
      clip({ id: "b", trackId: T, startMs: 5000, transitionInMs: 1000 }),
    ]);
    expect(plan.get("b")?.dissolveInMs ?? 0).toBe(0);
  });

  it("orders by position, not by the order clips happen to be stored in", () => {
    const plan = planTransitions([
      clip({ id: "b", startMs: 5000, transitionInMs: 1000 }),
      clip({ id: "a", startMs: 0 }),
    ]);
    expect(plan.get("b")!.dissolveInMs).toBe(1000);
    expect(plan.get("a")!.tailExtensionMs).toBe(1000);
  });
});

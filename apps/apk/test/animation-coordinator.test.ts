import { describe, expect, it } from "vitest";
import { AnimationCoordinator, type AnimationDriver } from "../src/presentation/animation/AnimationCoordinator.js";

describe("AnimationCoordinator", () => {
  it("never replays an event after reconnect and drops stale snapshot animations", async () => {
    const played: string[] = [];
    const driver: AnimationDriver = { play: async (event) => { played.push(event.eventId); }, cancelAll: () => undefined };
    const animations = new AnimationCoordinator(driver);
    animations.acceptSnapshot(10);
    expect(await animations.playConfirmed({ eventId: "discard:10", source: "server", snapshotRevision: 10, cue: "discard" })).toBe(true);
    expect(await animations.playConfirmed({ eventId: "discard:10", source: "server", snapshotRevision: 10, cue: "discard" })).toBe(false);
    animations.acceptSnapshot(11);
    expect(await animations.playConfirmed({ eventId: "late", source: "server", snapshotRevision: 10, cue: "peng" })).toBe(false);
    expect(played).toEqual(["discard:10"]);
  });
});

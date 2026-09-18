import { describe, expect, it } from "vitest";
import { AudioManager, type AudioDriver } from "../src/presentation/audio/AudioManager.js";

function harness() {
  const calls: string[] = [];
  const driver: AudioDriver = {
    play: (path) => calls.push(path), stopCategory: () => undefined,
    pauseCategory: () => undefined, resumeCategory: () => undefined,
  };
  return { calls, audio: new AudioManager(driver) };
}

describe("AudioManager", () => {
  it("plays result cues only from confirmed server events and deduplicates reconnect frames", () => {
    const { calls, audio } = harness();
    expect(audio.playConfirmed({ eventId: "r1:peng:2", source: "server", cue: "peng" })).toBe(true);
    expect(audio.playConfirmed({ eventId: "r1:peng:2", source: "server", cue: "peng" })).toBe(false);
    expect(calls).toEqual(["resources/audio/sfx/placeholder_peng.wav"]);
  });

  it("keeps UI clicks separate and respects category settings", () => {
    const { calls, audio } = harness();
    audio.configure({ effectsEnabled: false });
    audio.playUi("button");
    expect(calls).toEqual([]);
  });
});

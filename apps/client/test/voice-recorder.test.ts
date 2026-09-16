import { describe, expect, it } from "vitest";
import { clampSeconds, normalizedAudioType } from "../src/browser/voice-recorder.js";

describe("录音时长换算", () => {
  it("不足一秒也按一秒算（用户确实按下了按钮）", () => {
    expect(clampSeconds(0)).toBe(1);
    expect(clampSeconds(400)).toBe(1);
  });

  it("取最接近的整秒", () => {
    expect(clampSeconds(2400)).toBe(2);
    expect(clampSeconds(7600)).toBe(8);
  });

  it("超过上限就压到上限（服务端只收 1–60 秒）", () => {
    expect(clampSeconds(61_000)).toBe(60);
    expect(clampSeconds(600_000)).toBe(60);
  });
});

describe("音频类型归一化", () => {
  it("截掉 codecs 参数 —— 服务端是按精确值比对白名单的", () => {
    expect(normalizedAudioType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizedAudioType("audio/mp4;codecs=mp4a.40.2")).toBe("audio/mp4");
  });

  it("顺带统一大小写与空白", () => {
    expect(normalizedAudioType(" Audio/MP4 ")).toBe("audio/mp4");
    expect(normalizedAudioType("AUDIO/WEBM")).toBe("audio/webm");
  });

  it("取不到类型时按 webm 兜底（Chrome / Edge 的默认输出）", () => {
    expect(normalizedAudioType("")).toBe("audio/webm");
    expect(normalizedAudioType(";codecs=opus")).toBe("audio/webm");
  });

  it("结果一定落在服务端的白名单里", () => {
    const allowed = ["audio/mp4", "audio/aac", "audio/amr", "audio/mpeg", "audio/ogg", "audio/webm"];
    for (const raw of ["audio/webm;codecs=opus", "audio/mp4", "", "audio/ogg;codecs=vorbis"]) {
      expect(allowed).toContain(normalizedAudioType(raw));
    }
  });
});

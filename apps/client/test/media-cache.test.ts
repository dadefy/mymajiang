import { describe, expect, it } from "vitest";
import { MediaCache, type MediaState } from "../src/browser/media-cache.js";

/** 手动控制完成时机的下载实现。 */
function controllableLoader() {
  const pending: Array<{ url: string; resolve: (blob: Blob) => void; reject: (error: Error) => void }> = [];
  const calls: string[] = [];
  return {
    calls,
    /** 让它下一次（或指定第几次）下载成功返回一个占位 blob。 */
    loader: (url: string): Promise<Blob> => {
      calls.push(url);
      return new Promise<Blob>((resolve, reject) => {
        pending.push({ url, resolve, reject });
      });
    },
    finish(index: number, name = "blob"): void {
      pending[index]!.resolve({ size: 1, type: "image/png", name } as unknown as Blob);
    },
    fail(index: number): void {
      pending[index]!.reject(new Error("网络不通"));
    },
  };
}

/** 本地地址用可预测的字符串代替 `URL.createObjectURL`。 */
function fakeObjectUrls() {
  const created: string[] = [];
  const released: string[] = [];
  return {
    created,
    released,
    toObjectUrl: (blob: Blob): string => {
      const url = `blob:fake-${(blob as unknown as { name?: string }).name ?? created.length}`;
      created.push(url);
      return url;
    },
    releaseObjectUrl: (url: string): void => {
      released.push(url);
    },
  };
}

describe("MediaCache", () => {
  it("第一次取就是 loading，下载完成后变成 ready 并给出本地地址", async () => {
    const loader = controllableLoader();
    const urls = fakeObjectUrls();
    const cache = new MediaCache({ load: loader.loader, ...urls });

    expect(cache.resolve("m1", "https://storage/signed-1")).toEqual({ status: "loading" });
    expect(loader.calls).toEqual(["https://storage/signed-1"]);

    loader.finish(0, "photo");
    await Promise.resolve();

    expect(cache.peek("m1")).toEqual({ status: "ready", url: "blob:fake-photo" });
  });

  it("同一个 key 不会重复下载（签名地址会过期，抓一次就够）", async () => {
    const loader = controllableLoader();
    const cache = new MediaCache({ load: loader.loader, ...fakeObjectUrls() });

    cache.resolve("m1", "https://storage/signed-1");
    cache.resolve("m1", "https://storage/signed-1");
    loader.finish(0);
    await Promise.resolve();
    cache.resolve("m1", "https://storage/signed-2");

    expect(loader.calls).toEqual(["https://storage/signed-1"]);
    expect((cache.peek("m1") as MediaState).status).toBe("ready");
  });

  it("失败之后不会自动重刷，只有显式 retry 才再试一次", async () => {
    const loader = controllableLoader();
    const cache = new MediaCache({ load: loader.loader, ...fakeObjectUrls() });

    cache.resolve("m1", "https://storage/signed-1");
    loader.fail(0);
    await Promise.resolve();
    expect(cache.peek("m1")).toEqual({ status: "failed" });

    // 渲染层重画会再调一次 resolve：不该再打网络。
    cache.resolve("m1", "https://storage/signed-1");
    expect(loader.calls).toHaveLength(1);

    cache.resolve("m1", "https://storage/signed-1", { retry: true });
    expect(loader.calls).toHaveLength(2);
    loader.finish(1, "retried");
    await Promise.resolve();
    expect(cache.peek("m1")).toEqual({ status: "ready", url: "blob:fake-retried" });
  });

  it("状态变化会通知订阅者，取消订阅后不再通知", async () => {
    const loader = controllableLoader();
    const cache = new MediaCache({ load: loader.loader, ...fakeObjectUrls() });
    let notified = 0;
    const off = cache.onChange(() => {
      notified += 1;
    });

    cache.resolve("m1", "https://storage/signed-1");
    loader.finish(0);
    await Promise.resolve();
    expect(notified).toBe(1);

    off();
    cache.resolve("m2", "https://storage/signed-2");
    loader.finish(1);
    await Promise.resolve();
    expect(notified).toBe(1);
  });

  it("dispose 释放已加载的本地地址，并且不再理会在途的下载", async () => {
    const loader = controllableLoader();
    const urls = fakeObjectUrls();
    const cache = new MediaCache({ load: loader.loader, ...urls });

    cache.resolve("m1", "https://storage/signed-1");
    loader.finish(0, "done");
    await Promise.resolve();
    cache.resolve("m2", "https://storage/signed-2");

    cache.dispose();

    expect(urls.released).toEqual(["blob:fake-done"]);
    // 在途的那条下载完成时不该把自己塞回缓存里。
    loader.finish(1, "late");
    await Promise.resolve();
    expect(cache.peek("m2")).toBeUndefined();
  });
});

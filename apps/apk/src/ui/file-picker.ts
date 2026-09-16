/**
 * 选一张图片，读成字节交给业务层。
 *
 * 这属于**运行环境相关**的能力，所以留在渲染层：`apps/client` 只认字节，
 * 不关心文件从哪里来（浏览器是 `<input type="file">`，将来接原生相册也只改这一个文件）。
 *
 * 注意：`Laya.Browser.createElement` 依赖真实的 DOM。H5 与 LayaAir 的 Web 构建下可用；
 * 如果打包成原生 APK 时没有 DOM 模拟，这里取不到可点击的元素 —— 那种情况下需要换成
 * 原生的相册桥接，`pickImage` 返回 `undefined`，页面不会崩，只是发不了图。
 */

export interface PickedImage {
  bytes: Uint8Array;
  /** 图片的 MIME 类型；浏览器给不出时按 PNG 兜底。 */
  contentType: string;
  fileName: string;
}

/**
 * 弹出选图框并读取选中的文件。
 *
 * 取消选择、没选中文件、读取失败都返回 `undefined` —— 这些都是正常分支，
 * 不该让页面弹一条错误出来。
 */
export function pickImage(): Promise<PickedImage | undefined> {
  return new Promise((resolve) => {
    let input: HTMLInputElement;
    try {
      input = Laya.Browser.createElement("input");
    } catch {
      resolve(undefined);
      return;
    }
    input.type = "file";
    input.accept = "image/*";
    // 藏起来，但必须挂进 DOM 才能触发点击。
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "0";
    Laya.Browser.document.body.appendChild(input);

    const cleanup = (): void => {
      input.remove();
    };

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(undefined);
        return;
      }
      void file
        .arrayBuffer()
        .then((buffer) => {
          resolve({
            bytes: new Uint8Array(buffer),
            contentType: file.type || "image/png",
            fileName: file.name,
          });
          cleanup();
        })
        // 不用 `.finally`：apk 的 tsconfig 目标较低，没有 es2018 的 lib。
        .catch(() => {
          resolve(undefined);
          cleanup();
        });
    });

    // 用户直接关掉选图框时不会有 change 事件；挂一个一次性的焦点回调把元素清掉，
    // 免得隐藏的 input 一直留在 DOM 里。这里不 resolve —— 页面本来就没有「等待选图」的状态。
    Laya.Browser.window.addEventListener(
      "focus",
      () => {
        setTimeout(() => {
          if (!input.files || input.files.length === 0) cleanup();
        }, 1000);
      },
      { once: true },
    );

    input.click();
  });
}

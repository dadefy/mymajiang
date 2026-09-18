export interface SafeAreaInsets { top: number; right: number; bottom: number; left: number }
export type AppVisibility = "foreground" | "background";
export type NetworkKind = "wifi" | "cellular" | "offline" | "unknown";

/** WebView 宿主以后通过 JavascriptInterface 注入；Web 版可没有该对象。 */
export interface AndroidHostBridge {
  safeArea(): SafeAreaInsets;
  setLandscape(): void;
  finishActivity(): void;
  vibrate(milliseconds: number): void;
  appVisibility(): AppVisibility;
  networkKind(): NetworkKind;
}

export function androidHost(): AndroidHostBridge | null {
  const candidate = (globalThis as { MyMahjongAndroid?: AndroidHostBridge }).MyMahjongAndroid;
  return candidate ?? null;
}

export function cssSafeAreaFallback(): SafeAreaInsets {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

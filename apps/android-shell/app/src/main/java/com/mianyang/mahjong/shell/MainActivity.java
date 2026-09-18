package com.mianyang.mahjong.shell;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * 麻雀精灵 Android WebView 壳。
 *
 * 职责（只做壳，不做任何游戏/页面逻辑）：
 * 1. 横屏锁定（manifest: sensorLandscape）；
 * 2. 加载服务端 /app（LayaAir web 构建产物），全部流量走 HTTPS/WSS；
 * 3. 相册桥接：页面 <input type="file"> → WebChromeClient.onShowFileChooser → 系统图片选择器；
 * 4. 麦克风桥接：页面 getUserMedia → WebChromeClient.onPermissionRequest → RECORD_AUDIO 运行时权限；
 * 5. 返回键/手势返回：WebView 可后退则后退，否则双击退出；
 * 6. 后台切换恢复：onPause/onResume 配对 + saveState/restoreState，切回不重载页面，
 *    断网重连由页面自身传输层负责（壳不接管业务状态）。
 */
public class MainActivity extends Activity {

    /** 悬浮在 Activity 上的临时运行时权限请求码（相册选择用 START_ACTIVITY 语义，另用常量区分）。 */
    private static final int REQ_MIC_PERMISSION = 4001;
    /** 系统图片选择器的 startActivityForResult 请求码。 */
    private static final int REQ_FILE_CHOOSER = 1001;

    private static final long EXIT_HINT_WINDOW_MS = 2200;

    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;
    /** 等待 RECORD_AUDIO 运行时授权的 getUserMedia 请求；授权结果回来后 grant/deny。 */
    private PermissionRequest pendingMicRequest;
    private long lastBackPressAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 内测阶段保持屏幕常亮（牌局中熄屏体验很差）；正式版可改为页面按需唤醒。
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#F7F2E6"));
        configureWebView();
        setContentView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        if (savedInstanceState != null) {
            // 进程被杀后恢复：还原页面会话，不重新 loadUrl（避免重置到登录页）。
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(resolveStartUrl());
        }
    }

    private String resolveStartUrl() {
        // 允许用 manifest meta-data app_url 指向别的环境（本地联调等），不用重新编译。
        String meta = null;
        try {
            meta = getPackageManager().getApplicationInfo(getPackageName(),
                    PackageManager.GET_META_DATA).metaData.getString("app_url");
        } catch (Exception ignored) {
            // meta-data 不存在是常态，走 BuildConfig 默认值。
        }
        return (meta != null && !meta.isEmpty()) ? meta : BuildConfig.DEFAULT_APP_URL;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 语音消息的 getUserMedia 不需要用户手势；选图点击本身就是手势。
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        // 只加载 https（manifest 已禁 cleartext），混合内容一律拦。
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                // 站内 https 一律留在壳内；外部 http(s) 交系统浏览器；其他 scheme（tel: 等）尝试系统处理。
                if ("https".equals(scheme)) {
                    if (isSameHost(uri)) return false;
                    openExternally(uri);
                    return true;
                }
                if ("http".equals(scheme)) {
                    openExternally(uri);
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // 没有应用能处理该 scheme：吞掉，页面不崩。
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            // ---- 相册桥接：页面 pickImage() 的 <input type=file accept=image/*> 走到这里 ----
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // 上一次选择没回来又开了一个：先取消旧的，避免回调错位。
                if (fileChooserCallback != null) {
                    fileChooserCallback.onReceiveValue(null);
                }
                fileChooserCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("image/*");
                    startActivityForResult(Intent.createChooser(intent, "选择图片"), REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    // 系统选择器拉不起来（如无相册应用）：必须回空，否则页面永远等待。
                    fileChooserCallback.onReceiveValue(null);
                    fileChooserCallback = null;
                    return true;
                }
                return true;
            }

            // ---- 麦克风桥接：页面 getUserMedia({audio:true}) 走到这里 ----
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                boolean wantsMic = false;
                for (String res : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) wantsMic = true;
                }
                if (!wantsMic) {
                    request.deny();
                    return;
                }
                runOnUiThread(() -> {
                    if (hasMicPermission()) {
                        request.grant(request.getResources());
                    } else {
                        // 先挂起请求，等运行时授权回调再 grant/deny。
                        if (pendingMicRequest != null) pendingMicRequest.deny();
                        pendingMicRequest = request;
                        String[] perms = {"android.permission.RECORD_AUDIO"};
                        requestPermissions(perms, REQ_MIC_PERMISSION);
                    }
                });
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                           GeolocationPermissions.Callback cb) {
                cb.invoke(origin, false, false); // 本应用不用定位，一律拒绝。
            }
        });
    }

    private boolean isSameHost(Uri uri) {
        Uri base = Uri.parse(resolveStartUrl());
        return base.getHost() != null && base.getHost().equals(uri.getHost());
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // 无浏览器可处理：忽略。
        }
    }

    private boolean hasMicPermission() {
        return checkSelfPermission("android.permission.RECORD_AUDIO")
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MIC_PERMISSION || pendingMicRequest == null) return;
        PermissionRequest request = pendingMicRequest;
        pendingMicRequest = null;
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        runOnUiThread(() -> {
            if (granted) {
                request.grant(request.getResources());
            } else {
                request.deny();
                Toast.makeText(this, "未授予麦克风权限，语音消息不可用", Toast.LENGTH_SHORT).show();
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE_CHOOSER || fileChooserCallback == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        ValueCallback<Uri[]> callback = fileChooserCallback;
        fileChooserCallback = null;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            result = new Uri[]{data.getData()};
        }
        callback.onReceiveValue(result);
    }

    // ---- 返回键 / 手势返回：能后退就后退，否则双击退出 ----

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && event.getRepeatCount() == 0) {
            handleBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /** Android 10+ 手势导航最终也走 onBackPressed；保持与按键同一条路。 */
    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPressAt < EXIT_HINT_WINDOW_MS) {
            finish();
        } else {
            lastBackPressAt = now;
            Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
        }
    }

    // ---- 后台切换恢复：配对暂停/恢复 + 保留页面状态 ----

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            // 页面在后台期间会掉线；恢复前台时通知页面自查（页面传输层有重连逻辑，
            // 这里只是补一刀，让 WSS 掉线提示尽快转绿）。
            webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('focus'));void 0;", null);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}

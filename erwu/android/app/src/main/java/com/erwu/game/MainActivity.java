package com.erwu.game;

import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebBackForwardList;
import android.widget.EditText;
import android.widget.LinearLayout;

import com.getcapacitor.BridgeActivity;

import java.net.MalformedURLException;
import java.net.URL;

/**
 * 《二五》扑克游戏主界面。
 * 这是一个 WebView 外壳，实际业务逻辑运行在用户自己的后端服务器上（NAS / VPS）。
 *
 * 主要功能：
 *   - 首次启动弹输入框，让用户配置后端服务器地址（局域网 IP 或公网域名）
 *   - 地址保存在 SharedPreferences，后续自动连接；菜单里可随时修改
 *   - 返回键优先在 WebView 内部回退历史，没有历史才退出 App
 *   - Edge-to-Edge 全屏体验，状态栏透明，内容延伸到状态栏区域
 *
 * Android 9+ 明文 HTTP 已通过 usesCleartextTraffic + network_security_config 放行，
 * 方便局域网 NAS 直接 HTTP 访问。
 */
public class MainActivity extends BridgeActivity {

    private static final String PREFS = "erwu_prefs";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String TAG = "ErwuApp";
    private static final long RELOAD_DELAY_MS = 400;

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Edge-to-Edge：内容延伸到状态栏后面，状态栏透明
        setupEdgeToEdge();

        // 等 bridge 就绪后再走后续逻辑
        new Handler(Looper.getMainLooper()).postDelayed(this::onBridgeReady, RELOAD_DELAY_MS);
    }

    /**
     * 等待 Capacitor Bridge 就绪，然后初始化 WebView 设置并加载服务器。
     */
    private void onBridgeReady() {
        if (bridge == null) {
            new Handler(Looper.getMainLooper()).postDelayed(this::onBridgeReady, RELOAD_DELAY_MS);
            return;
        }

        webView = bridge.getWebView();
        if (webView == null) {
            new Handler(Looper.getMainLooper()).postDelayed(this::onBridgeReady, RELOAD_DELAY_MS);
            return;
        }

        configureWebView(webView);

        String serverUrl = getServerUrl();
        if (serverUrl != null && !serverUrl.isEmpty()) {
            loadServerUrl(serverUrl);
        } else {
            promptServerUrl();
        }
    }

    /**
     * Edge-to-Edge 全屏：状态栏透明 + 布局延伸到系统栏区域。
     */
    private void setupEdgeToEdge() {
        Window window = getWindow();
        // 透明状态栏 + 透明导航栏
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            // 内容延伸到系统栏下方
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 适配刘海屏挖孔屏
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }
    }

    /**
     * 对 Capacitor 的 WebView 做一些额外配置（Capacitor 已经设置了大部分）。
     */
    private void configureWebView(WebView wv) {
        WebSettings s = wv.getSettings();
        // 确保支持缩放（前端可能有 pinch 交互）
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        // 支持文件协议（Capacitor 本地资源）
        s.setAllowFileAccess(true);
        // 数据库 / DOM Storage
        s.setDatabaseEnabled(true);
        s.setDomStorageEnabled(true);
        // 缓存策略：在线时优先网络，离线回退缓存
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
    }

    // ───────────────────── 服务器地址加载 / 保存 ─────────────────────

    private void loadServerUrl(String url) {
        if (bridge == null || bridge.getWebView() == null) {
            // 还没准备好，稍后再试
            new Handler(Looper.getMainLooper()).postDelayed(() -> loadServerUrl(url), RELOAD_DELAY_MS);
            return;
        }
        try {
            bridge.getWebView().loadUrl(url);
            Log.i(TAG, "loaded server url: " + url);
        } catch (Exception e) {
            Log.e(TAG, "loadUrl failed", e);
        }
    }

    private String getServerUrl() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_SERVER_URL, "");
    }

    private void saveServerUrl(String url) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_SERVER_URL, url)
                .apply();
    }

    // ───────────────────── 输入框弹窗 ─────────────────────

    private void promptServerUrl() {
        final EditText input = new EditText(this);
        input.setHint("http://192.168.1.100:3000");
        input.setSingleLine(true);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(48, 24, 48, 0);
        input.setLayoutParams(lp);
        String current = getServerUrl();
        if (current != null && !current.isEmpty()) {
            input.setText(current);
            input.setSelection(current.length());
        }

        boolean cancellable = current != null && !current.isEmpty();

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("连接服务器")
                .setMessage("请输入运行《二五》服务的后端地址（你的 NAS 或 VPS），例如：\n\n" +
                        "局域网：http://192.168.1.100:3000\n" +
                        "公网：https://erwu.yourdomain.com\n\n" +
                        "连接失败请检查：后端是否已启动、手机与服务器是否在同一局域网、\n" +
                        "服务器防火墙是否放行了对应端口。")
                .setView(input)
                .setPositiveButton("连接", (DialogInterface d, int which) -> {
                    String url = input.getText().toString().trim();
                    if (validateUrl(url)) {
                        saveServerUrl(url);
                        loadServerUrl(url);
                    } else {
                        new AlertDialog.Builder(MainActivity.this)
                                .setTitle("地址格式不正确")
                                .setMessage("请输入完整的 http:// 或 https:// 开头的地址")
                                .setPositiveButton("好", (DialogInterface dd, int w) -> promptServerUrl())
                                .show();
                    }
                })
                .setNegativeButton(cancellable ? "取消" : null, (DialogInterface d, int which) -> {})
                .setCancelable(cancellable)
                .create();

        dialog.show();
    }

    private static boolean validateUrl(String s) {
        if (s == null || s.isEmpty()) return false;
        try {
            URL u = new URL(s);
            if (!"http".equalsIgnoreCase(u.getProtocol()) && !"https".equalsIgnoreCase(u.getProtocol())) {
                return false;
            }
            return u.getHost() != null && !u.getHost().isEmpty();
        } catch (MalformedURLException e) {
            return false;
        }
    }

    // ───────────────────── 返回键：WebView 内部优先 ─────────────────────

    /**
     * 物理返回键 / 手势返回：如果 WebView 有历史记录就后退，否则退出 App。
     * Android 13+ 会优先调用此方法（OnBackPressedDispatcher 已自动接管）。
     */
    @Override
    public void onBackPressed() {
        if (webView != null && canGoBackInWebView()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    /**
     * 判断 WebView 是否有可回退的历史页面（index 0 是当前页，有 >= 1 个历史就能 goBack）。
     */
    private boolean canGoBackInWebView() {
        try {
            WebBackForwardList list = webView.copyBackForwardList();
            return list.getCurrentIndex() > 0;
        } catch (Exception e) {
            Log.w(TAG, "canGoBack check failed", e);
            return false;
        }
    }

    // ───────────────────── 菜单：修改服务器地址 ─────────────────────

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(Menu.NONE, 1, Menu.NONE, "修改服务器地址");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            promptServerUrl();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}

/**
 * Feishu app-level admission gate (xDesign fork).
 *
 * Runs in the packaged Electron main process, AFTER sidecars boot and BEFORE
 * the main window. A user must sign in with Feishu and belong to the configured
 * tenant; otherwise the app never reaches the workspace. The daemon's upstream
 * localhost trust is untouched (ADR 0001: app-level gate, light fork).
 *
 * Flow:
 *   1. Gate disabled / unconfigured  -> return immediately (upstream behavior).
 *   2. Cached access token fresh     -> return.
 *   3. Cached access expired, refresh token valid -> refresh silently, return.
 *   4. Otherwise open a Feishu login window; capture the `xdesign://feishu/
 *      callback?code=...&state=...` redirect; exchange -> fetch tenant ->
 *      admit if the tenant matches, else reject. Cache the token (safeStorage).
 *
 * This module is Electron-runtime code; the pure pieces (oauth.ts, token-cache.ts)
 * are unit-tested. The window/callback wiring is validated by the branded smoke
 * build with real credentials.
 */
import { randomBytes } from "node:crypto";

import { app, BrowserWindow, safeStorage, type BrowserWindow as BrowserWindowType } from "electron";

import type { PackagedConfig, PackagedFeishuConfig } from "../config.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  isAllowedTenant,
  refreshTokens,
} from "./oauth.js";
import {
  cacheTokenFromTokens,
  canRefresh,
  clearToken,
  isFresh,
  loadToken,
  saveToken,
} from "./token-cache.js";

const FEISHU_CALLBACK_PREFIX = "xdesign://feishu/callback";

export type EnsureFeishuAdmissionDeps = {
  config: PackagedConfig;
  /** Encrypted-token file path (under the namespace runtime dir). */
  tokenPath: string;
  /** Splash window to suppress while the login window is on screen. */
  splashWindow?: BrowserWindowType;
  /** Now clock for expiry checks; defaults to Date.now. */
  now?: () => number;
};

/**
 * Block until the user is admitted via Feishu, or the gate is disabled. Throws
 * only on an unrecoverable configuration error; a denied/expired login keeps the
 * window up for the user to retry.
 */
export async function ensureFeishuAdmission(deps: EnsureFeishuAdmissionDeps): Promise<void> {
  const feishu = deps.config.feishu;
  // Gate is opt-in (feishuAdmission) AND must have full creds; anything less is
  // upstream behavior so unbranded builds boot unchanged.
  if (!deps.config.feishuAdmission || feishu == null) return;
  if (!safeStorage.isEncryptionAvailable()) {
    // No OS keychain to protect the token cache; fail closed rather than cache
    // tokens in plaintext.
    throw new Error("feishu admission gate requires Electron safeStorage (OS keychain unavailable)");
  }
  const now = deps.now ?? Date.now;

  const cached = await loadToken(deps.tokenPath, safeStorage);
  if (cached != null && isFresh(cached, now())) return;
  if (cached != null && canRefresh(cached, now())) {
    try {
      const renewed = await refreshTokens(feishu, cached.refreshToken);
      await saveToken(deps.tokenPath, cacheTokenFromTokens(renewed, {
        tenantKey: cached.tenantKey,
        name: cached.name,
      }, now()), safeStorage);
      return;
    } catch {
      await clearToken(deps.tokenPath); // refresh failed -> force a fresh login
    }
  }

  await runInteractiveGate(feishu, deps, now);
}

async function runInteractiveGate(
  feishu: PackagedFeishuConfig,
  deps: EnsureFeishuAdmissionDeps,
  now: () => number,
): Promise<void> {
  if (!app.isDefaultProtocolClient("xdesign")) app.setAsDefaultProtocolClient("xdesign");

  await new Promise<void>((resolve, reject) => {
    const gate = new BrowserWindow({
      autoHideMenuBar: true,
      backgroundColor: "#f7f7f7",
      center: true,
      height: 760,
      resizable: false,
      show: true,
      title: "xDesign · Feishu 登录",
      width: 480,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    deps.splashWindow?.hide();

    let admitted = false;
    let currentState = "";
    const loadAuthorize = (): void => {
      currentState = randomBytes(16).toString("hex");
      gate.loadURL(buildAuthorizeUrl(feishu, currentState));
    };
    loadAuthorize();

    const handleCallback = async (url: string): Promise<void> => {
      const parsed = parseCallback(url);
      if (parsed == null || parsed.state !== currentState) return; // not our callback / CSRF mismatch
      try {
        const tokens = await exchangeCodeForTokens(feishu, parsed.code);
        const info = await fetchUserInfo(feishu, tokens.accessToken);
        if (!isAllowedTenant(info.tenantKey, feishu.tenantId)) {
          gate.loadURL(renderErrorPage("不在允许的飞书组织内", "请联系管理员加入授权组织后再登录。"));
          return; // stay gated; the user closes the app
        }
        await saveToken(deps.tokenPath, cacheTokenFromTokens(tokens, info, now()), safeStorage);
        admitted = true;
        gate.close();
        resolve();
      } catch (error) {
        gate.loadURL(renderErrorPage("飞书登录失败", explainError(error) + "\n正在重试…"));
        setTimeout(loadAuthorize, 2500); // transient error -> retry the authorize flow
      }
    };

    const isCallback = (url: string): boolean => url.startsWith(FEISHU_CALLBACK_PREFIX);
    // Capture the redirect inside the gate window (the renderer can't load the
    // xdesign:// scheme, so we intercept the navigation that carries the code).
    // Listeners are inlined so TS infers the Electron event types; the window's
    // webContents (and its listeners) are torn down when the gate window closes.
    gate.webContents.on("did-start-navigation", (_event, url) => {
      if (isCallback(url)) void handleCallback(url);
    });
    gate.webContents.on("will-navigate", (event, url) => {
      if (isCallback(url)) {
        event.preventDefault();
        void handleCallback(url);
      }
    });

    // OS fallback: if the redirect escapes to the system (Feishu in the user's
    // browser), macOS delivers it via open-url and Windows via second-instance.
    const onOpenUrl = (_e: unknown, url: string): void => {
      if (isCallback(url)) void handleCallback(url);
    };
    const onSecondInstance = (_e: unknown, argv: string[]): void => {
      const url = argv.find((a) => a.startsWith(FEISHU_CALLBACK_PREFIX));
      if (url != null) void handleCallback(url);
    };
    app.on("open-url", onOpenUrl);
    app.on("second-instance", onSecondInstance);

    gate.on("closed", () => {
      app.removeListener("open-url", onOpenUrl);
      app.removeListener("second-instance", onSecondInstance);
      deps.splashWindow?.show();
      // If the gate closed without admitting (user gave up), reject so the boot
      // aborts rather than booting the workspace unauthenticated.
      if (!admitted) reject(new Error("Feishu admission gate closed without login"));
    });
  });
}

function parseCallback(url: string): { code: string; state: string } | null {
  try {
    const q = url.indexOf("?");
    if (q < 0) return null;
    const params = new URLSearchParams(url.slice(q + 1));
    const code = params.get("code");
    const state = params.get("state");
    if (code == null || state == null) return null;
    return { code, state };
  } catch {
    return null;
  }
}

function explainError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderErrorPage(title: string, body: string): string {
  return (
    "data:text/html;charset=utf-8,"
    + encodeURIComponent(
      `<!doctype html><meta charset="utf-8"><title>xDesign · Feishu 登录</title>
<style>body{font:14px/1.6 -apple-system,sans-serif;margin:0;padding:48px 32px;color:#353535;text-align:center}
h1{font-size:18px;margin:0 0 12px}</style>
<h1>${title}</h1><p>${body}</p>`,
    )
  );
}

/**
 * Periodically re-validate admission while the app runs. If the cached token can
 * no longer refresh (e.g. revoked), hide the workspace and re-run the gate so an
 * ex-employee is locked back out without relaunching.
 */
export function startFeishuRevalidation(
  deps: EnsureFeishuAdmissionDeps,
  onLock: () => void,
  intervalMs = 30 * 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      const feishu = deps.config.feishu;
      if (!deps.config.feishuAdmission || feishu == null) return;
      const token = await loadToken(deps.tokenPath, safeStorage);
      const now = (deps.now ?? Date.now)();
      if (token == null || (!isFresh(token, now) && !canRefresh(token, now))) {
        onLock();
      }
    })();
  }, intervalMs);
}

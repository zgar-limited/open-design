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
 *   4. Otherwise open a Feishu login window; a loopback HTTP server captures the
 *      `http://localhost:<port>/feishu/callback?code=...&state=...` redirect;
 *      exchange -> fetch tenant -> admit if the tenant matches, else reject.
 *      Cache the token (safeStorage).
 *
 * This module is Electron-runtime code; the pure pieces (oauth.ts, token-cache.ts)
 * are unit-tested. The window/callback wiring is validated by the branded smoke
 * build with real credentials.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { BrowserWindow, safeStorage, type BrowserWindow as BrowserWindowType } from "electron";

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

/**
 * Fixed loopback port for the OAuth callback. Feishu's redirect-URL config needs
 * an exact http(s) URL registered, so the port is fixed (not ephemeral). The
 * gate registers `http://localhost:<port>/feishu/callback` and the user must add
 * that same URL to the Feishu app's "重定向 URL".
 */
const FEISHU_LOOPBACK_PORT = 27457;

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
  if (!deps.config.feishuAdmission) return;
  if (feishu == null) {
    // Fail CLOSED: an operator who turned the gate on but shipped no creds must
    // NOT boot the workspace ungated (a hand-edited config, a partial bake, or a
    // future code path could null out `feishu`). The build-time all-or-nothing
    // check does not cover runtime-resolved configs.
    throw new Error(
      "feishuAdmission is enabled but the packaged config has no Feishu credentials; "
        + "refusing to boot ungated. Set OD_FEISHU_APP_ID/APP_SECRET/TENANT_KEY at packaging time.",
    );
  }
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
  // Feishu's redirect-URL config only accepts http(s), so the gate runs a local
  // HTTP server on a fixed loopback port. Register this exact URL in the Feishu
  // app's "重定向 URL":  http://localhost:<FEISHU_LOOPBACK_PORT>/feishu/callback
  const redirectUri = `http://localhost:${FEISHU_LOOPBACK_PORT}/feishu/callback`;

  await new Promise<void>((resolve, reject) => {
    const gate = new BrowserWindow({
      autoHideMenuBar: true,
      backgroundColor: "#f7f7f7",
      center: true,
      height: 760,
      resizable: false,
      show: true,
      title: "xDesign · 飞书登录",
      width: 480,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    deps.splashWindow?.hide();

    let admitted = false;
    let processing = false;
    let currentState = "";
    const loadAuthorize = (): void => {
      currentState = randomBytes(16).toString("hex");
      gate.loadURL(buildAuthorizeUrl(feishu, redirectUri, currentState));
    };

    const handleCallback = async (code: string): Promise<{ title: string; body: string }> => {
      if (admitted || processing) return { title: "处理中", body: "请稍候…" };
      processing = true;
      try {
        const tokens = await exchangeCodeForTokens(feishu, code);
        const info = await fetchUserInfo(feishu, tokens.accessToken);
        if (!isAllowedTenant(info.tenantKey, feishu.tenantKey)) {
          return { title: "不在允许的飞书组织内", body: "请联系管理员加入授权组织后再登录。" };
        }
        await saveToken(deps.tokenPath, cacheTokenFromTokens(tokens, info, now()), safeStorage);
        admitted = true;
        const message = `登录成功，${info.name}。正在进入 xDesign…`;
        setTimeout(() => {
          if (!gate.isDestroyed()) gate.close();
          resolve();
        }, 900); // let the success page flash before the workspace takes over
        return { title: "登录成功", body: message };
      } catch (error) {
        setTimeout(loadAuthorize, 2500); // transient error -> retry the authorize flow
        return { title: "飞书登录失败", body: `${explainError(error)} 正在重试…` };
      } finally {
        processing = false;
      }
    };

    // Loopback HTTP server that receives Feishu's ?code=&state= redirect.
    const server: Server = createServer((req, res) => {
      const url = req.url ?? "";
      if (!url.startsWith("/feishu/callback")) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end(gateHtml("404", ""));
        return;
      }
      const q = url.indexOf("?");
      const params = new URLSearchParams(q >= 0 ? url.slice(q + 1) : "");
      const code = params.get("code");
      const state = params.get("state");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (code == null || state !== currentState) {
        res.end(gateHtml("参数无效", "请关闭此窗口并在 xDesign 中重新登录。"));
        return;
      }
      void handleCallback(code).then((result) => res.end(gateHtml(result.title, result.body)));
    });
    server.on("error", (error: unknown) => {
      reject(
        new Error(
          `Feishu admission gate failed to bind the loopback callback on port ${FEISHU_LOOPBACK_PORT}: ${explainError(error)}`,
        ),
      );
    });

    void server.listen(FEISHU_LOOPBACK_PORT, "127.0.0.1");
    loadAuthorize();

    gate.on("closed", () => {
      server.close();
      deps.splashWindow?.show();
      // If the gate closed without admitting (user gave up), reject so the boot
      // aborts rather than booting the workspace unauthenticated.
      if (!admitted) reject(new Error("Feishu admission gate closed without login"));
    });
  });
}

function explainError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The gate-window info/error page (raw HTML, served both as a data: URL for the
 *  Electron window and as the loopback-server response body). */
function gateHtml(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>xDesign · 飞书登录</title>
<style>body{font:14px/1.6 -apple-system,sans-serif;margin:0;padding:48px 32px;color:#353535;text-align:center}
h1{font-size:18px;margin:0 0 12px}</style>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`;
}

function renderErrorPage(title: string, body: string): string {
  return "data:text/html;charset=utf-8," + encodeURIComponent(gateHtml(title, body));
}

/**
 * Periodically re-validate admission against Feishu while the app runs. Unlike
 * the boot check, this is a SERVER-SIDE probe (fetchUserInfo) so a token revoked
 * before its local expiry — e.g. an employee removed from the tenant — is caught
 * and the user is locked back to the gate instead of staying in for up to the
 * refresh-token lifetime.
 */
export function startFeishuRevalidation(
  deps: EnsureFeishuAdmissionDeps,
  onLock: () => void,
  intervalMs = 30 * 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      if (!deps.config.feishuAdmission) return;
      const feishu = deps.config.feishu;
      if (feishu == null) {
        onLock(); // creds dropped mid-runtime -> re-gate (which then fails closed)
        return;
      }
      const token = await loadToken(deps.tokenPath, safeStorage);
      if (token == null) {
        onLock();
        return;
      }
      try {
        await fetchUserInfo(feishu, token.accessToken);
      } catch {
        // Access token rejected/revoked. Try to refresh; if that also fails,
        // clear the cache and force the user back through the gate.
        try {
          const renewed = await refreshTokens(feishu, token.refreshToken);
          await saveToken(
            deps.tokenPath,
            cacheTokenFromTokens(renewed, { tenantKey: token.tenantKey, name: token.name }, (deps.now ?? Date.now)()),
            safeStorage,
          );
        } catch {
          await clearToken(deps.tokenPath);
          onLock();
        }
      }
    })();
  }, intervalMs);
}

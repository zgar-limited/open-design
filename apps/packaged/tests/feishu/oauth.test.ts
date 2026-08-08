import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  isAllowedTenant,
  refreshTokens,
} from "../../src/feishu/oauth.js";

const creds = { appId: "cli_x", appSecret: "secret_y", baseUrl: "https://open.feishu.cn" };

function mockFetch(responses: Array<{ body: unknown; status?: number }>) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: true,
      status: r.status ?? 200,
      json: async () => r.body,
    } as unknown as Response);
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("buildAuthorizeUrl", () => {
  it("builds the authorize URL with app_id, redirect_uri, response_type, state", () => {
    const url = new URL(buildAuthorizeUrl(creds, "http://localhost:27457/feishu/callback", "nonce123"));
    expect(url.origin + url.pathname).toBe("https://open.feishu.cn/open-apis/authen/v1/index");
    expect(url.searchParams.get("app_id")).toBe("cli_x");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:27457/feishu/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("nonce123");
  });

  it("uses the configured baseUrl (Lark international)", () => {
    const url = buildAuthorizeUrl({ ...creds, baseUrl: "https://open.larksuite.com" }, "http://localhost:27457/feishu/callback", "s");
    expect(url).toMatch(/^https:\/\/open\.larksuite\.com\/open-apis\/authen\/v1\/index/);
  });
});

describe("exchangeCodeForTokens", () => {
  it("fetches app_access_token then exchanges the code for user tokens", async () => {
    const fn = mockFetch([
      { body: { code: 0, msg: "ok", app_access_token: "app-tok", expire: 7200 } },
      {
        body: {
          code: 0,
          msg: "ok",
          data: { access_token: "user-tok", refresh_token: "refresh-tok", expires_in: 6900, refresh_expires_in: 2_592_000 },
        },
      },
    ]);

    const tokens = await exchangeCodeForTokens(creds, "authcode");

    expect(tokens).toEqual({
      accessToken: "user-tok",
      refreshToken: "refresh-tok",
      expiresIn: 6900,
      refreshExpiresIn: 2_592_000,
    });
    // app_access_token call
    expect(fn.mock.calls[0]?.[0]).toBe("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal");
    // oidc code-exchange call carries the app_access_token bearer
    expect(fn.mock.calls[1]?.[0]).toBe("https://open.feishu.cn/open-apis/authen/v1/oidc/access_token");
    const exchangeInit = fn.mock.calls[1]?.[1] as RequestInit;
    expect((exchangeInit.headers as Record<string, string>).Authorization).toBe("Bearer app-tok");
    expect(JSON.parse(String(exchangeInit.body))).toEqual({ grant_type: "authorization_code", code: "authcode" });
  });

  it("throws on a Feishu error envelope (non-zero code)", async () => {
    mockFetch([{ body: { code: 0, msg: "ok", app_access_token: "app-tok", expire: 7200 } },
      { body: { code: 99991663, msg: "code invalid" } }]);
    await expect(exchangeCodeForTokens(creds, "bad")).rejects.toThrow(/99991663|code invalid/);
  });
});

describe("refreshTokens", () => {
  it("exchanges a refresh_token for new tokens", async () => {
    const fn = mockFetch([
      { body: { code: 0, msg: "ok", app_access_token: "app-tok", expire: 7200 } },
      { body: { code: 0, data: { access_token: "user-tok-2", refresh_token: "refresh-2", expires_in: 6900, refresh_expires_in: 2_592_000 } } },
    ]);
    const tokens = await refreshTokens(creds, "refresh-tok");
    expect(tokens.accessToken).toBe("user-tok-2");
    expect(fn.mock.calls[1]?.[0]).toBe("https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token");
    expect(JSON.parse(String((fn.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-tok",
    });
  });
});

describe("fetchUserInfo", () => {
  it("returns tenant_key + name from the user_info endpoint", async () => {
    const fn = mockFetch([
      { body: { code: 0, data: { tenant_key: "ten-allowed", name: "Rain", open_id: "ou_x" } } },
    ]);
    const info = await fetchUserInfo(creds, "user-tok");
    expect(info).toEqual({ tenantKey: "ten-allowed", name: "Rain", openId: "ou_x" });
    expect(fn.mock.calls[0]?.[0]).toBe("https://open.feishu.cn/open-apis/authen/v1/user_info");
    const init = fn.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer user-tok");
  });
});

describe("isAllowedTenant", () => {
  it("allows an exact tenant_key match", () => {
    expect(isAllowedTenant("ten-allowed", "ten-allowed")).toBe(true);
  });
  it("rejects a non-matching tenant_key", () => {
    expect(isAllowedTenant("ten-other", "ten-allowed")).toBe(false);
  });
});

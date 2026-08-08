import { describe, expect, it } from "vitest";

import { resolveToolPackFeishu } from "../src/config.js";

describe("resolveToolPackFeishu", () => {
  it("returns undefined when no feishu env is set", () => {
    expect(resolveToolPackFeishu({})).toBeUndefined();
  });

  it("returns the feishu config when app_id/secret/tenant are all set, defaulting baseUrl to feishu.cn", () => {
    expect(
      resolveToolPackFeishu({
        OD_FEISHU_APP_ID: "cli_x",
        OD_FEISHU_APP_SECRET: "secret_y",
        OD_FEISHU_TENANT_KEY: "tenant_z",
      }),
    ).toEqual({
      appId: "cli_x",
      appSecret: "secret_y",
      tenantKey: "tenant_z",
      baseUrl: "https://open.feishu.cn",
    });
  });

  it("honors an explicit baseUrl (e.g. Lark international)", () => {
    expect(
      resolveToolPackFeishu({
        OD_FEISHU_APP_ID: "cli_x",
        OD_FEISHU_APP_SECRET: "secret_y",
        OD_FEISHU_TENANT_KEY: "tenant_z",
        OD_FEISHU_BASE_URL: "https://open.larksuite.com",
      }),
    ).toMatchObject({ baseUrl: "https://open.larksuite.com" });
  });

  it("trims the values", () => {
    expect(
      resolveToolPackFeishu({
        OD_FEISHU_APP_ID: "  cli_x  ",
        OD_FEISHU_APP_SECRET: "secret_y",
        OD_FEISHU_TENANT_KEY: "tenant_z",
      }),
    ).toMatchObject({ appId: "cli_x" });
  });

  it("throws when only some of the three are set (all-or-nothing)", () => {
    expect(() =>
      resolveToolPackFeishu({ OD_FEISHU_APP_ID: "cli_x" }),
    ).toThrow(/OD_FEISHU_APP_ID.*together/);
  });

  it("rejects a baseUrl that is not an absolute http(s) URL", () => {
    expect(() =>
      resolveToolPackFeishu({
        OD_FEISHU_APP_ID: "cli_x",
        OD_FEISHU_APP_SECRET: "secret_y",
        OD_FEISHU_TENANT_KEY: "tenant_z",
        OD_FEISHU_BASE_URL: "not a url",
      }),
    ).toThrow(/OD_FEISHU_BASE_URL/);
  });

  it("rejects secrets containing whitespace/control chars (avoids baking garbage)", () => {
    expect(() =>
      resolveToolPackFeishu({
        OD_FEISHU_APP_ID: "cli_x",
        OD_FEISHU_APP_SECRET: "secret with space",
        OD_FEISHU_TENANT_KEY: "tenant_z",
      }),
    ).toThrow(/OD_FEISHU_APP_SECRET/);
  });
});

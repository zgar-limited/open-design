/**
 * Feishu (Lark) OAuth client for the xDesign fork's app-level admission gate.
 *
 * Pure networking helpers that run in the packaged Electron main process. The
 * app_secret reaches this module via the packaged config (internal-only build)
 * and is never exposed to the renderer. Endpoints follow Feishu's OIDC flow:
 *   - authorize:      GET  /open-apis/authen/v1/index
 *   - app token:       POST /open-apis/auth/v3/app_access_token/internal
 *   - code exchange:   POST /open-apis/authen/v1/oidc/access_token
 *   - refresh:         POST /open-apis/authen/v1/oidc/refresh_access_token
 *   - user info:       GET  /open-apis/authen/v1/user_info  (returns tenant_key)
 *
 * The custom scheme xdesign://feishu/callback is the OAuth redirect; the gate
 * window captures it before the OS dispatches it. Endpoint paths are validated
 * end-to-end by the branded smoke build with real credentials.
 */

export type FeishuCreds = {
  appId: string;
  appSecret: string;
  baseUrl: string;
};

export type FeishuTokens = {
  accessToken: string;
  refreshToken: string;
  /** Seconds until accessToken expires. */
  expiresIn: number;
  /** Seconds until refreshToken expires. */
  refreshExpiresIn: number;
};

export type FeishuUserInfo = {
  tenantKey: string;
  name: string;
  openId?: string;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/**
 * Build the Feishu authorize URL the gate window loads. The redirect_uri is the
 * gate's loopback HTTP callback (`http://localhost:<port>/feishu/callback`) —
 * Feishu's redirect-URL config only accepts http(s), not custom schemes, so the
 * gate runs a local server to capture the code.
 */
export function buildAuthorizeUrl(creds: FeishuCreds, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    app_id: creds.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `${creds.baseUrl}/open-apis/authen/v1/index?${params.toString()}`;
}

type FeishuEnvelope<T> = { code: number; msg?: string; data?: T };

/**
 * Call a Feishu endpoint and unwrap its envelope. Throws on a non-zero `code`
 * (Feishu signals all errors — including transport-level — via the envelope,
 * with HTTP 200). Note the two response shapes: most endpoints nest the payload
 * under `{data}`, but the `auth/v3` token endpoints (`app_access_token/internal`)
 * return the fields at the ROOT alongside `code`/`msg` with no `data` wrapper.
 * Accept whichever is present.
 */
async function feishuFetch<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as FeishuEnvelope<T> & Record<string, unknown>;
  if (body.code !== 0) {
    throw new Error(`Feishu API ${url} failed: code=${body.code} msg=${body.msg ?? "<none>"}`);
  }
  const payload = (body.data ?? body) as T;
  if (payload == null) {
    throw new Error(`Feishu API ${url} returned an empty payload`);
  }
  return payload;
}

async function fetchAppAccessToken(creds: FeishuCreds): Promise<string> {
  const data = await feishuFetch<{ app_access_token: string; expire: number }>(
    `${creds.baseUrl}/open-apis/auth/v3/app_access_token/internal`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    },
  );
  return data.app_access_token;
}

/** Exchange an authorization code for user tokens (OIDC flow). */
export async function exchangeCodeForTokens(creds: FeishuCreds, code: string): Promise<FeishuTokens> {
  const appAccessToken = await fetchAppAccessToken(creds);
  const data = await feishuFetch<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_expires_in: number;
  }>(`${creds.baseUrl}/open-apis/authen/v1/oidc/access_token`, {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${appAccessToken}` },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    refreshExpiresIn: data.refresh_expires_in,
  };
}

/** Refresh an expired user access token. */
export async function refreshTokens(creds: FeishuCreds, refreshToken: string): Promise<FeishuTokens> {
  const appAccessToken = await fetchAppAccessToken(creds);
  const data = await feishuFetch<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_expires_in: number;
  }>(`${creds.baseUrl}/open-apis/authen/v1/oidc/refresh_access_token`, {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${appAccessToken}` },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    refreshExpiresIn: data.refresh_expires_in,
  };
}

/** Fetch the signed-in user's tenant_key + name (for admission + display). */
export async function fetchUserInfo(creds: FeishuCreds, userAccessToken: string): Promise<FeishuUserInfo> {
  const data = await feishuFetch<{ tenant_key: string; name: string; open_id?: string }>(
    `${creds.baseUrl}/open-apis/authen/v1/user_info`,
    { headers: { Authorization: `Bearer ${userAccessToken}` } },
  );
  return { tenantKey: data.tenant_key, name: data.name, ...(data.open_id == null ? {} : { openId: data.open_id }) };
}

/** Whole-tenant admission: the user's tenant_key must match the configured tenant. */
export function isAllowedTenant(tenantKey: string, allowedTenantKey: string): boolean {
  return tenantKey === allowedTenantKey;
}

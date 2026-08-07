import { SIDECAR_DEFAULTS } from "@open-design/sidecar-proto";
import {
  releaseChannelFromNamespace,
  releaseChannelFromVersion,
  releaseInstallIdentity,
} from "@open-design/release";

import type { ToolPackConfig } from "../config.js";
import { PRODUCT_NAME } from "./constants.js";

export type MacInstallIdentity = {
  appId: string;
  executableName: string;
  installerTitle: string;
  productName: string;
  publicAppBundleName: string;
  systemAppBundleName: string;
};

function sanitizeNamespace(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function resolveMacInstallIdentity(
  config: Pick<ToolPackConfig, "namespace" | "appVersion" | "brand">,
): MacInstallIdentity {
  const namespaceToken = sanitizeNamespace(config.namespace);
  const channel = releaseChannelFromVersion(config.appVersion)
    ?? releaseChannelFromNamespace(config.namespace, SIDECAR_DEFAULTS.namespace);
  // A fork brand overlay is an app identity of its own — it takes precedence
  // over any channel derived from version/namespace, because a branded build
  // (e.g. xDesign) must never leak the upstream "Open Design <Channel>" name
  // even when it carries a channel-shaped version.
  const branded = config.brand != null;
  const channelIdentity = branded
    ? { appId: config.brand?.appId ?? "io.open-design.desktop", productName: config.brand!.productName }
    : channel == null
      ? { appId: "io.open-design.desktop", productName: PRODUCT_NAME }
      : releaseInstallIdentity(channel);
  const publicAppBundleName = `${channelIdentity.productName}.app`;
  // Branded and channel builds install under the stable public bundle name; only
  // unbranded local builds carry the namespace-suffixed bundle name.
  const systemAppBundleName = branded || channel != null
    ? publicAppBundleName
    : `${PRODUCT_NAME}.${namespaceToken}.app`;

  return {
    ...channelIdentity,
    executableName: channelIdentity.productName,
    installerTitle: branded || channel != null ? channelIdentity.productName : `${PRODUCT_NAME}-${namespaceToken}`,
    publicAppBundleName,
    systemAppBundleName,
  };
}

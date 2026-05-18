import { VERSION } from "./version.js";

export function userAgent(): string {
  const node =
    typeof process !== "undefined" && process.version
      ? process.version.replace(/^v/, "")
      : "unknown";
  const platform =
    typeof process !== "undefined" && process.platform ? process.platform : "browser";
  return `audd-node/${VERSION} node/${node} (${platform})`;
}

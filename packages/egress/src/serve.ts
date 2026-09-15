/**
 * Process entrypoint: start the egress services a network profile grants.
 *
 * Secrets come only from the environment and are never written to disk:
 *
 *   EVOCFD_GATEWAY_TOKEN   token the runtime host presents to the LLM relay
 *   EVOCFD_PROVIDER_KEY    real provider key (or INTERN_AI_API_KEY)
 *   EVOCFD_KEY_FILE        alternatively, read the key from this JSON file
 *   EVOCFD_KEY_NAME        provider name inside that file (default intern-ai)
 *   EVOCFD_PROXY_USER      proxy credential username
 *   EVOCFD_PROXY_TOKEN     proxy credential secret
 *
 * The key-file pair exists so a Windows launcher can hand the key over
 * without invoking node itself: a batch file cannot safely quote an inline
 * script, and a bare node invocation inherits whatever makes the interactive
 * environment hang. Reading the file here keeps one source of truth.
 */
import { readFile } from "node:fs/promises";
import { loadEgressConfig } from "./config.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sshForwardArguments } from "./profiles.ts";
import { startRelay } from "./relay.ts";
import { startProxy } from "./proxy.ts";

export const EGRESS_VERSION = "0.0.0";

/** Default location of the pi agent auth file, relative to the home dir. */
const DEFAULT_KEY_FILE = [".pi", "agent", "auth.json"];

/**
 * Reads a single key out of a pi agent auth file. Backslashes are escape
 * sequences inside a JSON string, but the value is read from disk rather than
 * embedded in code, so a Windows path is never parsed as an escape.
 */
export async function readProviderKey(opts?: {
  file?: string;
  name?: string;
}): Promise<string | undefined> {
  const explicit = opts?.file ?? process.env["EVOCFD_KEY_FILE"];
  const name = opts?.name ?? process.env["EVOCFD_KEY_NAME"] ?? "intern-ai";
  const file = explicit ?? join(homedir(), ...DEFAULT_KEY_FILE);
  try {
    const auth = JSON.parse(await readFile(file, "utf8"));
    const entry = auth[name];
    const value = entry && typeof entry === "object" ? entry.key : entry;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`egress: ${name} is required`);
    process.exit(2);
  }
  return value;
}

/**
 * Clears ambient proxy variables. The egress services are themselves the
 * network boundary: a relay that fetched the provider through whatever
 * HTTP_PROXY happens to be set in the launching environment would silently
 * depend on a second proxy, and lose a third of its reachability to it.
 * Connection is direct unless an explicit upstream proxy is configured.
 */
function clearAmbientProxy(): void {
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  for (const name of names) {
    if (process.env[name] !== undefined && process.env["EVOCFD_UPSTREAM_PROXY"] !== name) {
      console.log(`egress: ignoring ambient ${name}`);
      delete process.env[name];
    }
  }
  const upstream = process.env["EVOCFD_UPSTREAM_PROXY"];
  if (upstream) {
    process.env["HTTPS_PROXY"] = upstream;
    console.log(`egress: upstream proxy ${upstream}`);
  }
}

export async function main(args: string[]): Promise<void> {
  const profileIndex = args.indexOf("--profile");
  const profile = (profileIndex >= 0 ? args[profileIndex + 1] : undefined) as
    | "offline"
    | "llm-only"
    | "llm+web"
    | undefined;

  if (!profile) {
    console.error("usage: serve.ts --profile <offline|llm-only|llm+web>");
    process.exit(2);
  }

  const config = loadEgressConfig();
  clearAmbientProxy();
  if (profile === "offline") {
    console.log("egress: offline profile, no egress services started");
    return;
  }

  const gatewayToken = required("EVOCFD_GATEWAY_TOKEN");
  const providerKey =
    process.env["EVOCFD_PROVIDER_KEY"] ??
    process.env["INTERN_AI_API_KEY"] ??
    (await readProviderKey());
  if (!providerKey) {
    console.error(
      "egress: no provider key found; set EVOCFD_PROVIDER_KEY, INTERN_AI_API_KEY, or EVOCFD_KEY_FILE",
    );
    process.exit(2);
  }

  const servers = [];
  const grant = config.profiles[profile];
  if (grant.llm) {
    servers.push(
      await startRelay(config, {
        gatewayToken,
        providerKey,
        log: (message) => console.log(`[relay] ${message}`),
      }),
    );
  }
  if (grant.web) {
    const user = required("EVOCFD_PROXY_USER");
    const token = required("EVOCFD_PROXY_TOKEN");
    servers.push(
      await startProxy(config, {
        proxyAuthorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
        log: (message) => console.log(`[proxy] ${message}`),
      }),
    );
  }

  console.log(`egress: profile ${profile} serving ${servers.length} service(s)`);
  console.log(
    `egress: ssh forwards for this profile: ${sshForwardArguments(config, profile).join(" ")}`,
  );

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      for (const server of servers) server.close();
      process.exit(0);
    });
  }
  await new Promise(() => {});
}

if (import.meta.url.startsWith("file:") && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main(process.argv.slice(2));
}

/**
 * Process entrypoint: start the egress services a network profile grants.
 *
 * Secrets come only from the environment and are never written to disk:
 *
 *   EVOCFD_GATEWAY_TOKEN   token the runtime host presents to the LLM relay
 *   EVOCFD_PROVIDER_KEY    real provider key (or INTERN_AI_API_KEY)
 *   EVOCFD_PROXY_USER      proxy credential username
 *   EVOCFD_PROXY_TOKEN     proxy credential secret
 *
 * With `--profile offline` nothing is started at all: an offline trial has no
 * egress, and that is enforced by this process refusing to serve.
 */
import { loadEgressConfig } from "./config.ts";
import { pathToFileURL } from "node:url";
import { sshForwardArguments } from "./profiles.ts";
import { startRelay } from "./relay.ts";
import { startProxy } from "./proxy.ts";

export const EGRESS_VERSION = "0.0.0";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`egress: ${name} is required`);
    process.exit(2);
  }
  return value;
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
  if (profile === "offline") {
    console.log("egress: offline profile, no egress services started");
    return;
  }

  const gatewayToken = required("EVOCFD_GATEWAY_TOKEN");
  const providerKey = process.env["EVOCFD_PROVIDER_KEY"] ?? process.env["INTERN_AI_API_KEY"];
  if (!providerKey) {
    console.error("egress: EVOCFD_PROVIDER_KEY (or INTERN_AI_API_KEY) is required");
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

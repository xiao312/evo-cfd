/**
 * Egress configuration.
 *
 * Everything committed here describes topology: which ports the egress services
 * listen on, where the provider really lives, and which capability each network
 * profile grants. It deliberately holds no secrets: provider keys and gateway
 * tokens are supplied at process start and stay off disk in this repository.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type NetworkProfile = "offline" | "llm-only" | "llm+web";

export interface ProfileGrant {
  readonly llm: boolean;
  readonly web: boolean;
}

export interface EgressConfig {
  readonly llm: {
    readonly listenHost: string;
    readonly listenPort: number;
    readonly upstream: string;
    readonly provider: string;
  };
  readonly web: {
    readonly listenHost: string;
    readonly listenPort: number;
  };
  readonly tunnel: {
    readonly bindHost: string;
    readonly remoteUser: string;
  };
  readonly profiles: Record<NetworkProfile, ProfileGrant>;
}

const defaultConfigPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "egress.config.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`egress config: ${where}.${key} must be a non-empty string`);
  }
  return value;
}

function requirePort(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`egress config: ${where}.${key} must be an integer port in 1..65535`);
  }
  return value;
}

function requireGrant(
  profiles: unknown,
  name: NetworkProfile,
): ProfileGrant {
  if (!isRecord(profiles)) {
    throw new Error("egress config: profiles must be an object");
  }
  const entry = profiles[name];
  if (!isRecord(entry)) {
    throw new Error(`egress config: profiles.${name} must be an object`);
  }
  const llm = entry["llm"];
  const web = entry["web"];
  if (typeof llm !== "boolean" || typeof web !== "boolean") {
    throw new Error(`egress config: profiles.${name}.llm and .web must be booleans`);
  }
  return { llm, web };
}

const knownProfiles: readonly NetworkProfile[] = ["offline", "llm-only", "llm+web"];

export function loadEgressConfig(path = defaultConfigPath): EgressConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`egress config: cannot read ${path}: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`egress config: ${path} must contain an object`);
  }

  const llm = parsed["llm"];
  const web = parsed["web"];
  const tunnel = parsed["tunnel"];
  const profiles = parsed["profiles"];
  if (!isRecord(llm) || !isRecord(web) || !isRecord(tunnel) || !isRecord(profiles)) {
    throw new Error(
      "egress config: top-level llm, web, tunnel and profiles objects are all required",
    );
  }

  const loaded: EgressConfig = {
    llm: {
      listenHost: requireString(llm, "listen_host", "llm"),
      listenPort: requirePort(llm, "listen_port", "llm"),
      upstream: requireString(llm, "upstream", "llm"),
      provider: requireString(llm, "provider", "llm"),
    },
    web: {
      listenHost: requireString(web, "listen_host", "web"),
      listenPort: requirePort(web, "listen_port", "web"),
    },
    tunnel: {
      bindHost: requireString(tunnel, "bind_host", "tunnel"),
      remoteUser: requireString(tunnel, "remote_user", "tunnel"),
    },
    profiles: {
      offline: requireGrant(profiles, "offline"),
      "llm-only": requireGrant(profiles, "llm-only"),
      "llm+web": requireGrant(profiles, "llm+web"),
    },
  };

  const unknown = Object.keys(loaded.profiles).filter(
    (name) => !knownProfiles.includes(name as NetworkProfile),
  );
  if (unknown.length > 0) {
    throw new Error(`egress config: unknown profile(s): ${unknown.join(", ")}`);
  }
  return loaded;
}

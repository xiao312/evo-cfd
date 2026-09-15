/**
 * Network capability profiles.
 *
 * A profile is not a label. It decides, concretely, which forwarded endpoints
 * exist at all: `endpointsFor()` is what the container receives, and
 * `tunnelBindings()` is what the SSH supervisor forwards. A `llm-only` trial
 * therefore has no proxy port forwarded, so the capability is enforced by the
 * topology rather than by the agent's goodwill.
 *
 * Inside the container both services are reached through the host gateway, so
 * the bridge network stays intact and nothing is bound on 0.0.0.0.
 */
import type { EgressConfig, NetworkProfile, ProfileGrant } from "./config.ts";

export function grantFor(config: EgressConfig, profile: NetworkProfile): ProfileGrant {
  if (!(profile in config.profiles)) {
    throw new Error(`unknown network profile: ${profile}`);
  }
  return config.profiles[profile];
}

export interface EndpointMap {
  readonly llm: string | null;
  readonly web: string | null;
}

export function endpointsFor(
  config: EgressConfig,
  profile: NetworkProfile,
  gatewayHost = "host.docker.internal",
): EndpointMap {
  const grant = grantFor(config, profile);
  return {
    llm: grant.llm ? `http://${gatewayHost}:${config.llm.listenPort}/v1` : null,
    web: grant.web ? `http://${gatewayHost}:${config.web.listenPort}` : null,
  };
}

export interface TunnelBinding {
  /** Address the SSH server binds on the runtime host, e.g. 172.17.0.1:18080. */
  readonly remote: string;
  /** Address the egress service listens on here, e.g. 127.0.0.1:18080. */
  readonly local: string;
}

export function tunnelBindings(
  config: EgressConfig,
  profile: NetworkProfile,
): readonly TunnelBinding[] {
  const grant = grantFor(config, profile);
  const bindings: TunnelBinding[] = [];
  if (grant.llm) {
    bindings.push({
      remote: `${config.tunnel.bindHost}:${config.llm.listenPort}`,
      local: `${config.llm.listenHost}:${config.llm.listenPort}`,
    });
  }
  if (grant.web) {
    bindings.push({
      remote: `${config.tunnel.bindHost}:${config.web.listenPort}`,
      local: `${config.web.listenHost}:${config.web.listenPort}`,
    });
  }
  return bindings;
}

export function sshForwardArguments(
  config: EgressConfig,
  profile: NetworkProfile,
): readonly string[] {
  return tunnelBindings(config, profile).flatMap((binding) => [
    "-R",
    `${binding.remote}:${binding.local}`,
  ]);
}

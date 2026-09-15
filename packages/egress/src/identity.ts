/**
 * Reproducible, secret-free environment identity.
 *
 * Agent capability is a function of the model, the harness, the tools and the
 * information the environment actually makes reachable. Two episodes were not
 * run under the same environment if one could call the model and the other
 * could not, so the network profile belongs in the environment identity of
 * every trial rather than only in campaign metadata.
 *
 * The identity is derived only from things that are safe to publish: the
 * profile, the upstream hostname, service versions, and the container
 * identity. Secrets are never accepted as input, and credentials are referenced
 * by name only.
 */
import { createHash } from "node:crypto";

export interface EnvironmentIdentityInput {
  readonly profile: string;
  readonly upstream: string;
  readonly egressVersion: string;
  readonly container: string;
}

export function environmentIdentity(input: EnvironmentIdentityInput): string {
  const material = [
    "evocfd-environment-identity/v1",
    `profile=${input.profile}`,
    `upstream=${hostnameOf(input.upstream)}`,
    `egress=${input.egressVersion}`,
    `container=${input.container}`,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * How a credential is referred to in recorded results. The endpoint is public
 * topology; the secret itself is injected at process start and never written
 * down. This is what `result.json` carries instead of an environment dump.
 */
export interface CredentialReference {
  readonly endpoint: string;
  readonly credential_ref: string;
}

export function credentialReference(endpoint: string, name = "default"): CredentialReference {
  return { endpoint, credential_ref: `gateway-token:${name}` };
}

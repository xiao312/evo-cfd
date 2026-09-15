/**
 * Egress health probe.
 *
 * Answers two questions without trusting either service: is the endpoint
 * alive, and is its authentication actually enforced? A relay that answers
 * every request with 200 is not evidence of a working boundary, so the proxy
 * probe deliberately sends a bad credential and expects to be refused.
 */
import { connect } from "node:net";

export type EndpointHealth =
  | { readonly status: "ok" }
  | { readonly status: "unauthorized" }
  | { readonly status: "unreachable"; readonly detail: string };

export interface EgressHealth {
  readonly llm: EndpointHealth;
  readonly web: EndpointHealth;
  readonly ok: boolean;
}

export interface HealthProbeInput {
  readonly llmEndpoint: string;
  readonly gatewayToken: string;
  readonly webEndpoint: string;
  readonly fetchImpl?: typeof fetch;
}

export async function checkEgress(input: HealthProbeInput): Promise<EgressHealth> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const llm = await probeLlm(input, fetchImpl);
  const web = await probeProxy(input);
  return { llm, web, ok: llm.status === "ok" && web.status === "ok" };
}

async function probeLlm(input: HealthProbeInput, fetchImpl: typeof fetch): Promise<EndpointHealth> {
  try {
    const response = await fetchImpl(`${input.llmEndpoint}/models`, {
      headers: { authorization: `Bearer ${input.gatewayToken}` },
    });
    if (response.status === 200) return { status: "ok" };
    if (response.status === 401) return { status: "unauthorized" };
    return { status: "unreachable", detail: `upstream status ${response.status}` };
  } catch (error) {
    return { status: "unreachable", detail: (error as Error).message };
  }
}

function probeProxy(input: HealthProbeInput): Promise<EndpointHealth> {
  const url = new URL(input.webEndpoint);
  return new Promise((resolve) => {
    const socket = connect(Number(url.port), url.hostname);
    const finish = (health: EndpointHealth) => {
      socket.destroy();
      resolve(health);
    };
    socket.setTimeout(2_000, () => finish({ status: "unreachable", detail: "timeout" }));
    socket.on("error", (error) => finish({ status: "unreachable", detail: error.message }));
    socket.on("connect", () => {
      socket.write(
        "CONNECT evocfd-health-check.invalid:443 HTTP/1.1\r\n" +
          "Proxy-Authorization: definitely-wrong\r\n\r\n",
      );
    });
    let seen = "";
    socket.on("data", (chunk) => {
      seen += chunk.toString("latin1");
      if (seen.includes("407")) finish({ status: "ok" });
      else if (seen.includes("\r\n\r\n")) finish({ status: "unauthorized" });
    });
  });
}

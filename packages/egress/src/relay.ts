/**
 * LLM relay: the only path from the runtime host to the model provider.
 *
 * The runtime host carries a gateway token and nothing else. This service,
 * which runs where the provider credential already lives, accepts an
 * OpenAI-completions request, injects the real provider key, and streams the
 * response back verbatim, including server-sent events.
 *
 * Unauthenticated egress is never available: a request without the gateway
 * token gets 401 before any upstream connection is attempted.
 */
import { createServer, type Server } from "node:http";

export interface RelayOptions {
  readonly gatewayToken: string;
  readonly providerKey: string;
  readonly log?: (message: string) => void;
}

/** Response headers undici has already consumed, so echoing them would corrupt the body. */
const dropResponseHeaders = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/** Request headers the relay replaces rather than echoes. */
const dropRequestHeaders = new Set([
  "host",
  "content-length",
  "connection",
  "authorization",
]);

export function startRelay(
  config: EgressConfigLike,
  options: RelayOptions,
): Promise<Server> {
  const { gatewayToken, providerKey, log = () => {} } = options;
  const logRequest = log;

  if (!gatewayToken) throw new Error("relay: gatewayToken is required");
  if (!providerKey) throw new Error("relay: providerKey is required");

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://placeholder.invalid");

    if (presentedToken(request) !== gatewayToken) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid gateway token" } }));
      logRequest(`401 ${request.method} ${url.pathname} (bad gateway token)`);
      return;
    }

    if (!url.pathname.startsWith("/v1/")) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
      logRequest(`404 ${request.method} ${url.pathname}`);
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(
        ([name]) => !dropRequestHeaders.has(name),
      ),
    );
    headers.authorization = `Bearer ${providerKey}`;

    // The configured upstream already ends in /v1, so the request prefix is
    // rewritten rather than echoed: /v1/models -> <upstream>/models.
    const path = `${url.pathname.slice("/v1".length)}${url.search}`;
    const target = `${config.llm.upstream}${path}`;
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
      });
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(`relay upstream error: ${(error as Error).message}\n`);
      logRequest(`502 ${request.method} ${url.pathname} ${(error as Error).message}`);
      return;
    }

    const responseHeaders = Object.fromEntries(
      Object.entries(upstreamResponse.headers).filter(
        ([name]) => !dropResponseHeaders.has(name),
      ),
    );
    response.writeHead(upstreamResponse.status, responseHeaders);
    response.flushHeaders();
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      for await (const chunk of upstreamResponse.body ?? []) response.write(chunk);
    } catch (error) {
      logRequest(`stream broken on ${url.pathname}: ${(error as Error).message}`);
      response.destroy(error as Error);
      return;
    }
    response.end();
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(config.llm.listenPort, config.llm.listenHost, () => {
      server.removeListener("error", reject);
      logRequest(
        `evocfd llm relay listening on ${config.llm.listenHost}:${config.llm.listenPort}`,
      );
      resolve(server);
    });
  });
}

function presentedToken(request: import("node:http").IncomingMessage): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/** Structural view of the config; tests pass a trimmed object. */
export interface EgressConfigLike {
  readonly llm: {
    readonly listenHost: string;
    readonly listenPort: number;
    readonly upstream: string;
  };
}

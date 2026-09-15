/**
 * Authenticated HTTP CONNECT proxy.
 *
 * Plain egress to the internet is a capability, not an open port: this proxy
 * refuses every connection that does not present the proxy credential. With a
 * valid credential it tunnels TCP to an arbitrary host:port, which is what
 * undici's EnvHttpProxyAgent needs for https:// URLs.
 *
 * It is deliberately small and dependency-free, and it serves only CONNECT:
 * plain http:// GET traffic is refused, so the proxy cannot be used to relay
 * unencrypted content. Note that CONNECT requests arrive on the server's
 * 'connect' event, never as 'request'.
 */
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";

export interface ProxyOptions {
  /** Expected Proxy-Authorization value, e.g. "Basic <base64(user:token)>". */
  readonly proxyAuthorization: string;
  readonly log?: (message: string) => void;
}

export interface ProxyConfigLike {
  readonly web: {
    readonly listenHost: string;
    readonly listenPort: number;
  };
}

export function startProxy(
  config: ProxyConfigLike,
  options: ProxyOptions,
): Promise<Server> {
  const { proxyAuthorization, log = () => {} } = options;
  if (!proxyAuthorization) throw new Error("proxy: proxyAuthorization is required");

  const server = createServer();

  server.on("connect", (request, socket) => {
    const target = parseConnectTarget(request.url);
    if (!target) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.end();
      log(`400 malformed CONNECT target: ${request.url}`);
      return;
    }

    if (request.headers["proxy-authorization"] !== proxyAuthorization) {
      socket.write(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="evocfd"\r\n' +
          "Connection: close\r\n\r\n",
      );
      socket.end();
      log(`407 CONNECT ${target.host}:${target.port} (bad proxy credential)`);
      return;
    }

    const upstream = netConnect({ host: target.host, port: target.port });

    upstream.on("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
      log(`200 CONNECT ${target.host}:${target.port}`);
    });

    const teardown = (reason: string) => {
      upstream.destroy();
      socket.destroy();
      log(`closed ${target.host}:${target.port} (${reason})`);
    };
    upstream.on("error", (error) => teardown(`upstream: ${error.message}`));
    socket.on("error", (error) => teardown(`downstream: ${error.message}`));
    socket.on("close", () => teardown("client closed"));
  });

  server.on("request", (request, response) => {
    response.writeHead(405, { allow: "CONNECT", connection: "close" });
    response.end();
    log(`405 ${request.method} ${request.url}`);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(config.web.listenPort, config.web.listenHost, () => {
      server.removeListener("error", reject);
      log(
        `evocfd web proxy listening on ${config.web.listenHost}:${config.web.listenPort}`,
      );
      resolve(server);
    });
  });
}

interface ConnectTarget {
  readonly host: string;
  readonly port: number;
}

function parseConnectTarget(url: string | undefined): ConnectTarget | null {
  if (!url) return null;
  const match = /^([^:\s]+):(\d+)$/.exec(url.trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1]!, port };
}

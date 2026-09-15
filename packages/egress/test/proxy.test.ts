import test from "node:test";
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { startProxy } from "../src/proxy.ts";

/** A plain TCP echo server standing in for an origin the tunnel reaches. */
async function echoOrigin(): Promise<{ port: number; close: () => void }> {
  const server = createServer((socket) => {
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, close: () => server.close() };
}

async function proxyWith(credential: string) {
  const server = await startProxy(
    { web: { listenHost: "127.0.0.1", listenPort: 0 } },
    { proxyAuthorization: credential, log: () => {} },
  );
  const { port } = server.address() as AddressInfo;
  return { port, close: () => server.close() };
}

/** Raw CONNECT client: proves the proxy speaks the tunnel protocol itself. */
function connectThrough(
  proxyPort: number,
  authorization: string,
  target: string,
): Promise<{
  status: string;
  exchange: (message: string) => Promise<string>;
  destroy: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1");
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.on("error", onError);
    socket.on("connect", () => {
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\n` +
          `Proxy-Authorization: ${authorization}\r\n` +
          "Connection: close\r\n\r\n",
      );
    });
    let buffer = "";
    socket.on("data", function relay(chunk: Buffer) {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const status = buffer.slice(0, buffer.indexOf("\r\n"));
      socket.removeListener("data", relay);
      socket.removeListener("error", onError);
      if (!status.includes("200")) {
        socket.destroy();
        resolve({ status, exchange: async () => "", destroy: () => {} });
        return;
      }
      socket.write("ping\n");
      resolve({
        status,
        exchange: (message: string) =>
          new Promise((res) => {
            const expected = `${message}\n`;
            let seen = "";
            const onData = (data: Buffer) => {
              seen += data.toString("utf8");
              if (seen.length >= expected.length) {
                socket.removeListener("data", onData);
                res(seen.slice(0, expected.length));
              }
            };
            socket.on("data", onData);
            socket.write(`${message}\n`);
          }),
        destroy: () => socket.destroy(),
      });
    });
  });
}

test("proxy tunnels CONNECT with a valid credential", async () => {
  const origin = await echoOrigin();
  const proxy = await proxyWith("Basic dXNlcjpzZWNyZXQ=");
  try {
    const session = await connectThrough(
      proxy.port,
      "Basic dXNlcjpzZWNyZXQ=",
      `127.0.0.1:${origin.port}`,
    );
    assert.ok(session.status.includes("200"), session.status);
    assert.equal(await session.exchange("ping"), "ping\n");
    session.destroy();
  } finally {
    proxy.close();
    origin.close();
  }
});

test("proxy refuses CONNECT without a credential", async () => {
  const origin = await echoOrigin();
  const proxy = await proxyWith("Basic dXNlcjpzZWNyZXQ=");
  try {
    const session = await connectThrough(proxy.port, "", `127.0.0.1:${origin.port}`);
    assert.ok(session.status.includes("407"), session.status);
  } finally {
    proxy.close();
    origin.close();
  }
});

test("proxy refuses CONNECT with a wrong credential", async () => {
  const origin = await echoOrigin();
  const proxy = await proxyWith("Basic dXNlcjpzZWNyZXQ=");
  try {
    const session = await connectThrough(proxy.port, "Basic dXNlcjphd3Jvbmc=", `127.0.0.1:${origin.port}`);
    assert.ok(session.status.includes("407"), session.status);
  } finally {
    proxy.close();
    origin.close();
  }
});

test("proxy rejects plain http methods, serving no relayed traffic", async () => {
  const proxy = await proxyWith("Basic dXNlcjpzZWNyZXQ=");
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/`, {
      method: "GET",
    }).catch((error) => ({ status: -1, error }));
    assert.notEqual((response as { status: number }).status, 200);
  } finally {
    proxy.close();
  }
});

test("proxy rejects a malformed CONNECT target", async () => {
  const proxy = await proxyWith("Basic dXNlcjpzZWNyZXQ=");
  try {
    const session = await connectThrough(proxy.port, "Basic dXNlcjpzZWNyZXQ=", "not-a-target");
    assert.ok(session.status.includes("400"), session.status);
  } finally {
    proxy.close();
  }
});

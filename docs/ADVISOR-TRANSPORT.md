# Advisor transport — the read-only bridge

The consultation loop's advisor is a separate LLM reached through a ChatGPT web
session owned by the operator. This document is the frozen record of how, and
the rules that make it reproducible.

## Binding (operator decision)

All advisor requests are made **under one ChatGPT project named EvoCFD**:

https://chatgpt.com/g/g-p-6aabb5ed2e9c8191820aeb6a095bfab0-evocfd

No advisor request is sent outside that project. A new consultation opens a new
chat inside the project, not a standalone chat. This keeps the advisor's context
about the campaign in one place, and it keeps the provenance of every answer
pointing at one auditable conversation space.

## Why a bridge, not attachments

ChatGPT web has a limited action space and a small attachment budget. Pasting a
whole evidence package into a chat does not scale past one consultation, and it
makes the advisor's view of the evidence unauditable — there is no record of
which file it actually read.

The bridge inverts the direction. The operator pastes a short control message;
the advisor pulls exactly the evidence it needs, by name, through a read-only
connection. Every read is a request the bridge can log.

## Topology

```
ChatGPT (cloud)  ──https──▶  Cloudflare tunnel  ──▶  c2c bridge (Windows)
                                                          │ read-only
                                                          ▼
                                              consult-ws/  (frozen export only)
```

- The bridge runs on the Windows operator machine, which is the only side with
  internet egress. This is consistent with the frozen network topology: the
  air-gapped compute server never becomes reachable, and no credential for it
  is exposed.
- The workspace the bridge serves is a **copy of the frozen consultation
  export**, not the repository and not the server. It contains only what the
  export policy already released.
- The tunnel URL is public. `/mcp` still returns 401 without a valid bearer
  token; tokens are issued only after a one-time-use, TTL-bounded pairing code
  that the operator reads from the bridge and types once.

## Security properties, verified

Verified by driving the flow as a hostile client before the first real request:

- Unauthenticated `/mcp` returns **401** with RFC 8414 protected-resource
  metadata. Verified both locally and through the public tunnel.
- OAuth 2.1: dynamic client registration, authorization code with PKCE (S256
  only), token endpoint, refresh rotation.
- Path containment: `read_file` with `../../../../../etc/passwd` is **refused**.
- Sensitive-file policy: a `.env`-style path outside the workspace is
  **refused**.
- The tools are read-only by construction; no write or execute tool exists.

## Attribution

The bridge is [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)
(MIT, © 2026 codex-with-chatgpt contributors), used as-is. EvoCFD does not
redistribute it and adds no code to it; it configures and drives it. The
exported workspace is produced by EvoCFD's own export policy, which is where
the release decision is made.

## Operator checklist (repeatable)

1. Refresh the frozen export into `consult-ws/` (the export policy decides what
   is releasable).
2. Start the bridge with the tunnel. Record the public URL.
3. `c2c pair` — read the pairing code (5-minute TTL, one use).
4. In the EvoCFD ChatGPT project, create or reuse the connector with the URL,
   enter the pairing code once.
5. Send a short control message naming the files to read. Never paste contents.
6. Import the answer with `import-consultation.ts`, which requires the answer to
   declare the request id and digest.

## Rules

- **Never paste file contents, diffs or logs into the chat.** The advisor reads
  them through the bridge.
- **The pairing code is the only secret typed into a browser.** OAuth tokens and
  session cookies are never handled by EvoCFD.
- **The bridge serves the export workspace only.** Pointing it at the repository
  or the server is forbidden.
- **A tunnel restart changes the public URL.** A stable URL needs a named
  Cloudflare tunnel, which is a separate operator decision recorded here when
  taken.

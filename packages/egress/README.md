# @evocfd/egress

Controlled network egress for an air-gapped runtime host. The host can reach
exactly two services on the workstation, both authenticated, and nothing else.

- the **LLM relay** on `18080`, which injects the real provider key so the host
  only ever holds a gateway token
- the **web proxy** on `18081**, CONNECT-only, requiring its own credential

Which of them exist is decided by the network profile, not by labelling: an
`offline` trial starts nothing at all, `llm-only` starts only the relay, and
`llm+web` starts both. The profile therefore determines which SSH forwards
exist, which is what makes the capability real rather than descriptive.

See `docs/DESIGN.md` for the frozen topology and the credential boundary.

## Running

```
node --experimental-strip-types packages/egress/src/serve.ts --profile llm-only
```

Environment:

| variable | meaning |
|---|---|
| `EVOCFD_GATEWAY_TOKEN` | token the runtime host presents to the relay (required for any non-offline profile) |
| `EVOCFD_PROVIDER_KEY` | real provider key, passed directly |
| `INTERN_AI_API_KEY` | accepted as an alias of the above |
| `EVOCFD_KEY_FILE` | alternatively, the pi agent auth file to read the key from |
| `EVOCFD_KEY_NAME` | provider name inside that file, default `intern-ai` |
| `EVOCFD_PROXY_USER` | proxy username (required for `llm+web`) |
| `EVOCFD_PROXY_TOKEN` | proxy secret (required for `llm+web`) |
| `EVOCFD_UPSTREAM_PROXY` | opt-in proxy for the relay's own upstream calls |

### Why the key is read from a file

The Windows launcher is a batch file. It cannot safely quote an inline node
script — cmd's own parser mangles the quotes, and backslashes in a JS string
are escape sequences, so a Windows path dies on `C:\Users` as an invalid `\U`.
A bare `node` invocation is no better, since it inherits whatever makes an
interactive environment hang.

So the launcher sets `EVOCFD_KEY_FILE` and `EVOCFD_KEY_NAME` and lets the
process read the key itself. There is one source of truth — the local pi agent
auth file — and no second copy that can drift out of date.

### Why ambient proxy variables are cleared

The relay is itself the network boundary. If it fetched the provider through
whatever `HTTP_PROXY` happened to be set in the launching environment, its
reachability would silently depend on a second proxy it never agreed to use,
and a workstation with a local proxy for ordinary browsing would make every
relay request fail with a 502 whose cause is nowhere in this package. Ambient
proxy variables are therefore ignored unless `EVOCFD_UPSTREAM_PROXY` opts in.

## Layout

| module | responsibility |
|---|---|
| `config.ts` | the committed topology, validated on load |
| `profiles.ts` | what a profile grants, and which forwards it implies |
| `relay.ts` | the LLM relay: gateway token required, key injected, `/v1/` only |
| `proxy.ts` | CONNECT-only web proxy, `Proxy-Authorization` required |
| `identity.ts` | environment identity: hash of profile, upstream, versions, container — never secrets |
| `health.ts` | probes both services, and that auth is actually enforced |
| `serve.ts` | process entrypoint: reads secrets, starts what the profile grants |

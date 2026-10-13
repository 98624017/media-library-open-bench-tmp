# Synthetic Electron and Node network investigation

The `network` suite exports 16 profiles: ten timed operations per sample plus six one-time
failure controls. Three samples produce 36 rows. The module has no top-level Electron
import; the isolated native entrypoint supplies its Electron instance.

## Product calibration

The product configures both `app.setProxy()` and `session.defaultSession.setProxy()`.
Its Node system-proxy adapter asks the default Session to resolve each URL, chooses the
first DIRECT/HTTP proxy decision, and uses Undici ProxyAgent for a supported HTTP route.
The suite applies the same two Electron surfaces in a fresh native process with isolated
user data. Apply results must both settle successfully before the next request.

Direct, fixed HTTP proxy, and PAC configurations are controlled fixtures. PAC is explicitly
configured with a local script, not read from the host's OS system settings. Each route
profile makes two requests: one path that PAC sends through the proxy and one it sends
direct. Manual sends both through the proxy; direct sends both directly. Node uses the
actual Session resolution for the exact requested URL, not a different probe URL. Real
Session fetch and actual Undici fetch are tested independently. Variant order reverses
between samples.

Old connections are closed before applying a new proxy configuration. In the native quick
probe, closing connections immediately after PAC apply interrupted its asynchronous script
load: the origin saw a PAC fetch, but resolution returned an empty string and fetch failed
with `ERR_MANDATORY_PROXY_CONFIGURATION_FAILED`. Pre-apply connection cleanup restored the
strict PAC routing checks without relaxing them.

Chromium normally bypasses loopback proxies. The fixture uses the virtual host
`bench-origin.test`, mapped only inside the fresh Electron process by host-resolver rules,
and by an allowlisted Node Agent lookup. Its physical destination remains the generated
127.0.0.1 origin. No host DNS or hosts-file change occurs. `<-loopback>` also removes the
manual proxy loopback exception, but that option alone did not make PAC proxy literal
loopback URLs in the initial native probe. This is a fixture requirement, not a product
proxy setting change. The proxy accepts only the registered origin IP/virtual host and port,
always opening its upstream at 127.0.0.1. It supports both ordinary HTTP forwarding
and CONNECT, since Chromium and Undici may use different proxy request forms. Origin-side
socket ports are matched to proxy-owned upstream ports to prove the actual route. Every
request also carries a unique generated case ID; counts must be exactly one.

## Measurement and body lifetime

Timed route rows include Session resolution, fetch establishment, complete buffered body
consumption and scoped dispatcher close. Proxy configuration and cleanup are outside
timing. The large-body rows compare Response.arrayBuffer with a Web-to-file streaming
pipeline over the same manual proxy route. Full data is 16 MiB, quick data is 1 MiB; route
probes are 64 KiB. The same generated payload and expected SHA-256 apply to both transports.
File reading for checksum validation, hashing, socket drain and file deletion are outside
timing. HTTP caching is disabled and every case ID is unique.

A scoped Node dispatcher stays alive until its response body completes or cancellation
finishes. The suite creates isolated agents to make their cleanup observable; this is not
a benchmark of the product's shared agent cache or retirement grace period. The timeout
starts before proxy resolution and spans the full body. Pending resolution/fetch/body
promises remain handled after cancellation; late response bodies are deliberately disposed.
Main-process metrics include the generated origin/proxy server work and exclude Chromium
network-process CPU and RSS, so they are not consumer-only memory measurements.

## Failure controls and cleanup

For each transport, a scoped POST receives headers and a real partial body, then one of
three events: body stalls until the request deadline, origin interrupts the socket, or
the caller aborts after headers. Full body success is forbidden. Deadline/abort identity,
native body promise settlement and no-replay counts are checked. POST is deliberate: these
controls demonstrate one bounded request, not a policy that silently retries a failed
non-idempotent operation. Raw body errors are reported as bounded names/codes.

Each complete row is immediately emitted and saved by the common entrypoint. Socket drain
is checked after every operation. Sessions close their connections; the suite destroys
only sockets accepted or opened by its own generated servers. Final cleanup returns the
fresh native process to direct mode, closes both servers and removes its mkdtemp root.
Failure evidence is emitted before asserting a failed control, so it remains partial data
instead of a success certificate.

## Limits

This tests loopback HTTP transport primitives and calibrated lifetime rules. It does not
validate real OS proxy/PAC settings, HTTPS/TLS, SOCKS, public-host/DNS rebinding protection,
actual API routes, Worker forwarding, updater fallback, provider retries, settings
persistence/rollback, active shared-agent retirement or paid operations. No host system
proxy setting is changed. Default Session/app configuration belongs only to the isolated
native child for this suite.

Run deterministic logic checks with `node --test bench/extended/network.test.mjs`; native
execution uses the parent's Electron wrapper and runner matrix. Missing native support or
failed controls must not be labelled complete.

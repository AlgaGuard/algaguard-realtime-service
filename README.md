# AlgaGuard realtime service

Authenticated HTTPS issues 30-second opaque WebSocket tickets whose subject is derived from the validated Keycloak token. Redis `GETDEL` consumes each ticket atomically, so replay and concurrent reuse fail across service instances. Every organization, device, and current-user subscription uses an authenticated Access Service decision and is revalidated during heartbeat and again before a matching event is delivered. There is no local authorization cache, so membership revocation and ownership transfer cannot create a stale delivery window.

The Redis live channel accepts only strict trusted `telemetry.committed` events. Invalid JSON, missing organization/UUID context, malformed canonical IDs, or sequence mismatches are rejected and counted. Valid events are transformed to the compatible WebSocket telemetry v1.1 envelope, routed by `organizationId` and `deviceUuid`, and retain canonical `deviceId` for display. The released WebSocket v1 connection and subscription protocol remains unchanged; no WebSocket v2 is introduced.

The WebSocket server validates Phase 2.1 subscribe/unsubscribe/ping messages, limits payload size, subscriptions, connection and message rates, applies heartbeat and idle timeouts, and closes slow clients when buffered output or the bounded queue exceeds limits. Redis Pub/Sub remains non-durable live fan-out; clients must recover authoritative state over HTTPS after reconnect.

Metrics cover active connections, authentication failures, ticket replay, accepted/rejected subscriptions, messages, slow clients, queue depth, Redis reconnects, and authorization latency.

```sh
npm ci
npm run check
docker build -t algaguard-realtime-service:local .
```

No production or cloud deployment is claimed.

Cross-service end-to-end completion remains tracked by [algaguard-contracts#16](https://github.com/AlgaGuard/algaguard-contracts/issues/16). This repository validates the consumer boundary but does not by itself claim the full stack identity E2E.

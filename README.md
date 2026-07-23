# AlgaGuard realtime service

Authenticated HTTPS issues 30-second opaque WebSocket tickets whose subject is derived from the validated Keycloak token. Redis `GETDEL` consumes each ticket atomically, so replay and concurrent reuse fail across service instances. Every organization, device, and current-user subscription uses an authenticated Access Service decision and is revalidated during heartbeat; revoked access closes the connection.

The WebSocket server validates Phase 2.1 subscribe/unsubscribe/ping messages, limits payload size, subscriptions, connection and message rates, applies heartbeat and idle timeouts, and closes slow clients when buffered output or the bounded queue exceeds limits. Redis Pub/Sub remains non-durable live fan-out; clients must recover authoritative state over HTTPS after reconnect.

Metrics cover active connections, authentication failures, ticket replay, accepted/rejected subscriptions, messages, slow clients, queue depth, Redis reconnects, and authorization latency.

```sh
npm ci
npm run check
docker build -t algaguard-realtime-service:local .
```

No production or cloud deployment is claimed.

Known completion blocker: [algaguard-contracts#16](https://github.com/AlgaGuard/algaguard-contracts/issues/16) tracks the released WebSocket UUID resource identifiers versus canonical `AG-000001` device identifiers and the missing contract-valid producer envelope. Device-specific end-to-end realtime is not claimed until that versioned compatibility decision is implemented.

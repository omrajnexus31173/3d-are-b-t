# Deploying the BHARAT-AV signalling service

Mobile camera pairing needs a small **always-on Node.js service**. Vercel cannot
host it, and the reasons are structural rather than preferences:

| Requirement | Vercel static/serverless | Persistent Node |
|---|---|---|
| Pairing sessions stored between requests | ✗ no shared memory | ✓ |
| Long-lived WebSocket upgrade | ✗ | ✓ |
| Session survives 10 min TTL + 5 min idle | ✗ | ✓ |

If the app is deployed to Vercel without this service, the Mobile Camera panel
shows a configuration error instead of pairing (see *Failure modes* below).

---

## 1. Deploy the signalling service to Render

**Two paths. The blueprint is faster; both end in the same configuration.**

### Option A — Blueprint (`render.yaml` is in the repo)

1. Render Dashboard → **New** → **Blueprint**
2. Select this repository, branch `main`
3. Render reads `render.yaml` and proposes the `bharat-av-signal` web service
4. When prompted, fill the `sync: false` variables:
   - `ALLOWED_ORIGINS` — **required**, your exact Vercel origin, e.g. `https://your-app.vercel.app`
   - `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` — optional, see §5
5. **Apply**. Wait for the health check to go green.

### Option B — Manual Web Service

| Field | Value |
|---|---|
| Type | Web Service |
| Runtime | Node |
| Root directory | repository root |
| Build command | `npm ci --omit=dev` |
| Start command | `node server/signal-server.mjs` |
| Health check path | `/signal/health` |
| **Instances** | **1** |

> ### Instance count must be 1
> Sessions are held in an in-process `Map`. With two instances behind the load
> balancer, a token minted on one is invisible to the other and pairing fails
> intermittently — the hardest failure mode to debug. Do not enable autoscaling.
> Moving to multiple instances requires a shared store (e.g. Redis), which is a
> separate change.

### Why `npm ci --omit=dev`

The server imports only `node:http`, `node:crypto`, `node:os` and `ws`. A full
install pulls the entire Vite/React/Tailwind toolchain — 164 packages instead of
36 — for a service that never renders anything. Verified locally: the server
starts and serves `/signal/health` with production dependencies only.

---

## 2. Environment variables, by service

### Signalling service (Render)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | auto | — | Injected by Render; read **first** (then `SIGNAL_PORT`) |
| `NODE_ENV` | recommended | — | `production` enables fail-closed origin policy |
| `ALLOWED_ORIGINS` | **yes** | — | Exact frontend origin(s), comma-separated, no trailing slash |
| `TRUST_PROXY` | on Render: `true` | off | Trust right-most `X-Forwarded-For` for client IPs |
| `SIGNAL_TTL_MS` | no | `600000` | Pairing session lifetime |
| `SIGNAL_IDLE_MS` | no | `300000` | Idle session cleanup |
| `SIGNAL_MAX_SESSIONS` | no | `200` | Concurrent sessions |
| `SIGNAL_AUTH_TIMEOUT_MS` | no | `5000` | Unauthenticated socket lifetime |
| `SIGNAL_WS_CONN_LIMIT` | no | `20` | Connections per IP per window |
| `SIGNAL_WS_CONN_WINDOW_MS` | no | `60000` | Rate-limit window |
| `STUN_URLS` | no | Google STUN | Comma-separated STUN URLs |
| `TURN_URL` | mobile data only | — | `turn:host:3478` (or a `turns:` URL) |
| `TURN_USERNAME` | with TURN | — | **Server-side only** |
| `TURN_CREDENTIAL` | with TURN | — | **Server-side only** |

> **The base URL contract.** Every request appends a route to the base
> (`${base}/health`, `${base}/session`, `${base}/ws`), so the resolved base
> always ends in `/signal`. `normaliseSignalBase()` enforces this once, at
> resolution time, which is why the environment variable can be either form.
>
> ```text
> VITE_SIGNAL_URL=https://svc.onrender.com        -> https://svc.onrender.com/signal/health
> VITE_SIGNAL_URL=https://svc.onrender.com/signal -> https://svc.onrender.com/signal/health
> VITE_SIGNAL_URL=https://svc.onrender.com/signal/signal -> same (collapsed)
> ```

### Frontend (Vercel)

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SIGNAL_URL` | **yes** | Public URL of the signalling service, e.g. `https://bharat-av-signal.onrender.com`. Either the bare origin or the origin **with** `/signal` is accepted — both normalise to the same endpoints. |

---

## 3. Configure Vercel

1. Project → **Settings** → **Environment Variables**
2. Add `VITE_SIGNAL_URL` = `https://<your-service>.onrender.com`
   - The bare origin is correct and recommended. Appending `/signal` also works;
     `/signal/signal` is collapsed automatically. Do **not** append a route such
     as `/health` or `/session` — the app adds those itself.
   - **No trailing slash.**
   - Scope: **Production** (add Preview too if you test pairing there — but then
     that origin must also be in `ALLOWED_ORIGINS`)
3. **Redeploy.** This variable is compiled into the bundle by `vite build`; an
   existing deployment will not pick it up.

> **Why redeploy is mandatory:** Vite inlines `import.meta.env.VITE_*` at build
> time. Changing the variable without a rebuild leaves the old value in the
> deployed JavaScript. This is the single most common deployment mistake here.

---

## 4. Health check and production verification

Health URL: `https://<your-service>.onrender.com/signal/health`

```bash
curl -sS https://<your-service>.onrender.com/signal/health
# expected: {"ok":true,"sessions":0,"ttlMs":600000}
```

A `503` with `{"error":"origin_config_missing"}` means `ALLOWED_ORIGINS` is not
set on the service — intentional fail-closed behaviour, not a bug.

**Verification sequence** (do these in order; each isolates one layer):

1. **Service is up and configured**
   `curl .../signal/health` → 200 JSON.
2. **Origin policy is right**
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
     -H "Origin: https://your-app.vercel.app" \
     -H 'Content-Type: application/json' -d '{}' \
     https://<your-service>.onrender.com/signal/session
   ```
   → `201`. Repeat with `-H "Origin: https://evil.example.com"` → `403`.
3. **Frontend is pointed at the service**
   Open the Vercel app → Mobile Camera → **Generate pairing QR**. The panel
   should show the Render URL. If it shows a configuration error, `VITE_SIGNAL_URL`
   was missing at build time — redeploy.
4. **Same Wi-Fi pairing** (physical phone required)
   Scan the QR on a phone joined to the same Wi-Fi. Expect the phone preview,
   then `peer: connected` on the laptop.
5. **Camera publishing and detection**
   Press **Start camera** on the phone; the laptop should show `PHONE FEED` and
   `CAM-` detections.
6. **Disconnect / reconnect**
   Close the phone tab → laptop stops scoring within a few seconds. Generate a
   **fresh** QR (tokens are single-use) and reconnect.
7. **Remote / mobile data** (requires TURN — see §5)

---

## 5. When TURN is required

STUN alone is enough for most same-Wi-Fi pairing: both peers discover their
public addresses and connect directly.

TURN relaying becomes **necessary** when the peers cannot establish a direct
path, which is the normal case for:

- **Phone on mobile data** — carrier-grade NAT frequently blocks UDP hole-punching
- **Symmetric NAT** on either side
- **Corporate / guest Wi-Fi** with client isolation
- **VPNs** that drop non-tunnelled UDP

Without TURN those cases fail at ICE with no video. The UI reports an ICE
failure rather than hanging — that is expected behaviour, not a bug.

Configure it on the **signalling service only**:

```
TURN_URL=turn:turn.yourdomain.com:3478
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

`/signal/info` will then report `turnConfigured: true`. The credentials are
fetched by the browser from the signalling server **after** a session is
created — they never appear in the frontend bundle.

> **Never prefix TURN variables with `VITE_`.** Anything with that prefix is
> inlined into publicly served JavaScript. A TURN credential exposed that way can
> be used to relay arbitrary traffic through your server at your expense.

---

## 6. Failure modes and what they mean

| Symptom | Cause | Fix |
|---|---|---|
| Panel: "VITE_SIGNAL_URL is not configured…" | Variable missing at build time | Set it on Vercel, **redeploy** |
| DevTools shows `…/health` → **404** while `…/signal/health` → 200 | The base URL lacked the `/signal` mount point | Fixed in the client: values are normalised, so a bare origin now resolves to `/signal/*`. If you still see `/health`, the deployment predates the fix — rebuild |
| Health returns `503 origin_config_missing` | `ALLOWED_ORIGINS` unset in production | Set it on Render |
| Browser console: CORS error, no `Access-Control-Allow-Origin` | Frontend origin not in `ALLOWED_ORIGINS` | Add exact origin (no trailing slash) |
| Socket closes with `4401` | Not authenticated within 5 s | Check clock/subnet reachability; usually a network path issue |
| Socket closes with `4403` | Origin rejected on the WebSocket | Frontend origin not allowlisted |
| Socket closes with `4029` | Per-IP connection rate limit | Raise `SIGNAL_WS_CONN_LIMIT` |
| Pairing works on Wi-Fi, fails on mobile data | No TURN | Configure TURN (§5) |
| Pairing fails intermittently, works on retry | More than one instance | Set instances to 1 |
| "Token already used" | QR reused | Tokens are single-use by design; generate a fresh QR |

---

## 7. Local development (unchanged)

```bash
npm run dev:signal     # signalling server + Vite together
# or
npm run signal         # signalling only, port 8787
npm run dev            # Vite only, proxies /signal-proxy -> 127.0.0.1:8787
```

In development `VITE_SIGNAL_URL` is not required: the app falls back to the Vite
proxy path `/signal-proxy/signal`, which `vite.config.ts` forwards to the local
server with WebSocket support enabled. That path exists **only** in the dev
server, which is exactly why production must not rely on it.

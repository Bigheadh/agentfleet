# AgentFleet Mobile (`@agentfleet/mobile`)

This is the Expo (SDK 58, expo-router) app for monitoring and approving AgentFleet tasks from your phone. It talks to a self-hosted **hub** over REST (`/api/*`) and a live WebSocket (`/ws/client`). The protocol types and zod schemas come from the workspace package [`@agentfleet/proto`](../../packages/proto/src).

## Running it

```bash
# from the repo root
pnpm install
pnpm --filter @agentfleet/mobile start      # Metro + QR code for Expo Go
pnpm --filter @agentfleet/mobile web        # browser build (camera scan is disabled on web)
```

- **Expo Go**: install Expo Go on the phone, then scan the QR code that `expo start` prints. The phone and the dev machine must be on the same network; if they aren't, use `expo start --tunnel`.
- **Development build**: everything the app uses (`expo-camera`, `expo-secure-store`, `expo-local-authentication`) ships with Expo Go, so you only need a dev build (`npx expo run:ios|android` or `eas build --profile development`) for store-like testing.

### Pairing with a hub

1. Start the hub with `pnpm hub start --public-url http://<LAN-IP or domain>:8787`. On first start it prints a pairing QR code. Run `pnpm hub pair` at any time to get a new code. The QR code holds `{"v":1,"hub":"…","code":"…","name":"…"}` (`PairingPayload`); codes are single-use and expire after 10 minutes. The `hub` URL has to be reachable from the phone, so don't use `localhost`.
2. In the app, tap **扫描二维码** and scan it. You can also type the hub URL and pairing code under **手动输入**.
3. The app calls `POST /api/pair` and stores the returned device token in the Keychain/Keystore via `expo-secure-store`. On web it goes to `localStorage`. **设置 → 取消配对** deletes it from this device; to revoke it, do that on the hub.

> **Plain `http://` hubs**: Expo Go allows cleartext traffic. Standalone iOS/Android builds block it by default (ATS / `usesCleartextTraffic`). Serve the hub over HTTPS (for example behind Tailscale/Caddy), or add `expo-build-properties` with the cleartext exceptions before you build.

## Scripts

| Command | What it does |
|---|---|
| `pnpm --filter @agentfleet/mobile start` | `expo start` |
| `pnpm --filter @agentfleet/mobile typecheck` | `tsc --noEmit` (also type-checks the proto sources it imports) |
| `pnpm --filter @agentfleet/mobile test` | vitest on the pure modules (timeline reducer, diff and URL helpers) |
| `pnpm --filter @agentfleet/mobile export:web` | `expo export --platform web`, a smoke test that Metro resolves the workspace package |

## Layout

```
src/
  app/                      expo-router routes
    _layout.tsx             providers (session) + root stack
    pair.tsx                QR scan / manual pairing
    (app)/_layout.tsx       redirects to /pair when unpaired; FleetProvider; stack
    (app)/(tabs)/index.tsx  任务 — live task list, pull-to-refresh, approval badge
    (app)/(tabs)/nodes.tsx  节点 — online state, load, runtimes (tier/login)
    (app)/(tabs)/settings.tsx 设置 — hub info, unpair
    (app)/tasks/new.tsx     新任务 — project / agent / priority / prompt
    (app)/tasks/[id].tsx    任务详情 — streamed timeline, approvals, diff, composer, actions
  api/client.ts             typed REST client; every response is zod-validated
  api/ws.ts                 LiveSocket: reconnect with backoff, ping, resubscribe with after=lastSeq
  timeline/reduce.ts        pure EventEnvelope[] → timeline items reducer (+ tests)
  timeline/useRunTimeline.ts REST backfill (after=-1) then WS follow, 50 ms batching
  state/session.tsx         paired session, HubClient + LiveSocket lifecycle
  state/fleet.tsx           tasks / nodes / projects with live upserts
  state/storage(.web).ts    secure-store on native, localStorage on web
  lib/dialog(.web).ts       confirm dialogs; biometric confirmation for `danger` approvals
  lib/diff.ts               dependency-free unified diff classifier + LCS line diff
  i18n/strings.ts           all UI strings (Simplified Chinese), one place for i18n later
```

## Monorepo / Metro notes

- Since SDK 52, `expo/metro-config` detects the pnpm workspace on its own: it sets `watchFolders` to the repo root and adds the right `nodeModulesPaths`. That is why the app has no `metro.config.js`. The Expo docs advise against setting these by hand. Add a `metro.config.js` only if you need other customizations, and build it on `getDefaultConfig(__dirname)`.
- `@agentfleet/proto` is consumed as TypeScript source (`exports: {".": "./src/index.ts"}`) and imports its siblings with `.ts` extensions. Metro resolves these as-is. `tsconfig.json` enables `allowImportingTsExtensions` so `tsc` accepts them too. `expo export -p web` is the check that proves Metro resolution works.
- `zod` is a direct dependency of both the app and proto. pnpm dedupes them to the same version, so the schema instances and types stay compatible.

## Behaviour notes

- **Timeline**: consecutive `message.delta` events with the same role are merged into one bubble. `reasoning.delta` is merged into a collapsed "思考过程" block. Tool calls are collapsible cards: `output` replaces the accumulated output and `outputDelta` appends to it. Plan, usage and the aggregated diff are kept as "latest value" state. Events are deduplicated by `seq`, so the REST backfill and the WS stream can overlap safely.
- **Approvals**: approval cards are colored by risk (read/write/exec/danger). For `danger` approvals, an allow decision requires biometric/passcode authentication when the device is enrolled, and a confirm dialog otherwise. Buttons are hidden once the run has ended.
- **Follow-up input**: the composer appears only when the run's runtime declares `multiTurn`. It is available while the run is active and also in `review`, because the hub reopens the run.
- **Post-run actions**: commit / push / create PR / discard appear when the task is in `review`. Discard asks for confirmation. If the result includes a URL (a PR), the app offers to open it.

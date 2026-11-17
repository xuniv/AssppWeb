# Agent Instructions for AssppWeb

## TypeScript Code Style

- **Indentation**: 2 spaces
- **Semicolons**: Required
- **Quotes**: Single quotes for strings
- **Naming**: PascalCase for types/interfaces, camelCase for variables/functions

## Project Structure

- `backend/` — Node.js/Express server (TypeScript, ESM)
- `frontend/` — React SPA (TypeScript, Vite, Tailwind CSS)
- `runtime/tests/` — actual interpreter checks in Chromium and WebKit (Playwright)
- `references/ApplePackage/` — Swift UI-model reference (optional local checkout)
- `runtime/` — pinned client-side Store engine, public assets and reproducible build adapters
- Multi-stage Docker build (single container serves both)

## Architecture — Client Store runtime

Device processing is the default. In that mode the server is a blind TCP proxy
and never sees Apple credentials. Optional server processing has a different
trust model and requires the browser's explicit login-toggle consent before any
credentials or account state are sent.

- `runtime/` pins ipatool's modern ARM64 SAP, Store framework, Anisette, Store AMD and KBSync implementation. Read `runtime/README.md` before changing the protocol or the guest bridge.
- In device mode, the browser runs Go/WASM plus Unicorn's TCG interpreter in a Web Worker. Go terminates Apple TLS inside the worker. `runtime/web/sockets.mjs` carries encrypted TCP through Wisp; the backend never receives plaintext login, token or provisioning requests.
- Account/provisioning records remain in client IndexedDB. The separate public-image database contains only immutable, hash-verified Apple images. Active SAP signer contexts are never persisted.
- Build-time extraction obtains pinned public images from Apple's official restore CDN and packages compressed data with the app/image. Browsers decompress bounded images, verify their hashes in the Go loader, and cache them locally. Do not parse large restore images inside iOS WebContent processes.
- The native Asspp app builds this shared protocol as a static Go/C library with an ARM64 TCI interpreter and direct approved Apple TCP connections. It requires no WebView, JIT or hosted authentication server.
- After obtaining download information, the browser sends only the existing CDN URL, SINFs and iTunes metadata to the backend for IPA assembly. Keep credentials and runtime state out of these requests.
- Keep TLS certificate/hostname verification enabled. The pinned public CA bundle includes Mozilla roots and Apple Root CA. Never add environment-specific proxy roots to published artifacts.

### Optional server processing

- `runtime/native/` builds the same pinned Store engine with static Unicorn TCI, including a one-operation Linux stdio worker. Docker bundles this worker and reuses the existing verified public assets. No browser/WASM runtime is started for server-mode requests.
- The login screen has one explicit server-processing toggle, off by default, with a brief trust line: the server operator can access Apple ID/password/2FA, tokens, cookies and provisioning records for every account used in server mode. Never silently switch transports after a failure or transfer existing credentials merely because the server advertises this feature.
- Only `/api/store-runtime` receives account state, after access auth and the versioned consent header. It uses its own 8 MiB parser before the general API parser. Keep uploads, IPA assembly and other routes free of account secrets.
- Server execution uses one native child per operation, private stdin/stdout, no saved accounts, no raw logs and no inherited operator secrets/proxy settings. Enforce bounded concurrency, output, process duration and cancellation on disconnect. Never queue credential-bearing work on the server.
- State returns to browser IndexedDB. The server sees it while processing; do not describe server mode as blind or zero trust. Both modes preserve the same modern protocol, typed failures, per-account GUID and verified Apple TLS with approved Apple destinations.
- Require HTTPS for remote server-mode requests (explicit localhost/loopback is allowed for local use). Mode changes cancel current work and invalidate queued requests; no automatic fallback is allowed.

## Reference Implementation

The Swift reference at `references/ApplePackage/` documents the UI model mappings. The pinned ipatool revision in `runtime/` is authoritative for authentication and Store operations:

- Field mappings (iTunes API → Software type) use Swift `CodingKeys`
- Preserve the upstream ipatool authentication/provisioning/download sequence and typed failures
- Keep frontend adapters limited to client state and UI-model translation

### iTunes API Field Mapping

The backend (`backend/src/routes/search.ts`) maps raw iTunes API fields to our `Software` type, matching the Swift CodingKeys in `references/ApplePackage/Sources/ApplePackage/Models/Software.swift`:

| iTunes Field                | Software Field |
| --------------------------- | -------------- |
| `trackId`                   | `id`           |
| `bundleId`                  | `bundleID`     |
| `trackName`                 | `name`         |
| `artworkUrl512`             | `artworkUrl`   |
| `currentVersionReleaseDate` | `releaseDate`  |

All other fields (`version`, `price`, `artistName`, `sellerName`, `description`, `averageUserRating`, `userRatingCount`, `screenshotUrls`, `minimumOsVersion`, `fileSizeBytes`, `releaseNotes`, `formattedPrice`, `primaryGenreName`) keep their original names.

The backend also extracts the `results` array from the iTunes wrapper `{ resultCount, results }` before sending to the frontend.

## Per-Account Device Identifiers

Device identifiers are **per-account**, not global:

- Generated as 12 random hex chars (6 bytes) at account creation via `generateDeviceId()`
- Editable during login, immutable after authentication
- Stored in IndexedDB on the `Account` object as `deviceIdentifier`
- Passed to all Apple protocol calls (auth, purchase, download, version listing)

## Pod-Based Host Routing

After authentication, Apple returns a `pod` header:

- Store API: `p{pod}-buy.itunes.apple.com` (default: `p25-buy.itunes.apple.com`)
- Purchase API: `p{pod}-buy.itunes.apple.com` (default: `buy.itunes.apple.com`)
- Pod is stored on the Account object and used for all subsequent API calls
- Functions: `storeAPIHost(pod?)` and `purchaseAPIHost(pod?)` in `frontend/src/apple/config.ts`

## Protocol changes

Do not reduce authentication to legacy SAP signing plus endpoint retries. Modern Store requests require framework-generated requests, machine provisioning, Store AMD proofs and KBSync. Keep login, purchase, downloads and both version operations on the same pinned runtime. Preserve explicit credential, 2FA, token and license failures. Retrying a real credential failure is not a transport recovery.

Browser/guest errors may expose only allowlisted error codes and numeric HTTP status. Do not retain raw Apple responses, cookies, tokens, signatures, redirect queries, correlation identifiers or evaluated WKWebView arguments in logs.

## Dynamic Host Validation (Backend)

The Wisp server validates target hosts via `hostname_whitelist` in `backend/src/services/wsProxy.ts`:

- `itunes.apple.com` — public storefront discovery before download version selection
- `apps.apple.com` — public storefront and iOS catalog fallback
- `s.mzstatic.com` — public SAP setup certificate
- `fpinit.itunes.apple.com` — SAP setup exchange, browser TLS only
- `auth.itunes.apple.com` — bag-resolved auth endpoint
- `buy.itunes.apple.com` — purchase endpoint
- `init.itunes.apple.com` — bag endpoint
- `/^p\d+-buy\.itunes\.apple\.com$/` — pod-based hosts
- `downloaddispatch.itunes.apple.com` — redownload/update dispatch endpoints
- `uclient-api.itunes.apple.com` — public iOS version lookup (no account headers/cookies)
- `gsa.apple.com` — Anisette and Store AMD provisioning, client TLS only
- `www.apple.com` — public Apple root certificate
- Port restricted to `443` only
- Direct IP targets blocked (`allow_direct_ip = false`)
- Loopback IP targets blocked (`allow_loopback_ips = false`)
- Private/reserved resolved IPs allowed (`allow_private_ips = true`) for Docker/OrbStack DNS translation while hostname allowlist remains the primary control

Downloads, licensing and version operations use the pinned ipatool implementation through `frontend/src/apple/storeRuntime.ts`. Preserve typed auth/license failures. Do not restore a separate browser implementation of legacy `volumeStore` retries.

## Bag Proxy (Backend)

The backend proxies the bag endpoint via `GET /api/bag?guid=<deviceId>` using Node.js native HTTPS. It sends Configurator-compatible request headers (`User-Agent`, `Accept: application/xml`). The bag response is public data (Apple service URLs) — no credentials are involved. See `backend/src/routes/bag.ts`.

## Backend

### Temporary IPA uploads (fork extension)

- Keep upload routes and state in `routes/uploads.ts` and `services/uploadManager.ts`; uploaded files must never be extracted or rewritten.
- `/uploads` is a separate UI route next to Downloads and works without an Apple account. Apple credentials must never be part of an upload request.
- Stream raw IPA bodies to disk with enforced byte limits. Only bounded main-app XML/binary `Info.plist` metadata may be decompressed for manifests.
- Uploads use `DATA_DIR/uploads`, are deleted on every server startup, and follow configured age/space limits independently of the download cache. Do not persist uploaded IPA metadata into upstream tasks.
- Management APIs require access auth; only UUID-bearing `/api/install/uploads/...` URLs are public, matching upstream OTA installation behavior.
- Build and test on Node 24. Runtime images must contain only production backend dependencies.

- Express + `@mercuryworkshop/wisp-js` for HTTP and Wisp proxy
- ESM modules (`"type": "module"` in package.json)
- `tsx` for development, `tsc` for production build
- SINF injector also handles optional `iTunesMetadata.plist` injection at IPA root
- Bag proxy for `init.itunes.apple.com`

### Backend Shared Utilities

- `backend/src/utils/route.ts` — shared Express route helpers (`getIdParam`, `requireAccountHash`, `verifyTaskOwnership`)
- `backend/src/config.ts` — centralized constants (`MAX_DOWNLOAD_SIZE`, `DOWNLOAD_TIMEOUT_MS`, `BAG_TIMEOUT_MS`, `BAG_MAX_BYTES`, `MIN_ACCOUNT_HASH_LENGTH`) and env-var config (`disableHttpsRedirect` via `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT`)

## Frontend

- React 19, React Router 7, Zustand for state
- Tailwind CSS 4 for styling
- Vite for build tooling
- IndexedDB for credential storage (via `idb`)
- Store protocol and verified TLS execute in `runtime/`, loaded from `/store-runtime/store-runtime.js` in a dedicated worker.
- `apple/storeRuntime.ts` serializes state transactions and keeps provisioning state in IndexedDB. Only the explicitly selected server transport may send state to `/api/store-runtime`.
- `Authenticator` is retained across 2FA submissions. Storefront and pod omissions retain the previous routing. Existing accounts should sign in again once after the runtime migration.
- Keep the public-image IndexedDB cache separate from account records. Cache failures must not prevent authentication when the packaged public images remain available.
- Plist build/parse (`frontend/src/apple/plist.ts`) uses native XML builder and browser-native `DOMParser`
- Cookie helper (`frontend/src/apple/cookies.ts`) — `extractAndMergeCookies(rawHeaders, existingCookies)` replaces the repeated extract-and-merge pattern across all Apple protocol files

### Frontend Shared Components (`components/common/`)

- **Alert** — `<Alert type="error|success|warning">` for status messages (replaces inline alert divs)
- **Modal** — `<Modal open={bool} onClose={fn} title={string}>` for dialog overlays
- **Spinner** — inline SVG loading spinner for buttons
- **CountrySelect** — optgroup-based country dropdown with "Available Regions" + "All Regions"
- **AppIcon** — 3 sizes (40/56/80px), rounded corners, letter fallback
- **Badge** — color-coded status pill
- **ProgressBar** — gray track, blue fill, percentage label
- **icons** — shared SVG icon components (`HomeIcon`, `AccountsIcon`, `SearchIcon`, `DownloadsIcon`, `SettingsIcon`, `SunIcon`, `MoonIcon`, `SystemIcon`) used by Sidebar, MobileNav, and MobileHeader

### Frontend Shared Utilities (`utils/`)

- `utils/error.ts` — `getErrorMessage(e, fallback)` for standardized catch-block error extraction
- `utils/crypto.ts` — AES-GCM encrypt/decrypt for account export/import
- `utils/account.ts` — `accountHash()`, `accountStoreCountry()`, `firstAccountCountry()`

### Import Ordering Convention

1. React / library imports (`useState`, `useNavigate`, `useTranslation`)
2. Layout components (`PageContainer`)
3. Common components (`AppIcon`, `Alert`, `Spinner`, `Modal`, `CountrySelect`)
4. Sibling components within the same feature folder (e.g., `DownloadItem` inside `Download/`)
5. Hooks / stores (`useAccounts`, `useSettingsStore`)
6. Apple protocol / API modules (`authenticate`, `purchaseApp`, `apiPost`)
7. Utilities (`accountHash`, `getErrorMessage`)
8. Config (`countryCodeMap`, `storeIdToCountry`)
9. Types (`type Software`)

**Enforcement**: Every PR must verify import ordering. Common mistakes:

- Putting hooks/stores before layout/common components
- Putting config before utilities
- Putting type imports in the middle instead of last

## Security Model

### Account Hash Is Public

`accountHash` is a SHA-256 of the account email. It is treated as **public, non-secret data** — it identifies which account owns a download but does not grant any privileged access. No authentication is bound to it. The server does not manage Apple account sessions; optional Store processes receive explicitly authorized state per operation.

### Trusted Sources

- **Apple API responses** (bag XML, iTunes search results, `customerMessage` fields) are treated as trusted content. No additional sanitization is applied beyond what React's text rendering provides (no `dangerouslySetInnerHTML`).
- **Apple CDN redirects** during IPA download are trusted. The initial URL is validated against `*.apple.com`, and redirect targets from Apple's CDN infrastructure (e.g., Akamai) are followed. The response body is saved to disk — it is never reflected back to the requester.

### Browser as Security Boundary

Credentials (passwords, `passwordToken`, cookies) stored in IndexedDB are protected by the browser's same-origin policy. Encrypting them at rest would be security theater — the decryption key would also live in JS. The threat model assumes the browser environment is trusted; if an attacker has XSS, they can exfiltrate credentials regardless of at-rest encryption.

### Backend Does Not Reflect Request Headers

The settings endpoint (`/api/settings`) must never reflect request headers (`x-forwarded-host`, `host`, etc.) in its response body. Use server-side values only (`config.*`, `process.uptime()`).

## Error Handling

- Early returns to reduce nesting
- `try/catch` for async operations
- Express error middleware for centralized handling
- Type-safe error responses

### Apple Protocol Error Codes

- `2034` / `2042`: Token expired — re-authentication required
- `5002` from `buyProduct`: license already owned (Apple pairs it with the generic "An unknown error has occurred"); treated as success with `alreadyOwned: true`, matching ipatool's `ErrLicenseAlreadyExists`
- `customerMessage === 'Your password has changed.'`: Password token invalid
- `action.url` ending in `termsPage`: Terms acceptance required (throw with URL)

## Testing

### Formatting

Run the repository-pinned Prettier from the root. Its configuration enforces two-space indentation, semicolons, single quotes, and a 120-column wrap target.

```bash
npm ci
npm run format
npm run format:check
```

### Unit Tests

```bash
cd backend && npx vitest run    # Node environment
cd frontend && npx vitest run   # jsdom environment with fake-indexeddb
```

### E2E Tests (Playwright)

```bash
cd e2e && pnpm test                            # Local (requires Docker on port 8080)
docker compose --profile test run --rm playwright  # Docker-based
bash e2e/docker-test.sh                        # Full: build + test + zero-trust verify
```

E2E tests import from `./fixtures` instead of `@playwright/test`.

WebSocket proxy tests use `location.host` to derive URLs dynamically, so they work both locally (`localhost:8080`) and in Docker (`asspp:8080`).

Real-account Docker verification (2026-02-22): authentication succeeds through Wisp, and backend logs contain only connection/stream metadata (no Apple credentials, password tokens, or cookies).

E2E tests cover:

- Wisp proxy (accepts /wisp/ WebSocket, rejects non-wisp paths)
- Add account flow (device ID field, randomize button, auth)
- Account detail (device ID, pod display)
- Settings page (no global device ID section)
- Search/lookup by bundle ID (verifies iTunes field mapping)
- Downloads API (iTunesMetadata support, backward compatibility)

### Test Account

Test credentials are stored in environment variables (`TEST_EMAIL`, `TEST_PASSWORD`, `TEST_DEVICE_ID`, `TEST_BUNDLE_ID`) and must never be committed to the repository.

## Deployment

```bash
docker compose up --build -d   # Builds and runs on port 8080
```

Single container serves both the Express backend and the Vite-built React SPA. SPA routes are handled by serving `index.html` for all non-API paths.

### Docker E2E Testing

The `compose.yml` includes a `playwright` service under the `test` profile:

```bash
docker compose --profile test run --rm playwright
```

This runs Playwright inside the official `mcr.microsoft.com/playwright` image, connecting to the app container via Docker internal DNS (`http://asspp:8080`). The `asspp` service has a healthcheck so the test container waits until the app is ready.

The `e2e/docker-test.sh` script automates the full flow: build, test, and verify zero-trust by scanning backend logs for credential leaks.

## Interface Design System

### Intent

**Who**: Developers and power users managing Apple app downloads outside the App Store — sideloading IPAs, managing multiple Apple IDs, tracking licenses. Technical audience, likely running this alongside terminals or Xcode.

**Task**: Authenticate Apple accounts → search apps → acquire licenses → download/compile IPAs → install.

**Feel**: A sharp utility. Precise like a package manager, clear like Apple's developer tools. Confident, quiet, functional. Not playful, not corporate.

### Design Tokens

- **Primary accent**: `blue-600` / `blue-700` (hover) — trust + system authority, echoes Apple dev tooling
- **Backgrounds**: `gray-50` (app), `white` (cards/surfaces)
- **Text**: `gray-900` (primary), `gray-600` (secondary), `gray-400` (tertiary)
- **Borders**: `gray-200` (default), `gray-300` (hover) — use sparingly, prefer background tinting for containment
- **Status badges**: Muted tones — `green` (completed), `blue` (downloading), `yellow` (paused), `purple` (injecting), `red` (failed), `gray` (pending)
- **Alerts**: `red-50`/`red-700` (error), `amber-50`/`amber-700` (warning), `green-50`/`green-700` (success)

### Typography

- System font stack (Inter / SF Pro fallback)
- Weight scale: `500` (medium, workhorse), `600` (semibold, page titles and key labels only). Avoid `700` in body.
- Size scale: `xs` (12px), `sm` (14px), `base` (16px), `lg` (18px), `xl` (20px), `2xl` (24px)

### Spacing

- Base unit: `4px`
- Consistent vertical rhythm: `space-y-4` within sections, `space-y-6` between sections
- Page padding: `px-4 sm:px-6`, `py-6`
- Container: `max-w-5xl` (1024px)

### Depth & Surfaces

- Single elevation: white cards on `gray-50` background
- No shadows. Borders only where they serve function (form inputs, dividers, interactive boundaries)
- Rounded corners: `rounded-lg` (8px) for cards, `rounded-md` (6px) for inputs/buttons, `rounded-full` for badges
- Prefer background tinting (`gray-50` → `gray-100`) over borders for visual containment

### Layout

- Desktop: fixed sidebar (240px / `w-60`) + scrollable main content
- Mobile: bottom tab bar with safe-area padding
- Breakpoint: `md:` (768px) for sidebar ↔ bottom nav switch
- Page structure: `PageContainer` with title + optional action button, then content

### Component Patterns

- **Buttons**: Primary (`bg-blue-600 text-white`), Secondary (`border border-gray-300 text-gray-700`), Danger (`text-red-600 border-red-300`)
- **Inputs**: `rounded-md border-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500`
- **Cards**: White background, `border border-gray-200 rounded-lg`, no shadow
- **Badge**: Color-coded pill (`rounded-full px-2 py-0.5 text-xs font-medium`)
- **ProgressBar**: Gray track, blue fill, percentage label
- **AppIcon**: 3 sizes (40/56/80px), rounded corners, letter fallback
- **Nav active state**: `bg-blue-50 text-blue-700` (sidebar), `text-blue-600` (mobile)

## Frontend Cleanup Rules

These rules prevent the codebase from becoming messy after merging PRs. Enforce them on every change.

### `transition-colors` Usage Policy

**Problem**: `transition-colors` on static containers (cards, sections, alerts, badges) causes visible color flashing when the page loads in dark mode — the element briefly renders in light colors then transitions to dark.

**Rule**: Only use `transition-colors` on **interactive elements** that change color on user interaction:

- Buttons (hover state)
- Links (hover state)
- Form inputs and selects (focus state)
- Nav items (hover/active state)

**Never use `transition-colors` on**:

- Card containers (`bg-white dark:bg-gray-900 rounded-lg border ...`)
- Section wrappers (`<section>` with background)
- Alert/warning banners (use the `<Alert>` component)
- Badge pills
- ProgressBar tracks
- Modal containers
- AppIcon fallback containers
- Empty state placeholder containers

**Exception**: Layout chrome (Sidebar, MobileNav, MobileHeader, PageContainer) may keep `transition-colors duration-200` for smooth theme toggle animation, since these persist across navigations.

### Shared Icons

All navigation and theme icons live in `components/common/icons.tsx`. When Sidebar, MobileNav, or MobileHeader need icons, import from there. Never duplicate icon SVG components inline.

### Import Ordering Verification

Before merging any frontend PR, verify imports follow the convention in every changed file:

```
1. React / library imports
2. Layout components
3. Common components
4. Sibling components (same feature folder)
5. Hooks / stores
6. Apple protocol / API modules
7. Utilities
8. Config
9. Types (always last)
```

### Empty State Containers

Empty states (shown when a list has no items) use a consistent pattern:

- `border-2 border-dashed` (not solid border)
- `bg-gray-50 dark:bg-gray-900/30` background
- No `transition-colors` (removed to prevent dark mode flashing)
- Centered icon in a white circle, title, description, optional CTA button

### Dark Mode Color Pairings

Always pair light and dark variants consistently:

- **Primary text**: `text-gray-900 dark:text-white`
- **Secondary text**: `text-gray-600 dark:text-gray-400` or `text-gray-500 dark:text-gray-400`
- **Tertiary text**: `text-gray-400 dark:text-gray-500`
- **Card background**: `bg-white dark:bg-gray-900`
- **Page background**: `bg-gray-50 dark:bg-gray-950`
- **Card border**: `border-gray-200 dark:border-gray-800`
- **Input border**: `border-gray-300 dark:border-gray-700`

### Code Duplication Prevention

When the same UI pattern appears in 3+ components, extract it to `components/common/`. Current shared components:

- `Alert`, `Modal`, `Spinner`, `CountrySelect`, `AppIcon`, `Badge`, `ProgressBar`, `icons`

When adding new common components, update this AGENTS.md file accordingly.

### Authenticated API Downloads

**Problem**: Plain `<a href="/api/...">` tags and `window.open("/api/...")` make regular browser navigations that cannot carry custom HTTP headers. When `ACCESS_PASSWORD` is set, the `accessAuth` middleware requires an `X-Access-Token` header, so these requests fail with 401.

**Rule**: Never use `<a href>` or `window.open` for `/api/` endpoints that require authentication. Instead, use `fetch()` with `authHeaders()` from `api/client.ts`, then trigger a download via blob URL:

```tsx
const res = await fetch(url, { headers: authHeaders() });
const blob = await res.blob();
const blobUrl = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = blobUrl;
a.download = filename;
a.click();
URL.revokeObjectURL(blobUrl);
```

**Exceptions**: Routes that the backend explicitly skips auth for (`/auth/*`, `/install/*`) may use plain links — e.g., `itms-services://` install URLs are fine since `/install/*` is public.

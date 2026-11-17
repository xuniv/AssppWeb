# AssppWeb

A web-based tool for acquiring and installing iOS apps outside the App Store. Authenticate with your Apple ID, search for apps, acquire licenses, and install IPAs directly to your device.

![preview](./resources/preview.png)

## Apple account processing

By default, AssppWeb processes Apple account requests on your device. Apple API communication and verified TLS run inside a browser Web Worker through the pinned Go/WebAssembly Store runtime. In this mode, the server acts as a blind TCP relay (Wisp) and cannot read Apple credentials or account traffic.

Authentication uses the modern ipatool ARM64 SAP and Store framework implementation, including Anisette, Store AMD and KBSync. Device processing downloads approximately 53 MB of compressed, pinned public Apple data on its first use. Account and provisioning state are saved in browser IndexedDB.

For Safari devices with limited memory, the login screen offers a single **Process Apple requests on this server** toggle. It is off by default; turning it on explicitly allows this AssppWeb server to process account requests. The choice is saved for later requests, including downloads. **The server operator can access your Apple ID, password, 2FA codes, tokens, cookies and provisioning records for every account used in this mode.** It runs the same pinned engine natively and does not load the browser runtime. Each server process handles one request and exits; account state is returned to the browser rather than saved on the server. Errors never trigger an automatic switch between modes.

Use server mode only on your own server or one whose operator you trust. It requires HTTPS for remote access; local loopback access is permitted. The Docker image includes the worker and verified assets. Operators can disable it with `SERVER_STORE_RUNTIME_ENABLED=false`; its default concurrency is one, with no server queue, an 8 MiB request cap and a five-minute process deadline. Configure your reverse proxy's request timeout accordingly and set `ACCESS_PASSWORD` when access should be restricted.

See [the client runtime](runtime/README.md) for pinned source revisions, public-asset hashes, licenses and rebuild instructions. Native Asspp uses the same interpreter inside the app without a self-hosted server.

> **⚠️ Important Security Notice:** There are no official Asspp Web instances. In device mode, a malicious host could still serve a modified frontend that captures credentials before encryption. In server mode, the operator receives account credentials by design. Self-host or use an operator you trust, and verify the site's HTTPS certificate.

**恳请所有转发项目的博主对自己的受众进行网络安全技术科普。要有哪个不拎清的大头儿子搞出事情来都够我们喝一壶的。**

## Quick Start

This fork follows [Lakr233/AssppWeb](https://github.com/Lakr233/AssppWeb), adds temporary IPA uploads, and publishes its Node 24 images as `ghcr.io/xuniv/assppweb:latest`. To replace an upstream image in an existing deployment, change the image name to this fork and recreate the container.

To test your local working tree with OrbStack or Docker:

```bash
docker compose -f compose.yml -f compose.local.yml up --build -d
```

Open <http://localhost:8080>. The local override builds the source and binds only to your computer's loopback interface.

### Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xuniv/AssppWeb&apiTokenTmpl=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22write%22%7D%2C%7B%22key%22%3A%22containers%22%2C%22type%22%3A%22write%22%7D%2C%7B%22key%22%3A%22cloudchamber%22%2C%22type%22%3A%22write%22%7D%5D&apiTokenName=AssppWeb%20Deploy)

This uses Cloudflare Workers + Containers with the published image `ghcr.io/xuniv/assppweb:latest`.

Requirements:

- Cloudflare Workers **Paid** plan (Containers are not available on Free).
- Deploy/build token with:
  - `Workers Scripts Edit`
  - `Containers Edit`
  - `Cloudchamber Edit`

If your build log fails at `Deploy a container application` with `Unauthorized`, your build token is missing required Containers/Cloudchamber permissions.

### Deploy to Railway

<details>
<summary>Click to show Railway deployment instructions</summary>

1. Go to [railway.com/new/image](https://railway.com/new/image) → enter `ghcr.io/xuniv/assppweb:latest`
2. In service **Settings**, set **Healthcheck Path** to `/api/settings` and deploy
3. Right-click the service → **Attach volume** → mount path: `/data`
4. In **Variables**, set `DATA_DIR` = `/data` and deploy
5. In **Settings** → **Networking**, generate a public domain or add a custom domain

**Notes**

- The free trial works but has limitations (volume expiry, network restrictions). **Hobby** plan ($5/month) or above is recommended for reliable use.
- Enable [**Serverless**](https://docs.railway.com/deployments/serverless) in service settings to scale down to zero during idle periods
- Railway [auto-updates](https://docs.railway.com/deployments/image-auto-updates) `:latest` images from GHCR — new releases will be deployed automatically within a few hours

> **⚠️ Custom domain with Cloudflare:** Railway's Cloudflare integration creates DNS records with Proxy enabled (orange cloud) by default. After authorizing, go to Cloudflare DNS settings and switch the CNAME record to **DNS only** (gray cloud) — Railway handles TLS automatically. If you keep Cloudflare Proxy on, you must set SSL/TLS mode to **Full** (not Flexible or Full Strict), otherwise you'll get an infinite redirect loop. See [Railway docs](https://docs.railway.com/networking/troubleshooting/ssl#err_too_many_redirects).

</details>

### Install an existing IPA

Open **IPA uploads** next to Downloads, choose an `.ipa` from ipatool or another tool, and upload it. No Apple account needs to be added to this page. Once validation finishes, use **Install**, copy the install link, or scan the QR code from your iOS device. **Delete** removes the file and invalidates its link.

- Both XML and binary `Payload/*.app/Info.plist` are supported. The bundle identifier, build version, and title are read from the main app; the IPA itself is served unchanged.
- Installation needs a publicly reachable `PUBLIC_BASE_URL` over HTTPS with a certificate trusted by iOS. The IPA must already have valid signing and any required App Store license. This feature does not resign or decrypt apps.
- Uploads live separately in `DATA_DIR/uploads` and are **all removed at server startup**, including interrupted uploads. They are not added to the regular download history. Regular downloaded packages retain upstream's persistence behavior.
- `AUTO_CLEANUP_DAYS` and `AUTO_CLEANUP_MAX_MB` also govern uploads. Upload cleanup runs hourly and before listing/accepting files; the storage cap applies separately to the upload store and the upstream download cache. Oldest uploads are evicted first.
- `MAX_DOWNLOAD_MB` also limits each upload, with an absolute 8 GiB ceiling. An upload cannot exceed a configured upload storage cap. If a reverse proxy is used, allow the intended request body size and upload duration there as well (for nginx, `client_max_body_size` and `proxy_read_timeout`).
- With `ACCESS_PASSWORD` enabled, listing, uploading, and deleting require the same access token as other APIs. As with upstream installs, the random install URL grants public access to its manifest and payload so iOS can fetch them. Share it only with intended recipients.

### UnfairPlay

Open **UnfairPlay** from an uploaded or downloaded IPA, or open `/unfairplay` to process a local file. Import exported UnfairPlay `.bin` models and explicitly select the models for the IPA's enrollment. Models are kept in a separate browser IndexedDB database and can be exported or deleted there. They are never included in published images.

Device processing runs the pinned portable Go engine in a dedicated WebAssembly worker. IPA data is streamed through private OPFS storage with bounded buffers instead of copying an entire executable into WASM memory. A secure context with OPFS and synchronous worker file access is required. Unsupported browsers stop before transferring private input. Physical iPhone Safari memory limits still require device testing.

The independent **Process on this server** switch explicitly permits sending the selected models and IPA to this server for one operation. It never switches on automatically. Existing server IPAs are referenced directly without downloading and uploading them again. Models stay in process memory; temporary IPA files and outputs are private and removed after response, cancellation, failure or restart. Server processing defaults to one active operation, a ten-minute deadline and a 2 GiB input limit. Reverse proxies must allow the intended body size and duration. `SERVER_UNFAIRPLAY_ENABLED=false` disables this mode.

Supported operations are model inspection, IPA diagnostics, verification, decryption, decryption with account-data stripping, stripping alone, and macOS SINF conversion with v2 models. Mac setup, enrollment collection/recovery and application signing are excluded. Processing creates a new export and leaves the original IPA unchanged. Decrypted IPAs need signing before installation. Account stripping removes known license and purchaser metadata; it does not guarantee complete anonymization. A successful operation with incomplete plaintext hash coverage is reported as such, separately from Apple code-signature trust.

See [the portable engine](runtime/unfairplay/README.md) and [browser verification](runtime/tests/unfairplay-ui.md) for source pins, limits and reproducible checks.

### Self-Host with Docker Compose

<details>
<summary>Click to show manual Docker Compose setup instructions</summary>

**Setup Docker Compose**

```bash
curl -O https://raw.githubusercontent.com/xuniv/AssppWeb/main/compose.yml
docker compose up -d
```

**Environment Variables**

| Variable                                    | Default         | Description                                                                                 |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `PORT`                                      | `8080`          | Server listen port                                                                          |
| `DATA_DIR`                                  | `./data`        | Directory for storing compiled IPAs                                                         |
| `PUBLIC_BASE_URL`                           | _(auto-detect)_ | Public URL for generating install manifests (e.g. `https://asspp.example.com`)              |
| `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT` | `false`         | Disable HTTPS redirect (see warning below)                                                  |
| `AUTO_CLEANUP_DAYS`                         | `0`             | Automatically delete cached IPA files older than specified days (0 to disable)              |
| `AUTO_CLEANUP_MAX_MB`                       | `0`             | Automatically delete oldest cached IPA files when size exceeds this MB limit (0 to disable) |
| `MAX_DOWNLOAD_MB`                           | `0`             | Reject downloads exceeding this size in MB to prevent out-of-memory errors (0 to disable)   |
| `DOWNLOAD_THREADS`                          | `8`             | Number of parallel threads for IPA downloads (1–32)                                         |
| `ACCESS_PASSWORD`                           | _(none)_        | Require a password to access the web UI and API (empty to disable)                          |
| `SERVER_STORE_RUNTIME_ENABLED`              | `true`          | Offer optional server account processing; browsers must explicitly opt in                   |
| `SERVER_STORE_RUNTIME_CONCURRENCY`          | `1`             | Maximum native account processes (1–4); excess requests receive 503                         |
| `SERVER_STORE_RUNTIME_TIMEOUT_MS`           | `300000`        | Native process deadline, bounded to 30–300 seconds                                          |

**Reverse Proxy (Required for Install Apps on iOS)**

iOS requires HTTPS for `itms-services://` install links. You must put AssppWeb behind a reverse proxy with a valid TLS certificate.

> **⚠️ Redirect loop (`ERR_TOO_MANY_REDIRECTS`)?** Some reverse proxies (e.g. NAS built-in proxies) always send `X-Forwarded-Proto: http` even when the client connected via HTTPS, causing an infinite redirect loop. If you cannot configure your proxy to send the correct header, set `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT=true` as a last resort. **This disables the HTTP→HTTPS redirect — you must ensure your proxy enforces HTTPS externally.**

The following is an example Caddyfile configuration:

```
asspp.example.com { reverse_proxy 127.0.0.1:8080 }
```

**⚠️ Make Sure WebSocket Works**

Device processing uses the Wisp protocol over WebSocket (`/wisp/`). Ensure your reverse proxy or CDN (e.g., Nginx, Cloudflare) allows WebSocket connections for this mode. Server processing uses ordinary same-origin HTTPS requests.

</details>

## Security Recommendations

**DDoS Protection**

IPA files can be hundreds of megabytes. If your instance is publicly accessible, put it behind a CDN like Cloudflare to absorb bandwidth and prevent abuse.

## License

MIT License. See [LICENSE](LICENSE) for details.

## 🥰 Acknowledgments

For projects that was stolen and used heavily:

- [ipatool](https://github.com/majd/ipatool)
- [Asspp](https://github.com/Lakr233/Asspp)

For friends who helped with testing and feedback:

- [@lbr77](https://github.com/lbr77)
- [@akinazuki](https://github.com/akinazuki)

<img src="./Artworks/fable5.jpg" alt="Fable 5 Verified" width="240">

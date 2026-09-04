# 🛡️ Secure DoH Proxy


**A privacy-first, multi-upstream DNS-over-HTTPS (DoH) proxy engineered with Next.js 16.**

Secure DoH Proxy provides a stateless, high-performance bridge between your clients and the world's most reliable DNS providers, ensuring your queries remain encrypted and private.

## ✨ Key Features

*   **🚀 Cutting-Edge Stack**: Powered by **Next.js 16** with proactive security patching (CVE-2025-66478).
*   **🌐 Multi-Upstream Support**: Seamlessly switch between Cloudflare, Google, AdGuard, DNS.SB, or your own custom provider.
*   **🧪 Integrated DNS Tester**: A sleek, intuitive UI to benchmark and test DNS resolution across different providers in real-time.
*   **🔒 Privacy by Design**: Zero logging. Purely stateless proxying to ensure no user footprints are left behind.
*   **🎨 Modern Interface**: A clean, responsive design crafted with **Tailwind CSS** and **Lucide Icons**.

---

## 🛡️ Enterprise-Grade Security & Reliability

*Version 1.1 introduces a hardened architecture designed for production environments:*

*   **Strict Caching Policy**: Forces `Cache-Control: no-store` to eliminate the risk of sensitive DNS data being cached by middleboxes or CDNs.
*   **Request Lifecycle Guard**: 
    *   **Upstream Timeout**: 2500ms limit to prevent slow-upstream bottlenecks.
    *   **Global Budget**: 3000ms hard cap to prevent edge function hangs and resource exhaustion.
*   **Hardened Input Validation**: 
    *   RFC-compliant regex and strict length checks for domain validation.
    *   Query string size limits to mitigate Denial-of-Service (DoS) vectors.
*   **Platform Agnostic Architecture**: 
    *   **Normalized Headers**: Standardizes `Accept: application/dns-json` and `User-Agent` for maximum compatibility.
    *   **Smart IP Resolution**: Abstracted client IP detection supporting `x-forwarded-for` and `cf-connecting-ip`.
*   **Operational Excellence**: 
    *   **Observability**: Structured JSON logging for streamlined debugging and error tracking.
    *   **Health Monitoring**: Native `HEAD` method support (returning `204 No Content`) for seamless load balancer integration.

---

## 🚀 Deployment

### Option 1: Vercel (Recommended)
The fastest way to get online.
1. **Fork** this repository to your GitHub account.
2. **Import** the project into the [Vercel Dashboard](https://vercel.com/new).
3. Vercel will automatically detect Next.js and configure the build.
4. *(Optional)* Configure your `CUSTOM_DOH_URL` in the Environment Variables tab.

### Option 2: Docker / Self-Hosted
Deploy on any VPS or container orchestrator.

**Run with Docker:**
The project includes a production-ready `Dockerfile` and a GitHub Actions workflow that publishes images to GHCR.

```bash
docker run -d \
  -p 8367:8367 \
  -e PORT=8367 \
  -e CUSTOM_DOH_URL=https://1.1.1.1/dns-query \
  --name doh-proxy \
  ghcr.io/rating3pro/doh_proxy:latest
```

| Environment Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | The port the application listens on | `8367` |
| `CUSTOM_DOH_URL` | Upstream URL for the 'Custom' provider | `-` |
| `DEBUG_LOG` | Enable verbose JSON logging | `false` |

**Manual Node.js Setup:**
```bash
npm install
npm run build
npm start
```

### Option 3: Other Platforms
Compatible with any environment supporting Next.js 16:
*   **Edge/Serverless**: Cloudflare Pages, AWS Amplify, Google Cloud Run, Azure Static Web Apps, Netlify.
*   **Specialized**: TencentCloud Edgeone, AlibabaCloud ESA.

---

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Required |
| :--- | :--- | :--- |
| `CUSTOM_DOH_URL` | The upstream DoH URL for the 'Custom' provider (e.g., `https://1.1.1.1/dns-query`) | No |
| `DEBUG_LOG` | Set to `true` to enable verbose JSON logging | No |

### Managing Upstream Providers

#### Method 1: Quick Config (No Code)
To use a single custom upstream without modifying the source, set the `CUSTOM_DOH_URL` environment variable:
```bash
CUSTOM_DOH_URL=https://doh.opendns.com/dns-query npm run dev
```
Your endpoint will be: `/api/doh/custom`

#### Method 2: Advanced Config (Source Edit)
To add multiple providers to the Web UI:
1. Open `src/lib/providers.ts`.
2. Locate the `DOH_PROVIDERS` array.
3. Add your provider object:
```typescript
{
  id: 'opendns', // Endpoint: /api/doh/opendns
  name: 'OpenDNS',
  endpoint: 'https://doh.opendns.com/dns-query',
  description: 'OpenDNS Family Shield',
},
```
4. Save and rebuild: `npm run build`.

---

## 🛠️ Usage

### Web Interface
Simply navigate to your deployed URL (e.g., `https://your-domain.com`) to access the visual DNS tester.

### API Endpoints
Configure your clients (browsers, routers, or OS) using the endpoints below. The proxy is **format-agnostic**: it forwards the client's `Accept` header, supporting both the **JSON API** (`application/dns-json`) and **RFC 8484 Wire Format** (`application/dns-message`).

| Provider | Default Endpoint | JSON API | Wire Format (RFC 8484) |
| :--- | :--- | :--- | :--- |
| **Cloudflare** | `/api/doh/cloudflare` | `/api/doh/cloudflare` | `/api/doh/cloudflare/dns-query` |
| **Google** | `/api/doh/google` | `/api/doh/google/resolve` | `/api/doh/google/dns-query` |
| **AdGuard** | `/api/doh/adguard` | `/api/doh/adguard/resolve` | `/api/doh/adguard/dns-query` |
| **DNS.SB** | `/api/doh/dnssb` | `/api/doh/dnssb` | `/api/doh/dnssb/dns-query` |

*   **Custom**: `/api/doh/custom` (Requires `CUSTOM_DOH_URL`)
*   **Manual**: `/api/doh/manual?upstream=<url>` 
    *   *Note: The manual endpoint includes SSRF protection and rejects private/loopback/link-local IP space.*

### Health Check
Perform a `HEAD` request to any endpoint to verify service availability. A `204 No Content` response indicates the service is healthy.

---

## 💻 Development

```bash
# Start local development server
npm run dev

# Test Custom provider locally
CUSTOM_DOH_URL=https://1.1.1.1/dns-query npm run dev
```

## 📜 License
Distributed under the **AGPL-3.0 License**.

---

## 🚀 More from the Author

### 🌐 My Free DNS Server
Access high-quality DNS filtering using **HaGeZi Blocklists Multi Pro + TIF**.

| Filter Set | DNS-over-HTTPS Endpoint |
| :--- | :--- |
| **Multi Pro + TIF** | `https://freedns-six.vercel.app/api/doh/dns-query` (Recommended) |
| **Multi Pro + TIF** | `https://dnssix.netlify.app/api/doh/dns-query` |

### ⚡ Bandwidth Hero Server
A lightweight image optimization proxy that fetches remote images and compresses them on the fly to reduce data usage and speed up page loads.
👉 [Try Bandwidth Hero](https://bhserv.netlify.app/)

---

## ❤️ Supporting the Project
If this tool helped you, consider supporting further development:
**Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

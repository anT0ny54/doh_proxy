# Secure DoH Proxy

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/RATING3PRO/doh_proxy)

A privacy-focused, multi-upstream DNS over HTTPS (DoH) proxy built with **Next.js 16**.

## Features

-  **Secure & Up-to-Date**: Built with the latest Next.js 16 (CVE-2025-66478 Patched).
-  **Multi-Upstream**: Support for Cloudflare, Google, AdGuard, DNS.SB, and Custom upstream.
-  **DNS Tester**: Built-in beautiful UI to test DNS resolution across different providers.
-  **Privacy First**: No logs, stateless proxying.
-  **Modern UI**: Built with Tailwind CSS and Lucide Icons.

###  Enterprise-Grade Security & Reliability (New in v1.1)

- **Strict Caching Policy**: Enforces `Cache-Control: no-store` to prevent middlebox/CDN caching of sensitive DNS data.
- **Request Lifecycle Management**: 
  - 2500ms upstream timeout protection.
  - 3000ms global budget to prevent edge function hangs.
- **Enhanced Input Validation**: 
  - Strict domain validation (RFC-compliant regex, length checks).
  - Query string size limits to prevent DoS.
- **Platform Agnostic**: 
  - Normalized Headers (`Accept: application/dns-json`, `User-Agent`).
  - Abstracted Client IP resolution (supports `x-forwarded-for`, `cf-connecting-ip`).
- **Observability**: Structured JSON logging for errors and debug mode.
- **Health Checks**: Native `HEAD` method support (returns 204) for load balancers.

## Deployment

### Option 1: Vercel (Recommended)

The easiest way to deploy this Next.js app is to use the [Vercel Platform](https://vercel.com/new).

1. Fork this repository to your own GitHub account.
2. Import the project into Vercel.
3. Vercel will automatically detect Next.js and configure the build settings.
4. (Optional) Add environment variables like `CUSTOM_DOH_URL` in the Vercel dashboard.

### Option 2: Docker / Self-Hosted

You can deploy this on any server that supports Docker or Node.js.

**Run with Docker (Recommended):**

This project includes a production-ready `Dockerfile` and automated GitHub Actions workflow that publishes images to GitHub Container Registry (GHCR).

```bash
docker run -d \
  -p 8367:8367 \
  -e PORT=8367 \
  -e CUSTOM_DOH_URL=https://1.1.1.1/dns-query \
  --name doh-proxy \
  ghcr.io/rating3pro/doh_proxy:latest
```

| Environment Variable | Description | Default |
| -------------------- | ----------- | ------- |
| `PORT`               | The port the application listens on. | `8367` |
| `CUSTOM_DOH_URL`     | Upstream URL for 'Custom' provider. | - |
| `DEBUG_LOG`          | Enable verbose logging. | `false` |

**Build & Run with Node.js:**

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Start the production server
npm start
```

### Option 3: Other Platforms

Since this is a standard Next.js 16 application, it can be deployed on various platforms:
- Cloudflare Pages
- AWS Amplify
- Google Cloud Run
- Azure Static Web Apps
- Netlify
- TencentCloud Edgeone Functions
- AlibabaCloud ESA Function

## Configuration

### Environment Variables

| Variable Name | Description | Required |
| ------------- | ----------- | -------- |
| `CUSTOM_DOH_URL` | The upstream DoH URL for the 'Custom' provider (e.g., `https://1.1.1.1/dns-query`) | No (Only for Custom provider) |
| `DEBUG_LOG` | Set to `true` to enable verbose JSON logging for all requests. | No |

### How to Change or Add Upstream Providers

You can manage your upstream DoH providers using two different approaches depending on your needs:

#### Method 1: Using the `CUSTOM_DOH_URL` Environment Variable (No code changes required)
If you only need to use a single custom upstream without modifying the code, you can use the built-in `custom` endpoint.
Simply set the `CUSTOM_DOH_URL` environment variable when deploying or running the app:
```bash
CUSTOM_DOH_URL=https://doh.opendns.com/dns-query npm run dev
```
Then point your clients to: `/api/doh/custom`

#### Method 2: Editing the Built-in Providers List
If you want to add multiple providers or change the default list shown in the Web UI, you need to modify the source code.
1. Open the file `src/lib/providers.ts`.
2. Locate the `DOH_PROVIDERS` array.
3. Add a new provider object or modify existing ones. For example, to add OpenDNS:
```typescript
  {
    id: 'opendns', // This will be your endpoint path: /api/doh/opendns
    name: 'OpenDNS',
    endpoint: 'https://doh.opendns.com/dns-query',
    description: 'OpenDNS Family Shield',
  },
```
4. Save the file and rebuild the project (`npm run build`). The new provider will automatically appear in the Web UI and be available as an API endpoint.

## Usage

### Web Interface
Visit your deployed URL (e.g., `https://your-domain.com`) to use the visual DNS tester.

### API Endpoints
Configure your DoH client (browser, router, or OS) with the following endpoints.

Each built-in provider exposes its default endpoint plus optional
format-specific sub-paths. The proxy is format-agnostic: it forwards the
client's `Accept` header, so both the JSON API (`application/dns-json`) and
the RFC 8484 wire format (`application/dns-message`, GET `?dns=` and POST)
work transparently.

| Provider | Default | JSON | Wire format (RFC 8484) |
| -------- | ------- | ---- | ---------------------- |
| **Cloudflare** | `/api/doh/cloudflare` | `/api/doh/cloudflare` | `/api/doh/cloudflare/dns-query` |
| **Google** | `/api/doh/google` | `/api/doh/google/resolve` | `/api/doh/google/dns-query` |
| **AdGuard** | `/api/doh/adguard` | `/api/doh/adguard/resolve` | `/api/doh/adguard/dns-query` |
| **DNS.SB** | `/api/doh/dnssb` | `/api/doh/dnssb` | `/api/doh/dnssb/dns-query` |

- **Custom**: `/api/doh/custom` (Requires `CUSTOM_DOH_URL`)
- **Manual**: `/api/doh/manual?upstream=<url>`

> The `manual` endpoint accepts only `http(s)` URLs and rejects upstreams that
> resolve to private, loopback or link-local address space (SSRF protection).

### Health Check
Send a `HEAD` request to any endpoint to verify service availability (returns 204 No Content).

## Development

```bash
# Start local development server
npm run dev

# Test Custom provider locally
CUSTOM_DOH_URL=https://1.1.1.1/dns-query npm run dev
```

## License

AGPL-3.0


#### :department_store: **My Free DNS Server, free** <a name="dns server"></a>

On [My Free DNS] you can use HaGeZi Blocklists Multi Pro + TIF.

| Hagezi Blocklists | DNS-over-HTTPS |
|:---------------|:---------------|
| Multi Pro + TIF | `https://freedns-six.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |


# ⚡ Bandwidth Hero Server

> A lightweight image optimization proxy designed to reduce bandwidth usage and speed up web browsing.

Bandwidth Hero Server fetches remote images, compresses them, and delivers optimized versions to the client. It helps reduce data consumption while improving loading performance.

🖥️ If you want, you can see this [Bandwidth Hero](https://bhserv.netlify.app/)


## Supporting My Project

If you are interested in supporting the project you can donate :
 - Bitcoin: 1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP
   

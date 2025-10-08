# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Mineflare is a Cloudflare-based Minecraft server hosting platform that uses Cloudflare Workers, Containers (Durable Objects), and R2 storage to run a containerized Minecraft server with real-time monitoring, authentication, and plugin management.

## Commands

### Development
- `bun run dev` - Start development environment with Alchemy and rebuild HTTP proxy. Starts local Vite dev server for frontend at http://localhost:5173
- `bun run dev:spa` - Start Vite dev server only (frontend)
- `bun run build` or `bun run build:worker` - Compile TypeScript worker code

### Deployment
- `bun run deploy` - Deploy to Cloudflare (requires .env file with credentials)
- `bun run destroy` - Destroy deployed resources on Cloudflare

### Configuration
- `bun run configure` - Configure Alchemy settings
- `bun run login` - Login to Alchemy
- `bun run version` - Show Alchemy version

### Container
- `./container_src/build-container-services.sh` - Build the HTTP proxy binary and File server binary for the container (automatically run by dev script)

## Architecture

### Core Components

**Cloudflare Workers + Containers Architecture**
- Main worker (`src/worker.ts`) - Elysia-based API server handling HTTP requests, authentication, and routing
- Durable Object container (`src/container.ts`) - MinecraftContainer class extends Container, manages Minecraft server lifecycle
- Container image (`container_src/`) - Custom Docker image running Paper Minecraft server with plugins and services
- Dynmap worker (`src/dynmap-worker.ts`) - Separate worker for serving Dynmap tiles from R2 bucket

**Request Flow**
1. User requests hit main worker
2. Authentication middleware validates session cookies (except for auth endpoints and WebSocket upgrades)
3. Worker routes API requests to MinecraftContainer Durable Object via RPC
4. Container communicates with Minecraft server via RCON (port 25575) and HTTP proxy (ports 8082-8109)
5. Frontend is a Preact SPA with real-time updates via WebSocket

**Key Infrastructure**
- Alchemy deployment tool - Infrastructure as Code for Cloudflare resources
- RCON protocol - Remote console for Minecraft server commands
- HTTP Proxy - Custom TCP-to-HTTP proxy for proxying R2 requests (S3-compatible) from container
- R2 Bucket - Object storage for Dynmap tiles with public access and lifecycle rules
- Durable Object SQL - Persistent storage for plugin state, auth credentials, and symmetric keys

### Directory Structure

```
src/
├── worker.ts              # Main Elysia worker (API endpoints)
├── container.ts           # MinecraftContainer Durable Object (server lifecycle, RCON, HTTP proxy)
├── dynmap-worker.ts       # Dynmap tile server worker
├── server/
│   ├── auth.ts           # Authentication logic (cookie-based, encrypted tokens)
│   └── get-minecraft-container.ts  # Container stub helper
├── client/               # Preact SPA frontend
│   ├── App.tsx          # Main app component
│   ├── components/      # UI components (ServerStatus, Terminal, Plugins, etc.)
│   ├── hooks/           # React hooks (useAuth, useServerData)
│   └── utils/           # Utilities (API client)
└── lib/
    ├── rcon.ts          # RCON protocol implementation
    └── rcon-schema.ts   # Zod schemas for RCON responses

container_src/
├── Dockerfile           # Multi-stage build: http-proxy + itzg/minecraft-server
├── http-proxy.ts        # TypeScript source for HTTP proxy (Bun-based)
├── http-proxy           # Compiled binary (built by build-container-services.sh)
├── build-container-services.sh       # Build script for http-proxy binary
├── start-with-services.sh  # Container entrypoint (starts proxy, Minecraft, plugins)
└── *.jar                # Plugin files (Dynmap, playit.gg)

alchemy.run.ts           # Alchemy infrastructure config (workers, containers, R2)
```

### Authentication System

**Cookie-Based Auth with Encrypted Tokens**
- First-time setup: POST `/api/auth/setup` creates password hash (PBKDF2) and symmetric key (AES-GCM)
- Login: POST `/api/auth/login` verifies password and returns encrypted session cookie (7-day expiry)
- Auth data stored in Durable Object SQL (salt, password_hash, sym_key)
- Middleware `requireAuth()` validates cookie on every request
- WebSocket tokens: Short-lived (20 min) tokens generated via `/api/auth/ws-token` for terminal connections
- Cache layer: Worker cache stores passwordSet status and symmetric key to avoid DO wakeup on every request

**Important Auth Notes**
- Passwords must be at least 8 characters
- Setup endpoint is idempotent (returns 409 if password already set)
- Cookie name: `mf_auth`, HttpOnly, Secure, SameSite=Lax
- Development mode enables CORS for localhost origins

### Plugin System

**Plugin Management**
- Plugins defined in `PLUGIN_SPECS` array in `src/container.ts`
- Each plugin has: `filename`, `displayName`, `requiredEnv`, `getStatus()` function
- Plugin state stored in Durable Object SQL (`json_data.optionalPlugins` array)
- Plugin environment variables stored in SQL (`json_data.pluginEnv` object)
- Plugins are enabled/disabled via `/api/plugins/:filename` POST endpoint
- Dynmap plugin is always enabled and cannot be disabled
- Plugin changes require server restart to take effect (container rebuilds envVars on start)

**Plugin States**
- `ENABLED` - Currently running
- `DISABLED` - Not running, will remain disabled after restart
- `ENABLED_WILL_DISABLE_AFTER_RESTART` - Currently running, will be disabled on next restart
- `DISABLED_WILL_ENABLE_AFTER_RESTART` - Not running, will be enabled on next restart

**Adding New Plugins**
1. Add plugin spec to `PLUGIN_SPECS` in `src/container.ts`
2. Add plugin JAR file to `container_src/`
3. Update `container_src/start-with-services.sh` to handle plugin initialization if needed
4. Define required environment variables in plugin spec
5. Implement `getStatus()` function to show plugin status messages

### HTTP Proxy System

**Purpose**: Proxies HTTP requests from inside the container to external R2 bucket (S3-compatible API)

**Architecture**
- Control channel (port 8084): JSON messages for channel allocation/release
- Data channels (ports 8085-8109): HTTP request/response proxying with keep-alive support
- Implemented in TypeScript (container_src/http-proxy.ts), compiled to standalone binary with Bun
- Durable Object manages TCP connections to control/data channels
- Handles chunked encoding, content-length, conditional requests (If-Match, If-None-Match)

**Message Flow**
1. http-proxy.ts requests channel allocation via control channel
2. Durable Object opens TCP connection to requested data channel port
3. http-proxy.ts sends HTTP request over data channel
4. Durable Object parses request, calls `fetchFromR2()`, sends response back
5. Data channel remains open for keep-alive (multiple requests)
6. http-proxy.ts releases channel when done

**Important**: Control channel runs infinite retry loop to maintain connection. Data channels are allocated on-demand.

### RCON System

**Purpose**: Remote console protocol for Minecraft server commands

**Implementation**
- TCP connection to port 25575 inside container
- Password: "minecraft" (hardcoded, safe on private network)
- Commands: `list`, `version`, parsing responses for player count, server info
- Auto-reconnect on connection loss (10 second timeout between checks)
- Exposed via container RPC methods: `getRconStatus()`, `getRconPlayers()`, `getRconInfo()`

### Container Lifecycle

**Start Sequence**
1. Worker calls `container.start()` (via `/api/status` endpoint)
2. Container starts Docker image, waits for ports (up to 5 minutes)
3. Container initializes RCON connection
4. Container starts HTTP proxy infinite retry loop
5. Minecraft server loads, RCON becomes available
6. Frontend polls `/api/status` every 5 seconds for updates

**Stop Sequence**
1. Worker calls `container.stop()` (via `/api/shutdown` endpoint)
2. Container sends SIGTERM to Docker container
3. Minecraft server shuts down gracefully
4. RCON and HTTP proxy connections close
5. Container enters 'stopped' state

**Sleep Policy**
- Container sleeps after 20 minutes of inactivity (configurable via `sleepAfter`)
- Only `/api/status` endpoint wakes container
- All other endpoints return offline/error when container is sleeping

### R2 Bucket Integration

**Dynmap Storage**
- Dynmap plugin writes map tiles to `/data/plugins/dynmap/web/tiles/` inside container
- Tiles are synced to R2 bucket via S3-compatible API (through HTTP proxy)
- R2 bucket has public access enabled for direct tile serving
- Lifecycle rule: Delete tiles older than 12 hours to save storage

**S3-Compatible API**
- Endpoint: `https://{account_id}.r2.cloudflarestorage.com`
- Credentials: Generated via AccountApiToken in alchemy.run.ts
- Operations: GET, PUT, DELETE, LIST (HEAD for metadata)
- Container uses fake AWS credentials (real auth happens in Durable Object)

### Frontend (Preact SPA)

**Technology Stack**
- Preact 10 with signals for state management
- Vite for development/bundling
- Inline styles (no CSS framework)
- Real-time updates via polling and WebSocket

**Key Features**
- Server status dashboard with stats (online, player count, max players, plugins)
- Terminal component with WebSocket connection to RCON
- Plugin management UI (enable/disable, view status messages, configure env vars)
- Minimap component with iframe to Dynmap worker
- Authentication overlay (login/setup)

**API Client**
- Located in `src/client/utils/api.ts`
- Handles auth cookies automatically
- Polling interval: 5 seconds for status updates
- WebSocket reconnect logic with exponential backoff

## Important Development Notes

### Alchemy Framework
- Infrastructure as Code tool for Cloudflare resources
- Configuration in `alchemy.run.ts`
- Resources defined using typed constructors (Worker, Container, R2Bucket, etc.)
- Resources have `adopt: true` flag to manage existing resources
- `await app.finalize()` required at end of config

### Container Development
- Container changes require rebuilding Docker image
- HTTP proxy must be rebuilt when http-proxy.ts changes: `./container_src/build-container-services.sh`
- Dev mode: `bun run dev` rebuilds proxy and starts Alchemy dev server
- Container logs available at `/api/logs` endpoint (only when container is running)

### Environment Variables
- `TS_AUTHKEY` - Tailscale authentication key (optional, enables VPN)
- `NODE_ENV` - "development" or "production"
- `CLOUDFLARE_ACCOUNT_ID` - Required for R2 endpoint URL
- `ALCHEMY_PASSWORD` - Optional password for Alchemy state store
- Container receives env vars via `MinecraftContainer.envVars` object
- Plugin env vars are injected at container start time (not configurable at runtime)

### SQL Storage Patterns
- Durable Object SQL stores JSON documents in `state.json_data` blob column
- Use `jsonb()` and `jsonb_patch()` for atomic JSON updates
- Plugin state: `$.optionalPlugins` (array of filenames)
- Plugin env: `$.pluginEnv.{filename}` (object of key-value pairs)
- Auth data stored in separate `auth` table with salt, password_hash, sym_key

### Common Pitfalls
- Container must be running for most API endpoints to work (except `/api/getState`, `/api/plugins`)
- WebSocket endpoint requires special token from `/api/auth/ws-token`
- Plugin env changes require server to be stopped
- HTTP proxy connection failures are normal during container startup (retries automatically)
- RCON connection is lazy-initialized on first use (may fail if server not ready)
- Frontend dev server (Vite) uses CORS for API requests to deployed worker

### Testing and Debugging
- Check container logs: `curl https://{worker-url}/api/logs`
- Check container state: `curl https://{worker-url}/api/getState`
- Test RCON: `curl https://{worker-url}/api/info` (requires server running)
- View Dynmap: Navigate to Dynmap worker URL (shown in deploy output)
- Terminal WebSocket: Connect to `wss://{worker-url}/ws?token={ws-token}`

## Code Style and Conventions

- TypeScript strict mode enabled
- Elysia for API routing (not Hono)
- Preact with inline styles (no CSS modules)
- Error handling: Return JSON with `{ error: "message" }` and appropriate status code
- Logging: Use `console.error()` for all logs (goes to Cloudflare Workers logs)
- Async/await preferred over promises
- RPC methods on Durable Object should be async for easier consumption

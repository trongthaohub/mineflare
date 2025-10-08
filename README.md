

# Mineflare ⛏️☁️

Click this button to deploy to your cloudflare account right now:

[![Deploy to Cloudflare](https://github.com/user-attachments/assets/9d6358a5-2b85-4974-9adb-bd157c311b1f)](https://deploy.workers.cloudflare.com/?url=https://github.com/eastlondoner/mineflare)

Run a full Minecraft Java server on the edge with real-time monitoring, authentication, and plugin management powered by Cloudflare Workers and Containers.

<img width="2052" height="2110" alt="image" src="https://github.com/user-attachments/assets/e02f9313-fe90-4c43-adb8-cec7dbb8b14c" />

🎮 You get a single Cloudflare `standard-4` container with 4 vCPUs, 12 GiB of memory and 20 GB of storage, enough to comfortably accomodate 20 players.
💵 This costs approximately 50 cents per hour to run on Cloudflare. The server automatically shuts down after 20 minutes of inactivity to save costs, your maps and plugin configurations are saved to R2 storage and restored when you start the server again.

⚠️ I am not responsible for any costs associated with running this server! Leaving a Container running 24/7 can cost you $100s per month 💸

## 🚀 Quick Start

Click on the Deploy to Cloudflare button above to deploy to Cloudflare.
The Cloudflare free tier is not supported for Containers so you have an account on the $5/month Cloudflare paid plan (or higher) to deploy.

<img width="1706" height="1011" alt="image" src="https://github.com/user-attachments/assets/fccc7b6c-b690-46af-a05d-b201bef459f4" />

### First-Time Setup

1. Navigate to your deployed worker URL
2. Click "Set Password" to secure your Server with a password
3. Login with your credentials
4. Click "Start Server" to launch the Minecraft container
5. While you're waiting for the server to start up head over to https://playit.gg/ and sign up for a free account. DO NOT create an agent or a tunnel in playit.gg, this will be done automatically for you in step 6.
6. Wait 2-3 minutes for the server to fully initialize
7. Follow the playit.gg server address shown in the plugin panel to connect to your server via playit.gg
8. Use your playit.gg server address `<some-name>.gl.joinmc.link` to connect to your Cloudflare Minecraft server
<img width="795" height="490" alt="image" src="https://github.com/user-attachments/assets/303c4a07-8411-4487-acce-9ee23dfef526" />

<img width="850" height="475" alt="image" src="https://github.com/user-attachments/assets/2af59c0c-c5e0-485f-b8ba-1af472dd9094" />


## ✨ Features

- **🚀 Serverless Infrastructure** - Built on Cloudflare Workers, Containers, Durable Objects and R2
- **🎮 Full Minecraft Server** - Paper server with plugin support
- **🗺️ Live Mini-Map** - Integrated web Mini-Map on R2 storage
- **🔐 Authentication** - Secure cookie-based auth with encrypted tokens
- **💻 Web Terminal** - Real-time Minecrat control console via WebSocket
- **🔌 Plugin Management** - Enable/disable plugins through web UI
- **💤 Auto-Sleep** - Containers sleep after 20 minutes of inactivity to save resources
- **📊 Real-time Monitoring** - Server status, player list, and performance metrics

<img width="1200" height="630" alt="image" src="https://github.com/user-attachments/assets/3527300e-a3a8-43af-947b-a10e3a5962a0" />

## 🏗️ Architecture

**Core Components:**
- **Main Worker** (`src/worker.ts`) - Elysia API server
- **Frontend** - Preact SPA with Eden Treaty client using polling for real-time updates
- **MinecraftContainer** (`src/container.ts`) - Durable Object managing server lifecycle & security
- **HTTP Proxy** - Custom TCP-to-HTTP bridge in Bun binary allows container to securely connect to R2 via bindings (no R2 tokens needed)
- **Dynmap Worker** - Separate worker serving Mini-Map

## Alternative Networking Options

If you do not want to use playit.gg, you can use Tailscale or Cloudflare Tunnels for super secure private networking but it's harder to share with friends.

### Using Tailscale for super secure private networking

These instructions are only if you do not want to use playit.gg and want to use Tailscale for private networking instead.

1. Disable the playit.gg plugin in the plugin panel
2. Generate a Tailscale authentication key in your Tailscale account settings
3. Create a TS_AUTHKEY *build* secret in your mineflare worker on Cloudflare and re-deploy your worker
4. Look in your tailscale dashboard for a new node called "cloudchamber", grab the private IP address
5. Create a new server in Minecraft using the address `<tailscale private ip>:8081` and connect to your Cloudflare Minecraft server

### Using Cloudflare Tunnels for super secure private networking

Instructions coming soon....


## Local Development

### Prerequisites for local development

- [Bun](https://bun.sh) javascript runtime
- Cloudflare account with Workers and R2 enabled

### Development

```bash
# Install dependencies
bun install

# Start local development environment
bun run dev
```

### Deployment from local checkout

```bash
# Configure alchemy
bun run configure

# Login to Alchemy
bun run login

# Deploy to Cloudflare
bun run deploy
```

After deployment, you'll receive URLs for:
- Main worker (API and frontend)
- Dynmap worker (map tiles)

## 🔧 Configuration

### Environment Variables

Required environment variables (set in `.env` file):

```env
# Cloudflare credentials (from Alchemy login)
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token

# Optional: Tailscale for private networking
TS_AUTHKEY=your_tailscale_key

# Optional: Alchemy password for state encryption
ALCHEMY_PASSWORD=your_secure_password
```

### Container Settings

Edit `src/container.ts` to customize:
- `sleepAfter` - Auto-sleep timeout (default: 20 minutes)
- `maxPlayers` - Maximum concurrent players
- `serverVersion` - Minecraft server version
- Plugin configurations

## 🔌 Plugin System

Mineflare supports optional Minecraft plugins that can be enabled/disabled via the web UI:

**Built-in Plugins:**
- **Dynmap** - Always enabled, provides live web-based map
- **playit.gg** - Optional tunnel service for external access

**Adding Custom Plugins:**

Instructions coming soon....

## 🛠️ Development Commands

```bash
# Build worker code
bun run build

# Build container services including HTTP proxy binary and File server binary
./container_src/build-container-services.sh

# Destroy deployed resources
bun run destroy

# Show Alchemy version
bun run version
```

## 📚 Documentation

- [CLAUDE.md](CLAUDE.md) - AI generated technical documentation

## 📄 License

MIT License - see LICENSE file for details

## 🙏 Acknowledgments

- [Cloudflare Workers](https://workers.cloudflare.com) - Serverless platform
- [Alchemy](https://alchemy.run) - Infrastructure as Code tool
- [itzg/minecraft-server](https://github.com/itzg/docker-minecraft-server) - Docker Minecraft server
- [Dynmap](https://github.com/webbukkit/dynmap) - Live mapping plugin
- [Paper](https://papermc.io) - High-performance Minecraft server
- [Bun](https://bun.sh) - JavaScript runtime

## ⚠️ Important Notes

- Container costs can be significant including CPU, memory, storage and network egress costs. These will apply based on usage (check Cloudflare pricing, leaving a cloudflare container running 24/7 can cost you $100s per month)
- R2 storage has minimal costs (generous free tier)
- Workers have generous free tier (100k requests/day)

## 📞 Support

For issues and feature requests, please use the [GitHub issue tracker](https://github.com/eastlondoner/mineflare/issues).

---

Made with ☁️ by [eastlondoner](https://github.com/eastlondoner)


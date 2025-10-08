import { Container, ContainerOptions } from "@cloudflare/containers";
import { worker } from "../alchemy.run";
import { DurableObject } from 'cloudflare:workers';
import type { Response as CloudflareResponse } from '@cloudflare/workers-types'
import { Rcon } from "./lib/rcon";
import { array, string } from "zod";


interface CloudflareTCPSocket {
  get readable(): ReadableStream;
  get writable(): WritableStream;
  get closed(): Promise<void>;
  get opened(): Promise<SocketInfo>;
  get upgraded(): boolean;
  get secureTransport(): "on" | "off" | "starttls";
  close(): Promise<void>;
  startTls(options?: TlsOptions): Socket;
}

const StringArraySchema = array(string());
const DYNMAP_PLUGIN_FILENAME = 'Dynmap-3.7-beta-11-spigot';

// Plugin status types
type PluginStatus = 
  | { type: "no message" }
  | { type: "information"; message: string }
  | { type: "warning"; message: string }
  | { type: "alert"; message: string };

// Plugin specifications with required environment variables
const PLUGIN_SPECS = [
  {
    filename: 'Dynmap-3.7-beta-11-spigot',
    displayName: 'DynMap',
    requiredEnv: [] as Array<{ name: string; description: string }>,
    getStatus: async (container: MinecraftContainer): Promise<PluginStatus> => {
      const status = await container.getStatus();
      // we can't talk to the container if it's not running
      if(status !== 'running') {
        return { type: "no message" };
      }
      return { type: "information", message: "Map rendering is active" };
    },
  },
  {
    filename: 'playit-minecraft-plugin',
    displayName: 'playit.gg',
    requiredEnv: [] as Array<{ name: string; description: string }>,
    getStatus: async (container: MinecraftContainer): Promise<PluginStatus> => {

      const status = await container.getStatus();
      // we can't talk to the container if it's not running
      if(status !== 'running') {
        return { type: "no message" };
      }
      
      // need to read in the playit.gg config file
      let config = null;
      try{
        config = await container.getFileContents("/data/plugins/playit-gg/config.yml");
      } catch (error) {
        console.log("playit.gg config not found. Usually that means we're just starting up for the first time");
        return { type: "information", message: "connecting..." };
      }
      // find the line starting with agent-secret:
      const agentSecretLine = config?.split("\n").find(line => line.startsWith("agent-secret:"));
      // extract the following text and trim the whitespace and any single or double quotes
      const agentSecret = agentSecretLine?.split("agent-secret:")[1].trim().replace(/['"]/g, '');
      if(agentSecret) {
        // now we look for logs with the tunnel url
        // [13:59:07 INFO]: [gg.playit.minecraft.PlayitKeysSetup] found minecraft java tunnel: internet-mary.gl.joinmc.link
        // 2025-10-06 15:59:07 [13:59:07 INFO]: [gg.playit.minecraft.PlayitManager] keys and tunnel setup
        // 2025-10-06 15:59:07 [13:59:07 INFO]: playit.gg: tunnel setup
        // 2025-10-06 15:59:07 [13:59:07 INFO]: playit.gg: internet-mary.gl.joinmc.link
        // check for either found minecraft java tunnel: <hostname> or playit.gg: <hostname> - we have to be strict about matching the hostname no spaces and it must fill the line
        const logs = await container.getLogs();
        // Match hostnames that contain at least one dot (e.g., "foo.bar")
        const regex = /found minecraft java tunnel: ([^\s]*\.[^\s]+)$|^playit\.gg: ([^\s]*\.[^\s]+)$/gim;
        const matches = [...logs.matchAll(regex)];
        if(matches && matches.length > 0) {
          const lastMatch = matches[matches.length - 1];
          const hostname = lastMatch[1] || lastMatch[2];
          return { type: "information", message: `Use ${hostname} as the server address to connect to your server via playit.gg` };
        }
        return { type: "information", message: `playit.gg secret is configured but no tunnel is connected. If playit.gg does not conncet in 5 minutes then check your playit.gg configuration for key starting ${agentSecret.slice(0, 8)}` };
      }

      // need to check if we find any matching url https://playit.gg/mc/<code>" using regex
      const logs = await container.getLogs();
      const regex = /https:\/\/playit\.gg\/mc\/([a-f0-9]+)/gi;
      const matches = [...logs.matchAll(regex)];
      // get last match if any exist
      if(matches && matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        const code = lastMatch[1];
        return { type: "warning", message: "not connected go to https://playit.gg/mc/" + code + " to connect" };
      } else {
        return { type: "warning", message: "playit.gg is in an unknown state" };
      }
    },
  },
] as const;

export class MinecraftContainer extends Container<typeof worker.Env> {

    private lastRconSuccess: Date | null = null;
    private _isPasswordSet: boolean = false;
    // Port the container listens on (default: 8080)
    defaultPort = 8081;
    // Time before container sleeps due to inactivity (default: 30s)
    sleepAfter = "20m";
    
    // Environment variables passed to the container
    envVars = {
        TS_EXTRA_ARGS: "--advertise-exit-node",
        TS_ENABLE_HEALTH_CHECK: "true",
        TS_LOCAL_ADDR_PORT: "0.0.0.0:8080",
        ...(this.env.TS_AUTHKEY && this.env.TS_AUTHKEY !== "null" ? {TS_AUTHKEY: this.env.TS_AUTHKEY} : {}),
        // Minecraft server configuration
        TYPE: "PAPER",
        EULA: "TRUE",
        SERVER_HOST: "0.0.0.0",
        ONLINE_MODE: "false",
        ENABLE_RCON: "true",
        // Hardcoded password is safe since we're running on a private tailnet
        RCON_PASSWORD: "minecraft",
        RCON_PORT: "25575",
        INIT_MEMORY: "5G", // big containers
        MAX_MEMORY: "11G", // big containers
        // R2 credentials for Dynmap S3 storage and backups
        // AWS_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
        // AWS_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
        // Random but properly formatted (not validated by our worker proxy)
        AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE1234",
        AWS_SECRET_ACCESS_KEY: "RaNd0mFaKeS3cr3tK3yTh4t1s40Ch4r4ct3rsL0ng",
        // Worker URL for R2 proxy (used by Dynmap and backup system)
        // Uses S3 path-style URLs: https://endpoint/bucket-name/key-name
        AWS_ENDPOINT_URL: "http://localhost:3128",
        DYNMAP_BUCKET: this.env.DYNMAP_BUCKET_NAME,
        // Bucket for world data backups (uses same bucket as Dynmap by default)
        DATA_BUCKET_NAME: this.env.DATA_BUCKET_NAME || this.env.DYNMAP_BUCKET_NAME,
        OPTIONAL_PLUGINS: this.pluginFilenamesToEnable.join(" "), // space separated for consumption by bash script start-with-services.sh
    };
    
  
    enableInternet = true;
    private _container: DurableObject['ctx']['container'];
    private _sqlInitialized = false;
    private _initializeSql() {
      if(!this._sqlInitialized) {
        this._sqlInitialized = true;
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS state (
            id    INTEGER PRIMARY KEY,
            json_data BLOB
          );
          INSERT OR IGNORE INTO state (id, json_data) VALUES (1, jsonb('{"optionalPlugins": ["playit-minecraft-plugin"]}'));
          CREATE TABLE IF NOT EXISTS auth (
            id INTEGER PRIMARY KEY,
            salt TEXT,
            password_hash TEXT,
            sym_key TEXT,
            created_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS container_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            stopped_at INTEGER,
            duration_ms INTEGER
          );
        `);
      }
      return this.ctx.storage.sql;
    }
    private get _sql() {
      return this._initializeSql();
    }

    constructor(ctx: DurableObject['ctx'], env: Env, options?: ContainerOptions) {
        super(ctx, env);
        console.error("constructor");
        if (ctx.container === undefined) {
          throw new Error(
            'Containers have not been enabled for this Durable Object class. Have you correctly setup your Wrangler config? More info: https://developers.cloudflare.com/containers/get-started/#configuration'
          );
        }
        this._container = ctx.container;
        // Initialize SQL immediately so we can synchronously determine password status
        this._initializeSql();
        try {
          const result = this._sql.exec("SELECT 1 as ok FROM auth LIMIT 1;").one();
          this._isPasswordSet = result?.ok === 1;
        } catch (_) {
          this._isPasswordSet = false;
        }
        this.ctx.waitUntil(this.getStatus().then(async status => {
          if(status !== 'stopped' && status !== 'stopping') {
            console.error("Container is not stopped or stopping, initializing HTTP Proxy in constructor");
            try {
              // In dev sometimes state lies
              await this.start();
              await this.initHTTPProxy();
            } catch (error) {
              this.stop()
              console.error("Failed to start container in constructor:", error);
            }
          }
        }));
    }

    // Public async method for RPC
    public async isPasswordSet(): Promise<boolean> {
      return this._isPasswordSet;
    }

    private _pluginFilenamesToEnable: string[] | null = null;
    private get pluginFilenamesToEnable(): string[] {
      if(this._pluginFilenamesToEnable) {
        return this._pluginFilenamesToEnable;
      }
      // magic synchronous sql query
      try {
        const result = this._sql.exec("SELECT json(COALESCE(jsonb_extract(json_data, '$.optionalPlugins'), jsonb('[]'))) as optionalPlugins FROM state WHERE id = 1;").one();
        if(!result) {
          throw new Error("No result from sql query");
        }
        const parsed = StringArraySchema.parse(JSON.parse(result.optionalPlugins as string));
        // Always enable Dynmap
        if(!parsed.includes(DYNMAP_PLUGIN_FILENAME)) {
          parsed.unshift(DYNMAP_PLUGIN_FILENAME);
        }
        this._pluginFilenamesToEnable = parsed;
        return parsed;
      } catch (error) {
        console.error("Failed to get optional plugins:", error);
        return [];
      }
    }

    private set pluginFilenamesToEnable(plugins: string[]) {
      this._pluginFilenamesToEnable = plugins;
      const result = this._sql.exec(`
        UPDATE state 
        SET json_data = jsonb_patch(json_data, jsonb(?))
        WHERE id = 1
      `, JSON.stringify({ optionalPlugins: this.pluginFilenamesToEnable })).rowsWritten;
      console.error(result);
    }

    // Get configured environment variables for a specific plugin
    private getConfiguredPluginEnv(filename: string): Record<string, string> {
      try {
        const result = this._sql.exec(
          `SELECT json(COALESCE(jsonb_extract(json_data, '$.pluginEnv."' || ? || '"'), jsonb('{}'))) as env FROM state WHERE id = 1;`,
          filename
        ).one();
        if (!result) {
          return {};
        }
        return JSON.parse(result.env as string);
      } catch (error) {
        console.error("Failed to get configured plugin env:", error);
        return {};
      }
    }

    // Set configured environment variables for a specific plugin
    private setConfiguredPluginEnv(filename: string, env: Record<string, string>): void {
      this.ctx.storage.transactionSync(() => {
        // Read current env for this plugin
        const current = this.getConfiguredPluginEnv(filename);
        // Merge with new values (filter out undefined/null)
        const next: Record<string, string> = { ...current };
        for (const [key, value] of Object.entries(env)) {
          if (value !== undefined && value !== null) {
            next[key] = value;
          }
        }
        // Write merged object
        this._sql.exec(
          `UPDATE state SET json_data = jsonb_patch(json_data, jsonb(?)) WHERE id = 1`,
          JSON.stringify({ pluginEnv: { [filename]: next } })
        );
      });
    }

    // Get all configured plugin environment variables
    private getAllConfiguredPluginEnv(): Record<string, Record<string, string>> {
      try {
        const result = this._sql.exec(
          `SELECT json(COALESCE(jsonb_extract(json_data, '$.pluginEnv'), jsonb('{}'))) as pluginEnv FROM state WHERE id = 1;`
        ).one();
        console.error("pluginEnv result", result);
        if (!result) {
          return {};
        }
        return JSON.parse(result.pluginEnv as string);
      } catch (error) {
        console.error("Failed to get all configured plugin env:", error);
        return {};
      }
    }

    // Get required env vars for a plugin from specs
    private getRequiredEnvForPlugin(filename: string): Array<{ name: string; description: string }> {
      const spec = PLUGIN_SPECS.find(s => s.filename === filename);
      return spec ? [...spec.requiredEnv] : [];
    }
        
    // RCON connection instance
    private rcon: Promise<Rcon> | null = null;

    // HTTP Proxy connection instances
    private httpProxyControl: HTTPProxyControl | null = null;
    private httpProxyLoopPromise: Promise<void> | null = null;
    private httpProxyLoopShouldStop: boolean = false;

    private stopping = false;
    
    override async stop() {
      console.error("stopppppp");
      this.recordSessionStop();
      let backupSuccess = false;
      // Perform backup before shutdown
      try {
        console.error("Triggering backup before container shutdown...");
        const backupResult = await this.performBackup();
        if (backupResult.success) {
          backupSuccess = true;
          console.error("Pre-shutdown backup completed successfully:", backupResult.backups);
        } else {
          console.error("Pre-shutdown backup failed:", backupResult.error);
        }
      } catch (error) {
        console.error("Error during pre-shutdown backup (continuing with shutdown):", error);
      }
      // don't set stopping until after the backup is taken or it prevents rcon.
      this.stopping = true;
      // if backup failed, give the container a shot at it
      if(!backupSuccess) {
        await super.stop("SIGTERM");
        return;
      }
      // just kill the container
      await super.stop("SIGKILL");
    }

    // Optional lifecycle hooks
    override async start() {
      this.stopping = false
      console.error("Container start triggered");
      this._initializeSql();
      const newOptionalPlugins = this.pluginFilenamesToEnable.join(" ");
      if(newOptionalPlugins !== this.envVars.OPTIONAL_PLUGINS) {
        this.envVars.OPTIONAL_PLUGINS = this.pluginFilenamesToEnable.join(" ");
      }
      
      console.error("Getting all configured plugin env");
      // Inject configured plugin environment variables (only mutate envVars here!)
      const allPluginEnv = this.getAllConfiguredPluginEnv();
      console.error("allPluginEnv", allPluginEnv);
      for (const [pluginFilename, envVars] of Object.entries(allPluginEnv)) {
        console.error("pluginFilename", pluginFilename);
        console.error("envVars", envVars);
        for (const [key, value] of Object.entries(envVars)) {
          // Only set if not already defined (core worker env wins)
          if (this.envVars[key as keyof typeof this.envVars] !== value) {
            console.error("Setting env var", key, value);
            (this.envVars as any)[key] = value;
          }
        }
      }

      console.error("Getting status");
      if(await this.getStatus() !== 'stopped') {
        // wait up to 3 mins for the server to start
        console.error("Waiting for server to start");
        const deadline = Date.now() + 3 * 60 * 1000;
        while(await this.getStatus() !== 'running') {
          await new Promise(resolve => setTimeout(resolve, 250));
          if(Date.now() > deadline) {
            throw new Error("Server did not start in time");
          }
        }
        if(await this.getStatus() !== 'running') {
          throw new Error("Server did not start in time");
        }
      }
      try {
        console.error("Starting and waiting for ports");
        const portsPromise = super.startAndWaitForPorts(8083, {
            waitInterval: 250,
            instanceGetTimeoutMS: 2000,
            portReadyTimeoutMS: 30_000
        });
        this.ctx.waitUntil((new Promise(resolve => setTimeout(resolve, 2000))).then(() => this.initHTTPProxy()));
        await portsPromise;
      } catch (error) {
        console.error("Error while starting ports but it's probably OK", error);
        const deadline = Date.now() + 5000;
        while(await this.getStatus() !== 'running') {
          await new Promise(resolve => setTimeout(resolve, 250));
          if(Date.now() > deadline) {
            throw new Error("Server did not start in time");
          }
        }
        if(await this.getStatus() !== 'running') {
          throw error;
        }
      }
      this.ctx.waitUntil(this.initHTTPProxy());
      console.error("Ports started");
    }

    override onStart() {
      console.error("Container successfully started");
      this.recordSessionStart();
      this.ctx.waitUntil(this.initRcon().then(rcon => rcon?.send("dynmap fullrender world")));
    }
  
  // =====================
  // Authentication helpers & methods
  // =====================

  private base64urlEncode(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    // btoa is available in Workers
    const b64 = btoa(str);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private base64urlDecode(input: string): Uint8Array {
    const b64 = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
    const str = atob(b64);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    return bytes;
  }

  private async derivePasswordHash(password: string, saltB64: string): Promise<string> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const saltBytes = this.base64urlDecode(saltB64);
    const saltBuf = new Uint8Array(saltBytes).buffer as ArrayBuffer;
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: saltBuf }, keyMaterial, 256);
    return this.base64urlEncode(bits);
  }

  private generateRandomBytes(length: number): Uint8Array {
    const arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    return arr;
  }

  private generateBackupId(): string {
    return this.base64urlEncode(this.generateRandomBytes(12));
  }

  // Async because it's easier to consume as RPC if fn is async
  public async setupPassword({ password }: { password: string }): Promise<{ created: boolean; symKey?: string }>{
    const run = async () => {
      console.error("setupPassword: Starting, isPasswordSet =", this._isPasswordSet);
      
      // Pre-generate values outside of transaction
      const salt = this.generateRandomBytes(16);
      const saltB64 = this.base64urlEncode(salt);
      const symKeyBytes = this.generateRandomBytes(32);
      const symKeyB64 = this.base64urlEncode(symKeyBytes);
      const hash = await this.derivePasswordHash(password, saltB64);

      console.error("setupPassword: Pre-generated values ready, entering transaction");
      
      // Use Cloudflare's transactionSync API for atomic operations
      const result = this.ctx.storage.transactionSync(() => {
        const checkResult = this._sql.exec('SELECT 1 as ok FROM auth LIMIT 1;');
        console.error("setupPassword: Transaction check, rowsRead =", checkResult.rowsRead);
        try {
          if(checkResult.one().ok) {
            console.error("setupPassword: Password already exists, aborting");
            return { created: false } as const;
          }
        } catch (_) {
          // Password doesn't exist
        }

        console.error("setupPassword: No existing password, inserting new auth record");
        const insertResult = this._sql.exec(
          'INSERT INTO auth (id, salt, password_hash, sym_key, created_at) VALUES (1, ?, ?, ?, ?);',
          saltB64, hash, symKeyB64, Date.now()
        );
        console.error("setupPassword: Insert result, rowsWritten =", insertResult.rowsWritten);

        this._isPasswordSet = true;
        return { created: true, symKey: symKeyB64 } as const;
      });
      
      console.error("setupPassword: Transaction complete, result =", result);
      return result;
    };

    // Prefer blocking concurrency if available
    const anyCtx: any = this.ctx as any;
    if (anyCtx && typeof anyCtx.blockConcurrencyWhile === 'function') {
      console.error("setupPassword: Using blockConcurrencyWhile");
      return await anyCtx.blockConcurrencyWhile(run);
    }
    console.error("setupPassword: No blockConcurrencyWhile, running directly");
    return await run();
  }

  public async getLogs(): Promise<string> {
    const response = await this.containerFetch("http://localhost:8082/", 8082);
    return await response.text();
  }

  public override async containerFetch(request: Request | string | URL, port: number): Promise<Response> {
    // container lib will start the container if it's stopped (at least in local dev)it's annoying AF
    const status = await this.getStatus();
    if(status !== 'stopped') {
      return await super.containerFetch(request, port);
    } else {
      return new Response("Container is not running", { status: 502 });
    }
  }

  public async getFileContents(filePath: string): Promise<string | null> {
    // Ensure the path starts with /
    const normalizedPath = filePath.startsWith('/') ? filePath : '/' + filePath;
    
    try {
      const response = await this.containerFetch(`http://localhost:8083${normalizedPath}`, 8083);
      
      if (!response.ok) {
        if (response.status === 404) {
          return null;
        } else if (response.status === 500) {
          const errorText = await response.text();
          throw new Error(`Permission error or internal error: ${errorText}`);
        } else {
          throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
        }
      }
      
      return await response.text();
    } catch (error) {
      console.error("Failed to get file contents:", error);
      throw error;
    }
  }

  public async getStatus(): Promise<'running' | 'stopping' | 'stopped' | 'starting'> {
    const state = await this.getState();
    const status = state.status;
    if(status === 'stopped_with_code') {
      this.stopping = false;
      return 'stopped';
    } else if ( status === 'healthy') {
      if(this.stopping) {
        return 'stopping';
      }
      return 'running';
    } else if (status === 'stopped') {
      this.stopping = false;
      return status;
    } else if (status === 'running') {
      if(this.stopping) {
        return 'stopping';
      }
    }
    return status;
  }

  public async getStartupStep(): Promise<string | null> {
    try {
      const status = await this.getStatus();
      if (status === 'stopped') {
        return null;
      }
      
      const content = await this.getFileContents("/status/step.txt");
      return content?.trim() ?? null;
    } catch (error) {
      // File doesn't exist yet or can't be read
      return null;
    }
  }

  // Async because it's easier to consume as RPC if fn is async
  public async verifyPassword({ password }: { password: string }): Promise<{ ok: boolean }>{
    try {
      const row = this._sql.exec('SELECT salt, password_hash FROM auth LIMIT 1;').one();
      if (!row) {
        return { ok: false };
      }
      const salt = (row.salt as string) ?? '';
      const storedHash = (row.password_hash as string) ?? '';
      const derived = await this.derivePasswordHash(password, salt);
      return { ok: this.timingSafeEqualAscii(derived, storedHash) };
    } catch (_) {
      return { ok: false };
    }
  }

  private timingSafeEqualAscii(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  }

  // Async because it's easier to consume as RPC if fn is async
  public async getSymmetricKey(): Promise<{ symKey?: string }>{
    if (!this._isPasswordSet) return {};
    try {
      const row = this._sql.exec('SELECT sym_key FROM auth LIMIT 1;').one();
      if (!row) return {};
      return { symKey: row.sym_key as string };
    } catch (_) {
      return {};
    }
  }

  // Debug helper - clear auth (dev only)
  public async clearAuth(): Promise<void> {
    console.error("clearAuth: Clearing auth table");
    this.ctx.storage.transactionSync(() => {
      this._sql.exec('DELETE FROM auth;');
      this._isPasswordSet = false;
    });
    console.error("clearAuth: Complete, isPasswordSet =", this._isPasswordSet);
  }

  // =====================
  // Session tracking methods
  // =====================

  private recordSessionStart(): void {
    try {
      // Close any open sessions first (in case of unexpected restart)
      this._sql.exec(`
        UPDATE container_sessions
        SET stopped_at = ?, duration_ms = ? - started_at
        WHERE stopped_at IS NULL
      `, Date.now(), Date.now());

      // Create new session
      this._sql.exec('INSERT INTO container_sessions (started_at) VALUES (?)', Date.now());
      console.error("Session start recorded");
    } catch (error) {
      console.error("Failed to record session start:", error);
    }
  }

  private recordSessionStop(): void {
    try {
      const now = Date.now();
      this._sql.exec(`
        UPDATE container_sessions
        SET stopped_at = ?, duration_ms = ? - started_at
        WHERE stopped_at IS NULL
      `, now, now);
      console.error("Session stop recorded");
    } catch (error) {
      console.error("Failed to record session stop:", error);
    }
  }

  public async getCurrentSession(): Promise<{ isRunning: boolean; startedAt?: number } | null> {
    try {
      const rows = this._sql.exec(`
        SELECT started_at FROM container_sessions
        WHERE stopped_at IS NULL
        ORDER BY id DESC
        LIMIT 1
      `).toArray();

      if (rows.length > 0) {
        const row = rows[0];
        return {
          isRunning: true,
          startedAt: row.started_at as number
        };
      }
      return { isRunning: false };
    } catch (error) {
      console.error("Failed to get current session:", error);
      return null;
    }
  }

  public async getLastSession(): Promise<{ stoppedAt?: number; durationMs?: number } | null> {
    try {
      const rows = this._sql.exec(`
        SELECT stopped_at, duration_ms FROM container_sessions
        WHERE stopped_at IS NOT NULL
        ORDER BY stopped_at DESC
        LIMIT 1
      `).toArray();

      if (rows.length > 0) {
        const row = rows[0];
        return {
          stoppedAt: row.stopped_at as number,
          durationMs: row.duration_ms as number
        };
      }
      return null;
    } catch (error) {
      console.error("Failed to get last session:", error);
      return null;
    }
  }

  public async getUsageStats(): Promise<{ thisMonth: number; thisYear: number }> {
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const yearStart = new Date(now.getFullYear(), 0, 1).getTime();

      // Get completed sessions + current session duration
      const monthRows = this._sql.exec(`
        SELECT
          COALESCE(SUM(duration_ms), 0) as completed,
          (SELECT started_at FROM container_sessions WHERE stopped_at IS NULL LIMIT 1) as current_start
        FROM container_sessions
        WHERE stopped_at >= ? AND stopped_at IS NOT NULL
      `, monthStart).toArray();

      const yearRows = this._sql.exec(`
        SELECT
          COALESCE(SUM(duration_ms), 0) as completed,
          (SELECT started_at FROM container_sessions WHERE stopped_at IS NULL LIMIT 1) as current_start
        FROM container_sessions
        WHERE stopped_at >= ? AND stopped_at IS NOT NULL
      `, yearStart).toArray();

      const monthResult = monthRows.length > 0 ? monthRows[0] : { completed: 0, current_start: null };
      const yearResult = yearRows.length > 0 ? yearRows[0] : { completed: 0, current_start: null };

      let monthMs = (monthResult?.completed as number) || 0;
      let yearMs = (yearResult?.completed as number) || 0;

      // Add current session time if running
      const currentStart = monthResult?.current_start as number | null;
      if (currentStart) {
        const currentDuration = Date.now() - currentStart;
        if (currentStart >= monthStart) monthMs += currentDuration;
        if (currentStart >= yearStart) yearMs += currentDuration;
      }

      return {
        thisMonth: monthMs / (1000 * 60 * 60), // Convert to hours
        thisYear: yearMs / (1000 * 60 * 60)
      };
    } catch (error) {
      console.error("Failed to get usage stats:", error);
      return { thisMonth: 0, thisYear: 0 };
    }
  }

    override onStop() {
      console.error("Container successfully shut down");
      this.ctx.waitUntil(this.disconnectRcon());
      this.ctx.waitUntil(this.disconnectHTTPProxy());
    }
  
    override onError(error: unknown) {
      console.error("Container error:", error);
    }

    
    // Handle HTTP requests to this container
    override async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        console.error("Fetching container", url.pathname);

        console.error("Optional plugins", this.pluginFilenamesToEnable);
        
        if (url.protocol.startsWith('ws') || url.pathname.startsWith('/ws')) {
          console.error('websocket')
          // Creates two ends of a WebSocket connection.
          const webSocketPair = new WebSocketPair();
          const [client, server] = Object.values(webSocketPair);

          // Calling `acceptWebSocket()` connects the WebSocket to the Durable Object, allowing the WebSocket to send and receive messages.
          // Unlike `ws.accept()`, `state.acceptWebSocket(ws)` allows the Durable Object to be hibernated
          // When the Durable Object receives a message during Hibernation, it will run the `constructor` to be re-initialized
          console.error('accept websocket');
          this.ctx.acceptWebSocket(server);

          return new Response(null, {
            status: 101,
            webSocket: client,
          });
        }
        console.error('not websocket');

        // Handle RCON API requests
        if (url.pathname === "/rcon/status") {
          const status = await this.getRconStatus();
          return new Response(JSON.stringify(status), {
            headers: { "Content-Type": "application/json" }
          });
        }

        if (url.pathname === "/status" || url.pathname === "/startup-status") {
          const containerStatus = await this.getStatus();
          const startupStep = await this.getStartupStep();
          return new Response(JSON.stringify({ 
            status: containerStatus, 
            startupStep 
          }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        
        if (url.pathname === "/rcon/players") {
          const players = await this.getRconPlayers();
          return new Response(JSON.stringify({ players }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        
        if (url.pathname === "/rcon/info") {
          const info = await this.getRconInfo();
          return new Response(JSON.stringify(info), {
            headers: { "Content-Type": "application/json" }
          });
        }
    
        // Default health check
        if (url.pathname === "/healthz") {
          return new Response("OK");
        }
    
        return new Response("Not Found", { status: 404 });
      
      } catch (error) {
        console.error("Failed to fetch", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }
  
    // Initialize RCON connection
    private async initRcon(maxAttempts = 10): Promise<Rcon | null> {
      const status = await this.getStatus();
      if(status === 'stopped' || status === 'stopping') {
        return null;
      }
      if(this.rcon) {
        console.error("RCON already initialized, checking if it's still valid");
        
        // We need to check if the connection is still valid and working
        const client = await this.rcon;
        if(this.lastRconSuccess?.getTime() ?? 0 < Date.now() - 10000) {
          if(await client.isConnected()) {
            this.lastRconSuccess = new Date();
            return client;
          } else {
            this.rcon = null;
            this.lastRconSuccess = null;
          }
        } else {
          return client;
        }
      }
      try {
        const port = this._container?.getTcpPort(25575);
        if(!port) {
          throw new Error("Failed to get RCON port");
        }
        
        console.error("Initializing RCON", Rcon);
        this.rcon = new Promise(async (resolve, reject) => {
          try {
            const rcon = new Rcon(port, "minecraft", () => this.getStatus());
            await rcon.connect(maxAttempts);
            console.error("RCON connected");
            this.lastRconSuccess = new Date();
            resolve(rcon);
          } catch (error) {
            this.rcon = null;
            reject(error);
          }
        });
        return this.rcon;
      } catch (error) {
        console.error("Failed to initialize RCON:", error);
        throw error;
      }
    }
  
    // Disconnect RCON
    private async disconnectRcon() {
      if (this.rcon) {
        const oldRcon = this.rcon;
        this.rcon = null;
        await oldRcon.then(rcon => rcon.disconnect());
      }
    }
  
    // Get server status via RCON
    public async getRconStatus(): Promise<{ online: boolean; playerCount?: number; maxPlayers?: number }> {
      if (!this.rcon) {
        if(!(await this.initRcon())) {
          return { online: false };
        } else {
          return { online: true };
        }
      }

      try {
        const listResponse = await this.rcon.then(rcon => rcon.send("list"));
        console.error("Received response from RCON", listResponse);
        
        // Parse response like "There are 3 of a max of 20 players online"
        const match = listResponse.match(/There are (\d+) of a max of (\d+) players online/);
        if (match) {
          return {
            online: true,
            playerCount: parseInt(match[1]),
            maxPlayers: parseInt(match[2])
          };
        } else {
          return { online: true };
        }
      } catch (error) {
        console.error("Failed to get server status:", error);
        return { online: false };
      }
    }
  
    // Get player list via RCON
    private async getRconPlayers(): Promise<string[]> {
      if (!this.rcon) {
        if(!(await this.initRcon())) {
          return [];
        }
      }

      try {
        const listResponse = await this.rcon!.then(rcon => rcon.send("list"));
        console.error("Received player list response from RCON", listResponse);
        
        // Parse player list from response
        const playerMatch = listResponse.match(/online: (.+)$/);
        if (playerMatch && playerMatch[1].trim() !== "") {
          const players = playerMatch[1].split(", ").map(p => p.trim());
          return players;
        } else {
          return [];
        }
      } catch (error) {
        console.error("Failed to get player list:", error);
        return [];
      }
    }
  
    // Get server info via RCON
    private async getRconInfo(): Promise<{ 
      serverType?: string;
      version?: string; 
      versionName?: string;
      versionId?: string;
      data?: string;
      series?: string;
      protocol?: string;
      buildTime?: string;
      packResource?: string;
      packData?: string;
      stable?: string;
      motd?: string;
    }> {
      if (!this.rcon) {
        if(!(await this.initRcon())) {
          return {};
        }
      }

      try {
        // Get version info via RCON. Handle weird / thing in vanilla MC
        const versionResponse = await this.rcon!.then(rcon => rcon.send("version")).then(r => r.split('/').join('\n/').trim());
        
        const info: any = {
          motd: "Minecraft Server"
        };
        
        // Check if this is a Paper server format
        // Format: "§fThis server is running Paper version 1.21.7-32-main@e792779 (2025-07-16T20:10:15Z) (Implementing API version 1.21.7-R0.1-SNAPSHOT)§r"
        const paperMatch = versionResponse.match(/Paper version ([\d\.]+-\d+-[^@]+@[^\s]+)\s*\(([^)]+)\)\s*\(Implementing API version ([^)]+)\)/);
        
        if (paperMatch) {
          // Parse Paper format
          const [, version, buildTime, apiVersion] = paperMatch;
          
          info.serverType = "PaperMC";
          info.version = version;
          info.versionName = version;
          info.buildTime = buildTime;
          info.data = apiVersion;
          
          // Extract base version number (e.g., "1.21.7" from "1.21.7-32-main@e792779")
          const baseVersionMatch = version.match(/^([\d\.]+)/);
          if (baseVersionMatch) {
            info.versionId = baseVersionMatch[1];
          }
          
          console.error("Parsed Paper server version:", info);
        } else {
          // Parse default Minecraft format
          // Format: "Server version info:id = 1.21.9name = 1.21.9data = 4554..."
          // RCON doesn't include proper newlines, so we need to parse with regex
          
          info.serverType = "Minecraft Java";
          
          // Extract version fields using regex patterns
          const idMatch = versionResponse.match(/id\s*=\s*([^\s]+?)(?:name|$)/);
          const nameMatch = versionResponse.match(/name\s*=\s*([^\s]+?)(?:data|$)/);
          const dataMatch = versionResponse.match(/data\s*=\s*([^\s]+?)(?:series|$)/);
          const seriesMatch = versionResponse.match(/series\s*=\s*([^\s]+?)(?:protocol|$)/);
          const protocolMatch = versionResponse.match(/protocol\s*=\s*([^\s]+?)\s*\([^)]+\)(?:build_time|$)/);
          const buildTimeMatch = versionResponse.match(/build_time\s*=\s*(.+?)(?:pack_resource|$)/);
          const packResourceMatch = versionResponse.match(/pack_resource\s*=\s*([^\s]+?)(?:pack_data|$)/);
          const packDataMatch = versionResponse.match(/pack_data\s*=\s*([^\s]+?)(?:stable|$)/);
          const stableMatch = versionResponse.match(/stable\s*=\s*([^\s]+?)$/);
          
          if (idMatch) info.versionId = idMatch[1].trim();
          if (nameMatch) info.versionName = nameMatch[1].trim();
          if (dataMatch) info.data = dataMatch[1].trim();
          if (seriesMatch) info.series = seriesMatch[1].trim();
          if (protocolMatch) info.protocol = protocolMatch[1].trim();
          if (buildTimeMatch) info.buildTime = buildTimeMatch[1].trim();
          if (packResourceMatch) info.packResource = packResourceMatch[1].trim();
          if (packDataMatch) info.packData = packDataMatch[1].trim();
          if (stableMatch) info.stable = stableMatch[1].trim();
          
          // Set the main version field to the version name
          info.version = info.versionName || "Unknown";
          
          console.error("Parsed default Minecraft server version:", info);
        }
        
        return info;
      } catch (error) {
        console.error("Failed to get server info:", error);
        return { version: "Unknown", motd: "Minecraft Server" };
      }
    }

    public async listAllPlugins() {
      return PLUGIN_SPECS.map(spec => ({
        displayName: spec.displayName,
        filename: spec.filename,
        requiredEnv: [...spec.requiredEnv], // Clone to mutable array
      }));
    }

    // Async because it's easier to consume as RPC if fn is async
    public async enablePlugin({ filename, env }: { filename: string; env?: Record<string, string> }) {
      // If env provided, persist it first
      if (env) {
        this.setConfiguredPluginEnv(filename, env);
      }
      
      // Validate that all required env vars are set
      const requiredEnv = this.getRequiredEnvForPlugin(filename);
      if (requiredEnv.length > 0) {
        const configured = this.getConfiguredPluginEnv(filename);
        const missing = requiredEnv.filter(({ name }) => !configured[name] || configured[name].trim() === '');
        
        if (missing.length > 0) {
          const missingNames = missing.map(e => e.name).join(', ');
          throw new Error(`Cannot enable plugin ${filename}: missing required environment variables: ${missingNames}`);
        }
      }
      
      this.pluginFilenamesToEnable = [...this.pluginFilenamesToEnable, filename];
    }

    // Async because it's easier to consume as RPC if fn is async
    public async disablePlugin({ filename }: { filename: string }) {
      if(filename === DYNMAP_PLUGIN_FILENAME) {
        throw new Error("Dynmap cannot be disabled");
      }
      this.pluginFilenamesToEnable = this.pluginFilenamesToEnable.filter(p => p !== filename);
    }

    // Async because it's easier to consume as RPC if fn is async
    public async setPluginEnv({ filename, env }: { filename: string; env: Record<string, string> }) {
      this.setConfiguredPluginEnv(filename, env);
    }


    public async getPluginState(): Promise<Array<{
      filename: string;
      displayName: string;
      state: 'ENABLED' | 'DISABLED_WILL_ENABLE_AFTER_RESTART' | 'ENABLED_WILL_DISABLE_AFTER_RESTART' | 'DISABLED';
      requiredEnv: Array<{ name: string; description: string }>;
      configuredEnv: Record<string, string>;
      status: PluginStatus;
    }>> {
      const enabledPlugins = this.envVars.OPTIONAL_PLUGINS.split(" ");
      const desiredPlugins = await this.pluginFilenamesToEnable;
      const allPlugins = await this.listAllPlugins();
      
      // Resolve all plugin statuses in parallel
      const pluginsWithStatus = await Promise.all(
        allPlugins.map(async (plugin) => {
          const spec = PLUGIN_SPECS.find(s => s.filename === plugin.filename);
          
          // Only check status for plugins that are currently enabled in envVars
          const isCurrentlyEnabled = enabledPlugins.includes(plugin.filename);
          const status = (spec?.getStatus && isCurrentlyEnabled)
            ? await spec.getStatus(this).catch(() => ({ type: "no message" as const }))
            : { type: "no message" as const };
          
          const state: 'ENABLED' | 'DISABLED_WILL_ENABLE_AFTER_RESTART' | 'ENABLED_WILL_DISABLE_AFTER_RESTART' | 'DISABLED' = 
            desiredPlugins.includes(plugin.filename) 
              ? (enabledPlugins.includes(plugin.filename) ? 'ENABLED' : 'DISABLED_WILL_ENABLE_AFTER_RESTART') 
              : (enabledPlugins.includes(plugin.filename) ? 'ENABLED_WILL_DISABLE_AFTER_RESTART' : 'DISABLED');
          
          return {
            filename: plugin.filename,
            displayName: plugin.displayName,
            state,
            requiredEnv: plugin.requiredEnv,
            configuredEnv: this.getConfiguredPluginEnv(plugin.filename),
            status,
          };
        })
      );
      
      return pluginsWithStatus;
    }

    async broadcast(message: ArrayBuffer | string) {
      for (const ws of this.ctx.getWebSockets()) {
        ws.send(message);
      }
    }

    /**
     * Perform a backup of world data to R2
     * This will:
     * 1. Save and disable world saving via RCON
     * 2. Backup world directories to R2
     * 3. Re-enable world saving
     */
    public async performBackup(): Promise<{ 
      success: boolean; 
      backups: Array<{ path: string; size: number }>;
      error?: string;
    }> {
      console.error("Starting backup process...");
      
      try {
        try {
          // Step 1: Ensure RCON is initialized
            const rcon = await this.initRcon(2);
            if (!rcon) {
              throw new Error("RCON not available - server may be offline");
            }
            
            // Step 2: Execute save-all flush to ensure all data is written
            console.error("Executing save-all flush...");
            await rcon.send("save-all flush");
            console.error("Pausing dynmap rendering");
            await rcon.send("dynmap pause all")
            
            // TODO: Poll the logs to check if the save-all flush is complete
            // Wait a moment for save to complete
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Step 3: Disable auto-saving
            console.error("Disabling auto-save...");
            await rcon.send("save-off");
        } catch (error) {
          console.error("Error during save-all flush, proceeding with disk backup anyway", error);
        }
        try {
          // Step 4: Backup all the data
          const worldDirs = [
            '/data'
          ];

          const POLL_INTERVAL_MS = 2000;
          const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per job

          const runOne = async (worldDir: string): Promise<{ path: string; size: number } | null> => {
            console.error(`Backing up ${worldDir} (background)...`);
            const backupId = this.generateBackupId();

            // Trigger start
            const startResp = await this.containerFetch(
              `http://localhost:8083${worldDir}?backup=true&backup_id=${backupId}`,
              8083
            );
            if (!startResp.ok) {
              const errorText = await startResp.text();
              console.error(`Failed to start backup ${worldDir}: ${startResp.status} ${errorText}`);
              return null;
            }

            const deadline = Date.now() + POLL_TIMEOUT_MS;
            while (true) {
              if (Date.now() > deadline) {
                console.error(`Backup timed out for ${worldDir}`);
                return null;
              }
              const statusResp = await this.containerFetch(
                `http://localhost:8083/backup-status?id=${backupId}`,
                8083
              );
              if (!statusResp.ok) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                continue;
              }
              const status = await statusResp.json() as {
                status: 'pending' | 'running' | 'success' | 'failed' | 'not_found';
                result?: { backup_path: string; size: number } | null;
                error?: string | null;
              };
              if (status.status === 'success' && status.result) {
                console.error(`Backup completed for ${worldDir}:`, status.result);
                return { path: status.result.backup_path, size: status.result.size };
              }
              if (status.status === 'failed') {
                console.error(`Failed to backup ${worldDir}: ${status.error || 'unknown error'}`);
                return null;
              }
              await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            }
          };

          // Launch all jobs concurrently
          const settlements = await Promise.allSettled(worldDirs.map(runOne));
          const backupResults: Array<{ path: string; size: number }> = [];
          for (const s of settlements) {
            if (s.status === 'fulfilled' && s.value) backupResults.push(s.value);
          }

          const allSucceeded = backupResults.length === worldDirs.length;
          console.error(allSucceeded 
            ? "All backups completed successfully" 
            : `Partial backup: ${backupResults.length}/${worldDirs.length} succeeded`);
          return { success: allSucceeded, backups: backupResults };

        } finally {
          // Step 5: Always re-enable auto-saving, even if backup failed
          console.error("Re-enabling auto-save...");
          try {
            const rcon = await this.initRcon();
            if (!rcon) {
              throw new Error("RCON not available - server may be offline");
            }
            await rcon.send("save-on");
            console.error("Auto-save re-enabled");
            await rcon.send("dynmap pause none") // wierd syntax but this means resume
            console.error("Dynmap resumed")
          } catch (error) {
            console.error("Failed to re-enable auto-save:", error);
            // Don't throw here - we want to return the backup results
          }
        }
        
      } catch (error) {
        console.error("Backup process failed:", error);
        return {
          success: false,
          backups: [],
          error: String(error)
        };
      }
    }

    async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
      // Upon receiving a message from the client, reply with the same message,
      // but will prefix the message with "[Durable Object]: " and return the number of connections.
      if(!this.rcon && !(await this.initRcon())) {
        ws.send("Message delivery failed: Server is offline");
        return;
      }
      
      const messageString = message instanceof ArrayBuffer ? new TextDecoder().decode(message) : message;
      // const [command, ...args] = messageString.split(" ");
      
      const response = await this.rcon!.then(rcon => rcon.send(messageString));

      ws.send(response);
    }

    async webSocketClose(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ) {
      // If the client closes the connection, the runtime will invoke the webSocketClose() handler.
      ws.close(code, "Durable Object is closing WebSocket");
    }

    async fetchFromR2(request: Request): Promise<Response> {
      const url = new URL(request.url);
    
      // Strip bucket name from path if using path-style URLs
      // Path-style: /bucket-name/path/to/object
      // Virtual-hosted: /path/to/object (bucket name in hostname)
      let pathname = url.pathname;
      if(pathname.startsWith("/r2")) {
        pathname = pathname.slice(3);
        // if first character is not a slash, add one
        if(pathname[0] !== "/") {
          pathname = "/" + pathname;
        }
      }
      const publicBucketName = this.env.DYNMAP_BUCKET_NAME;
      const privateBucketName = this.env.DATA_BUCKET_NAME;
      // default to public bucket
      let bucketToUse = this.env.DYNMAP_BUCKET;
      console.error("Fetching from R2", url.pathname);
      if (publicBucketName && pathname.startsWith(`/${publicBucketName}`)) {
        // Strip the bucket name prefix
        pathname = pathname.slice(publicBucketName.length + 1); // +1 for the leading slash
        if(pathname === "") {
          pathname = "/";
        }
        bucketToUse = this.env.DYNMAP_BUCKET;
      }
      else if (privateBucketName && pathname.startsWith(`/${privateBucketName}`)) {
        // Strip the bucket name prefix
        pathname = pathname.slice(privateBucketName.length + 1); // +1 for the leading slash
        if(pathname === "") {
          pathname = "/";
        }
        bucketToUse = this.env.DATA_BUCKET;
      }
      
      if(pathname === "/") {
        // it's a list request get the query params
        // prefix - Filter objects by prefix
        // delimiter - Group keys (typically /)
        // max-keys - Maximum number of keys to return
        // continuation-token - For pagination (ListObjectsV2)
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter") ?? "";
        const maxKeys = parseInt(url.searchParams.get("max-keys") ?? "1000");
        const continuationToken = url.searchParams.get("continuation-token");
        
        const list = await bucketToUse.list({
          prefix: prefix,
          delimiter: delimiter,
          limit: maxKeys,
          ...(continuationToken ? { cursor: continuationToken } : {}),
        });
        
        // Build AWS S3-compatible XML response
        const escapeXml = (str: string) => {
          return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
        };
        
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n';
        xml += `  <Name>r2-bucket</Name>\n`;
        xml += `  <Prefix>${escapeXml(prefix)}</Prefix>\n`;
        xml += `  <KeyCount>${list.objects.length}</KeyCount>\n`;
        xml += `  <MaxKeys>${maxKeys}</MaxKeys>\n`;
        xml += `  <IsTruncated>${list.truncated}</IsTruncated>\n`;
        
        if (delimiter) {
          xml += `  <Delimiter>${escapeXml(delimiter)}</Delimiter>\n`;
        }
        
        if (list.truncated && list.cursor) {
          xml += `  <NextContinuationToken>${escapeXml(list.cursor)}</NextContinuationToken>\n`;
        }
        
        // Add Contents for each object
        for (const obj of list.objects) {
          xml += '  <Contents>\n';
          xml += `    <Key>${escapeXml(obj.key)}</Key>\n`;
          xml += `    <LastModified>${obj.uploaded.toISOString()}</LastModified>\n`;
          xml += `    <ETag>&quot;${escapeXml(obj.etag)}&quot;</ETag>\n`;
          xml += `    <Size>${obj.size}</Size>\n`;
          xml += `    <StorageClass>${escapeXml(obj.storageClass || 'STANDARD')}</StorageClass>\n`;
          xml += '  </Contents>\n';
        }
        
        // Add CommonPrefixes (for directory-like listings when using delimiter)
        if (list.delimitedPrefixes && list.delimitedPrefixes.length > 0) {
          for (const commonPrefix of list.delimitedPrefixes) {
            xml += '  <CommonPrefixes>\n';
            xml += `    <Prefix>${escapeXml(commonPrefix)}</Prefix>\n`;
            xml += '  </CommonPrefixes>\n';
          }
        }
        
        xml += '</ListBucketResult>';
        
        return new Response(xml, {
          headers: { 
            "Content-Type": "application/xml",
            "Content-Length": xml.length.toString()
          }
        });
      }
      const pathWithoutLeadingSlash = pathname.startsWith('/') ? pathname.slice(1) : pathname;
      switch(request.method) {
        case "POST": {
          // AWS S3 CreateMultipartUpload: POST /key?uploads
          // AWS S3 CompleteMultipartUpload: POST /key?uploadId=ID
          const uploadId = url.searchParams.get("uploadId");
          
          if (url.searchParams.has("uploads")) {
            // CreateMultipartUpload
            console.error("Creating multipart upload for:", pathWithoutLeadingSlash);
            const contentType = request.headers.get("Content-Type") || undefined;
            const md5Header = request.headers.get("Content-MD5");
            const cacheControl = request.headers.get("Cache-Control") || undefined;
            const contentDisposition = request.headers.get("Content-Disposition") || undefined;
            const contentEncoding = request.headers.get("Content-Encoding") || undefined;
            const contentLanguage = request.headers.get("Content-Language") || undefined;
            
            const multipart = await bucketToUse.createMultipartUpload(pathWithoutLeadingSlash, {
              httpMetadata: {
                ...(contentType ? { contentType } : {}),
                ...(cacheControl ? { cacheControl } : {}),
                ...(contentDisposition ? { contentDisposition } : {}),
                ...(contentEncoding ? { contentEncoding } : {}),
                ...(contentLanguage ? { contentLanguage } : {}),
              },
              ...(md5Header ? { customMetadata: { md5: md5Header } } : {}),
            });

            const escapeXml = (str: string) =>
              str.replace(/&/g, '&amp;')
                 .replace(/</g, '&lt;')
                 .replace(/>/g, '&gt;')
                 .replace(/"/g, '&quot;')
                 .replace(/'/g, '&apos;');

            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>r2-bucket</Bucket>
  <Key>${escapeXml(pathWithoutLeadingSlash)}</Key>
  <UploadId>${multipart.uploadId}</UploadId>
</InitiateMultipartUploadResult>`;

            console.error("Multipart upload created with uploadId:", multipart.uploadId);
            return new Response(xml, {
              headers: {
                "Content-Type": "application/xml",
                "x-amz-request-id": this.ctx.id.toString(),
              },
            });
          }
          
          if (uploadId) {
            // CompleteMultipartUpload
            console.error("Completing multipart upload:", uploadId, "for:", pathWithoutLeadingSlash);
            const bodyText = await request.text();
            console.error("Complete multipart body:", bodyText);

            // Parse parts from XML body
            // Format: <CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"etag"</ETag></Part>...</CompleteMultipartUpload>
            const partRegex = /<Part>\s*<PartNumber>\s*(\d+)\s*<\/PartNumber>\s*<ETag>\s*([^<]+)\s*<\/ETag>\s*<\/Part>/gi;
            const parts: { partNumber: number; etag: string }[] = [];
            for (const m of bodyText.matchAll(partRegex)) {
              let etag = m[2].trim();
              // Remove quotes if present (AWS sometimes includes them, sometimes doesn't)
              if (etag.startsWith('"') && etag.endsWith('"')) {
                etag = etag.slice(1, -1);
              }
              if (etag.startsWith('&quot;') && etag.endsWith('&quot;')) {
                etag = etag.slice(6, -6);
              }
              parts.push({ partNumber: parseInt(m[1], 10), etag });
            }

            console.error("Parsed parts:", parts);

            if (parts.length === 0) {
              return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>MalformedXML</Code>
    <Message>The XML you provided was not well-formed or did not validate against our published schema</Message>
    <RequestId>${this.ctx.id.toString()}</RequestId>
    <HostId>${this.ctx.id.toString()}</HostId>
</Error>`, {
                status: 400,
                headers: {
                  "Content-Type": "application/xml",
                  "x-amz-request-id": this.ctx.id.toString(),
                },
              });
            }

            const multipartUpload = bucketToUse.resumeMultipartUpload(pathWithoutLeadingSlash, uploadId);
            const object = await multipartUpload.complete(parts);

            const escapeXml = (str: string) =>
              str.replace(/&/g, '&amp;')
                 .replace(/</g, '&lt;')
                 .replace(/>/g, '&gt;')
                 .replace(/"/g, '&quot;')
                 .replace(/'/g, '&apos;');

            const location = `${url.origin}${url.pathname}`;
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>${escapeXml(location)}</Location>
  <Bucket>r2-bucket</Bucket>
  <Key>${escapeXml(pathWithoutLeadingSlash)}</Key>
  <ETag>&quot;${escapeXml(object.etag)}&quot;</ETag>
</CompleteMultipartUploadResult>`;

            console.error("Multipart upload completed successfully");
            return new Response(xml, {
              headers: {
                "Content-Type": "application/xml",
                "ETag": `"${object.etag}"`,
                "x-amz-request-id": this.ctx.id.toString(),
              },
            });
          }

          return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>InvalidRequest</Code>
    <Message>POST requires either ?uploads or ?uploadId parameter</Message>
    <RequestId>${this.ctx.id.toString()}</RequestId>
    <HostId>${this.ctx.id.toString()}</HostId>
</Error>`, { 
            status: 400,
            headers: {
              "Content-Type": "application/xml",
              "x-amz-request-id": this.ctx.id.toString(),
            }
          });
        }
        case "HEAD": {
          const obj = await bucketToUse.head(pathWithoutLeadingSlash);
          if (!obj) {
            return new Response(null, { 
              status: 404,
              headers: {
                "Content-Type": "application/xml",
                "x-amz-request-id": this.ctx.id.toString(),
              }
            });
          }
          
          // Handle conditional requests
          const ifMatch = request.headers.get("If-Match");
          const ifNoneMatch = request.headers.get("If-None-Match");
          const objectETag = `"${obj.etag}"`;
          
          // If-Match: return 412 if ETag doesn't match
          if (ifMatch && ifMatch !== "*" && ifMatch !== objectETag) {
            return new Response(null, {
              status: 412, // Precondition Failed
              headers: {
                "x-amz-request-id": this.ctx.id.toString(),
              }
            });
          }
          
          // If-None-Match: return 304 if ETag matches (resource hasn't changed)
          if (ifNoneMatch) {
            const etags = ifNoneMatch.split(',').map(tag => tag.trim());
            if (etags.includes(objectETag) || ifNoneMatch === "*") {
              return new Response(null, {
                status: 304, // Not Modified
                headers: {
                  "ETag": objectETag,
                  "Last-Modified": obj.uploaded.toUTCString(),
                  "x-amz-request-id": this.ctx.id.toString(),
                }
              });
            }
          }
          
          const responseHeaders: Record<string, string> = {
            "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
            "Content-Length": obj.size.toString(),
            "ETag": objectETag,
            "Last-Modified": obj.uploaded.toUTCString(),
            "Accept-Ranges": "bytes",
            "x-amz-request-id": this.ctx.id.toString(),
          };
          
          // Include MD5 hash if stored in customMetadata
          if (obj.customMetadata?.md5) {
            responseHeaders["x-amz-meta-md5"] = obj.customMetadata.md5;
          }
          
          return new Response(null, { 
            status: 200,
            headers: responseHeaders
          });
        }
        case "GET": {
          const obj = await bucketToUse.get(pathWithoutLeadingSlash);
          if (!obj) {
            // simulate aws s3 error
            return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>NoSuchKey</Code>
    <Message>The specified key does not exist.</Message>
    <Key>${pathWithoutLeadingSlash}</Key>
    <RequestId>${this.ctx.id.toString()}</RequestId>
    <HostId>${this.ctx.id.toString()}</HostId>
</Error>`
              , { status: 404 });
          }
          
          // Handle conditional requests
          const ifMatch = request.headers.get("If-Match");
          const ifNoneMatch = request.headers.get("If-None-Match");
          const objectETag = `"${obj.etag}"`;
          
          // If-Match: return 412 if ETag doesn't match
          if (ifMatch && ifMatch !== "*" && ifMatch !== objectETag) {
            return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>PreconditionFailed</Code>
    <Message>At least one of the preconditions you specified did not hold.</Message>
    <Condition>If-Match</Condition>
    <RequestId>${this.ctx.id.toString()}</RequestId>
    <HostId>${this.ctx.id.toString()}</HostId>
</Error>`, {
              status: 412, // Precondition Failed
              headers: {
                "Content-Type": "application/xml",
                "x-amz-request-id": this.ctx.id.toString(),
              }
            });
          }
          
          // If-None-Match: return 304 if ETag matches (resource hasn't changed)
          if (ifNoneMatch) {
            const etags = ifNoneMatch.split(',').map(tag => tag.trim());
            if (etags.includes(objectETag) || ifNoneMatch === "*") {
              return new Response(null, {
                status: 304, // Not Modified
                headers: {
                  "ETag": objectETag,
                  "Last-Modified": obj.uploaded.toUTCString(),
                  "x-amz-request-id": this.ctx.id.toString(),
                }
              });
            }
          }
          
          const responseHeaders: Record<string, string> = {
            "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
            "Content-Length": obj.size.toString(),
            "ETag": objectETag,
            "Last-Modified": obj.uploaded.toUTCString(),
            "Accept-Ranges": "bytes",
            "x-amz-request-id": this.ctx.id.toString(),
          };
          
          // Include MD5 hash if stored in customMetadata
          if (obj.customMetadata?.md5) {
            responseHeaders["x-amz-meta-md5"] = obj.customMetadata.md5;
          }
          
          return new Response(obj.body as unknown as ReadableStream, {
            headers: responseHeaders,
          });
          
        }
        case "PUT": {
          // AWS S3 UploadPart: PUT /key?partNumber=N&uploadId=ID
          const uploadId = url.searchParams.get("uploadId");
          const partNumberParam = url.searchParams.get("partNumber");
          
          if (uploadId && partNumberParam) {
            // Upload a single part of a multipart upload
            const partNumber = parseInt(partNumberParam, 10);
            console.error(`Uploading part ${partNumber} for uploadId ${uploadId}`);
            
            if (!request.body) {
              return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>MissingRequestBodyError</Code>
    <Message>Request body is empty</Message>
    <RequestId>${this.ctx.id.toString()}</RequestId>
    <HostId>${this.ctx.id.toString()}</HostId>
</Error>`, { 
                status: 400,
                headers: {
                  "Content-Type": "application/xml",
                  "x-amz-request-id": this.ctx.id.toString(),
                }
              });
            }
            
            // Validate part number (AWS S3 allows 1-10000)
            if (partNumber < 1 || partNumber > 10000) {
              return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>InvalidArgument</Code>
    <Message>Part number must be an integer between 1 and 10000, inclusive</Message>
    <ArgumentName>partNumber</ArgumentName>
    <ArgumentValue>${partNumber}</ArgumentValue>
    <RequestId>${this.ctx.id.toString()}</RequestId>
    <HostId>${this.ctx.id.toString()}</HostId>
</Error>`, {
                status: 400,
                headers: {
                  "Content-Type": "application/xml",
                  "x-amz-request-id": this.ctx.id.toString(),
                }
              });
            }
            
            try {
              const multipartUpload = bucketToUse.resumeMultipartUpload(pathWithoutLeadingSlash, uploadId);
              const uploadedPart = await multipartUpload.uploadPart(partNumber, request.body as any);
              
              console.error(`Part ${partNumber} uploaded successfully, etag: ${uploadedPart.etag}`);
              
              return new Response(null, {
                status: 200,
                headers: {
                  "ETag": `"${uploadedPart.etag}"`,
                  "x-amz-request-id": this.ctx.id.toString(),
                }
              });
            } catch (error: any) {
              console.error(`Failed to upload part ${partNumber}:`, error);
              return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>InternalError</Code>
    <Message>Failed to upload part: ${String(error)}</Message>
    <RequestId>${this.ctx.id.toString()}</RequestId>
    <HostId>${this.ctx.id.toString()}</HostId>
</Error>`, {
                status: 500,
                headers: {
                  "Content-Type": "application/xml",
                  "x-amz-request-id": this.ctx.id.toString(),
                }
              });
            }
          }
          
          // Standard single-part PUT
          // Extract MD5 from Content-MD5 header if provided
          const md5Header = request.headers.get("Content-MD5");
          const contentLengthHeader = request.headers.get("Content-Length");
          const contentLength = contentLengthHeader ? parseInt(contentLengthHeader) : 0;
          
          // Use multipart upload for files larger than 50MB
          const MULTIPART_THRESHOLD = 50 * 1024 * 1024; // 50MB
          
          if (contentLength > MULTIPART_THRESHOLD) {
            console.error(`Large upload detected (${(contentLength / (1024 * 1024)).toFixed(2)} MB), using multipart upload`);
            return await this.handleLargeUpload(
              bucketToUse,
              pathWithoutLeadingSlash,
              request.body,
              contentLength,
              md5Header
            );
          }
          
          // Standard upload for smaller files
          const putOptions: any = {};
          
          if (md5Header) {
            putOptions.customMetadata = { md5: md5Header };
          }
          
          const obj = await bucketToUse.put(
            pathWithoutLeadingSlash, 
            request.body as unknown as ArrayBuffer,
            putOptions
          );
          if (!obj) return new Response("Not found", { status: 404 });
          return new Response(null, {
            status: 204,
            headers: {
              "ETag": `"${obj.etag}"`,
              "x-amz-request-id": this.ctx.id.toString(),
            },
          });
        }
        case "DELETE": {
          // AWS S3 AbortMultipartUpload: DELETE /key?uploadId=ID
          const uploadId = url.searchParams.get("uploadId");
          
          if (uploadId) {
            // Abort a multipart upload
            console.error(`Aborting multipart upload ${uploadId} for ${pathWithoutLeadingSlash}`);
            
            try {
              const multipartUpload = bucketToUse.resumeMultipartUpload(pathWithoutLeadingSlash, uploadId);
              await multipartUpload.abort();
              
              console.error(`Multipart upload ${uploadId} aborted successfully`);
              
              // S3 returns 204 No Content on successful abort
              return new Response(null, { 
                status: 204,
                headers: {
                  "x-amz-request-id": this.ctx.id.toString(),
                }
              });
            } catch (error: any) {
              console.error(`Failed to abort multipart upload ${uploadId}:`, error);
              return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>NoSuchUpload</Code>
    <Message>The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.</Message>
    <UploadId>${uploadId}</UploadId>
    <RequestId>${this.ctx.id.toString()}</RequestId>
    <HostId>${this.ctx.id.toString()}</HostId>
</Error>`, {
                status: 404,
                headers: {
                  "Content-Type": "application/xml",
                  "x-amz-request-id": this.ctx.id.toString(),
                }
              });
            }
          }
          
          // Standard DELETE for object
          // Check if object exists first (optional, but allows for proper error messages)
          const exists = await bucketToUse.head(pathWithoutLeadingSlash);
          if (!exists) {
            // AWS S3 is idempotent - returns 204 even if object doesn't exist
            return new Response(null, { 
              status: 204,
              headers: {
                "x-amz-request-id": this.ctx.id.toString(),
              }
            });
          }
          
          // Delete the object
          await bucketToUse.delete(pathWithoutLeadingSlash);
          
          // S3 returns 204 No Content on successful deletion
          return new Response(null, { 
            status: 204,
            headers: {
              "x-amz-request-id": this.ctx.id.toString(),
            }
          });
        }
        default:
          return new Response("Method not allowed", { status: 405 });
      }
    }

    /**
     * Handle large file uploads using R2 multipart upload API
     * Transparently chunks the upload into parts for better reliability
     */
    private async handleLargeUpload(
      bucket: any,
      key: string,
      body: ReadableStream | null,
      contentLength: number,
      md5Header: string | null
    ): Promise<Response> {
      if (!body) {
        return new Response("Missing request body", { status: 400 });
      }

      try {
        // Create multipart upload
        console.error(`Creating multipart upload for ${key}`);
        const multipartUpload = await bucket.createMultipartUpload(key, {
          customMetadata: md5Header ? { md5: md5Header } : undefined,
        });
        
        console.error(`Multipart upload created with uploadId: ${multipartUpload.uploadId}`);

        // Part size: 10MB (5MB is minimum, using 10MB as recommended)
        const PART_SIZE = 10 * 1024 * 1024;
        const uploadedParts: R2UploadedPart[] = [];
        
        // Read body stream and upload in chunks
        const reader = body.getReader();
        let partNumber = 1;
        let buffer = new Uint8Array(0);
        let totalUploaded = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            
            // Append new data to buffer
            if (value) {
              const newBuffer = new Uint8Array(buffer.length + value.length);
              newBuffer.set(buffer);
              newBuffer.set(value, buffer.length);
              buffer = newBuffer;
            }

            // Upload part if we have enough data or this is the last part
            const shouldUpload = buffer.length >= PART_SIZE || (done && buffer.length > 0);
            
            if (shouldUpload) {
              const partData = buffer;
              console.error(`Uploading part ${partNumber} (${(partData.length / (1024 * 1024)).toFixed(2)} MB)`);
              
              const uploadedPart = await multipartUpload.uploadPart(partNumber, partData);
              uploadedParts.push(uploadedPart);
              
              totalUploaded += partData.length;
              console.error(`Part ${partNumber} uploaded successfully. Total: ${(totalUploaded / (1024 * 1024)).toFixed(2)} MB / ${(contentLength / (1024 * 1024)).toFixed(2)} MB`);
              
              partNumber++;
              buffer = new Uint8Array(0);
            }

            if (done) break;
          }

          // Complete the multipart upload
          console.error(`Completing multipart upload with ${uploadedParts.length} parts`);
          const object = await multipartUpload.complete(uploadedParts);
          
          console.error(`Multipart upload completed successfully: ${key}`);
          
          return new Response(null, {
            status: 204,
            headers: {
              "ETag": `"${object.etag}"`,
              "x-amz-request-id": this.ctx.id.toString(),
            },
          });

        } catch (error) {
          // If upload fails, abort the multipart upload to clean up
          console.error("Multipart upload failed, aborting:", error);
          try {
            await multipartUpload.abort();
            console.error("Multipart upload aborted");
          } catch (abortError) {
            console.error("Failed to abort multipart upload:", abortError);
          }
          throw error;
        } finally {
          reader.releaseLock();
        }

      } catch (error: any) {
        console.error("Failed to handle large upload:", error);
        return new Response(
          `Multipart upload failed: ${error.message}`,
          { status: 500 }
        );
      }
    }

    // Initialize HTTP Proxy connection with infinite retry loop
    private async initHTTPProxy(): Promise<void> {
      console.error("Initializing HTTP Proxy connection");
      // Check if a loop is already running
      if (this.httpProxyLoopPromise) {
        console.error("HTTP Proxy loop already running, returning existing promise");
        return this.httpProxyLoopPromise;
      }
      
      // Reset stop flag and create new loop promise
      this.httpProxyLoopShouldStop = false;
      
      this.httpProxyLoopPromise = (async () => {
        console.error("Starting HTTP Proxy connection loop...");
        
        try {
          while (true) {
            console.error("HTTP Proxy loop iteration");
            try {
              const status = await this.getStatus();
              
              // Exit loop if stop requested or container is stopping/stopped
              if (this.httpProxyLoopShouldStop) {
                console.error("HTTP Proxy loop stop requested, exiting...");
                break;
              }
              
              if (status === 'stopping' || status === 'stopped') {
                console.error("Container stopping/stopped, exiting HTTP Proxy loop");
                break;
              }
              
              // Only attempt connection if container is running
              if (status !== 'running') {
                console.error("Container not running yet, waiting before HTTP Proxy connection...");
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
              }
              
              console.error("Initializing HTTP Proxy connection...");
              this.httpProxyControl = new HTTPProxyControl(this.ctx, () => this.getStatus(), (r) => this.fetchFromR2(r));
              
              
              await this.httpProxyControl.connect();
              console.error("HTTP Proxy connected successfully");
              
              // Wait for disconnection (this will throw when connection is lost)
              await this.httpProxyControl.waitForDisconnect();
              console.error("HTTP Proxy disconnected");
              // wait for 1 second before trying again
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
              console.error("HTTP Proxy error:", error);
              
              // Clean up current connection
              if (this.httpProxyControl) {
                try {
                  await this.httpProxyControl.disconnect();
                } catch (e) {
                  console.error("Error during proxy cleanup:", e);
                }
                this.httpProxyControl = null;
              }
              
              // Check if we should continue trying
              if (this.httpProxyLoopShouldStop) {
                console.error("HTTP Proxy loop stop requested, exiting...");
                break;
              }
              
              const status = await this.getStatus();
              if (status === 'stopping' || status === 'stopped') {
                console.error("Container stopped, exiting HTTP Proxy loop");
                break;
              }
              
              // Wait before reconnecting
              console.error("Reconnecting HTTP Proxy in 5 seconds...");
              await new Promise(resolve => setTimeout(resolve, 5000));
            }
          }
        } finally {
          // Clean up when loop exits
          console.error("HTTP Proxy loop exited, cleaning up...");
          this.httpProxyLoopPromise = null;
          this.httpProxyLoopShouldStop = false;
        }
      })();
      
      return this.httpProxyLoopPromise;
    }

    // Disconnect HTTP Proxy
    private async disconnectHTTPProxy() {
      if (this.httpProxyControl) {
        await this.httpProxyControl.disconnect();
        this.httpProxyControl = null;
      }
    }
}

// Control channel messages
type ControlMessage = 
  | { type: "allocate_channel"; requestId: string; port: number }
  | { type: "channel_allocated"; requestId: string; port: number }
  | { type: "channel_released"; port: number }
  | { type: "error"; requestId: string; message: string }
  | { type: "heartbeat"; ts?: number };

interface DataChannelState {
  port: number;
  socket: any | null; // Cloudflare TCP Socket
  reader: ReadableStreamDefaultReader | null;
  writer: WritableStreamDefaultWriter | null;
  inUse: boolean;
}

/**
 * HTTP Proxy Control Manager
 * Manages control channel and data channel pool for HTTP proxy
 */
class HTTPProxyControl {
  private controlSocket: CloudflareTCPSocket | null = null;
  private controlWriter: WritableStreamDefaultWriter | null = null;
  private controlReader: ReadableStreamDefaultReader | null = null;
  private controlBuffer: Buffer = Buffer.alloc(0);
  private dataChannels: Map<number, DataChannelState> = new Map();
  private isConnected = false;
  private disconnectPromise: Promise<void> | null = null;
  private disconnectResolve: (() => void) | null = null;
  private disconnectReject: ((error: Error) => void) | null = null;
  private lastHeartbeatAt: number = 0;
  private heartbeatWatchdogInterval: Promise<void> | null = null;
  
  private CONTROL_PORT = 8084;
  private DATA_PORT_START = 8085;
  private DATA_PORT_END = 8109;

  constructor(
    private ctx: DurableObject['ctx'],
    private stateProvider: () => Promise<'running' | 'stopping' | 'stopped' | 'starting'>,
    private fetchImplementation: (request: Request) => Promise<Response>
  ) {}

  private get container() {
    return this.ctx.container;
  }

  private waitUntil(promise: Promise<void>, description: string): void {
    return this.ctx.waitUntil(promise.then(() => {
      console.error("Wait until promise resolved", description);
    }).catch((error) => {
      console.error("Wait until promise rejected:" + description, error);
    }));
  }

  async connect(): Promise<void> {
    const state = await this.stateProvider();
    
    // Always initialize disconnect promise so waitForDisconnect() doesn't fail
    this.disconnectPromise = new Promise<void>((resolve, reject) => {
      this.disconnectResolve = resolve;
      this.disconnectReject = reject;
    });
    
    if (state !== 'running') {
      console.error("Container not running, skipping HTTP Proxy connection");
      // Resolve immediately so waitForDisconnect() returns
      if (this.disconnectResolve) {
        this.disconnectResolve();
      }
      throw new Error("Container not running");
    }

    try {
      // Connect control channel
      await this.connectControlChannel();
      console.error("HTTP Proxy control channel connected");
      
      // Connect data channels
      await this.connectDataChannels();
      console.error("HTTP Proxy data channels connected");
    } catch (error) {
      console.error("Failed to connect HTTP Proxy:", error);
      // Signal disconnection on error
      if (this.disconnectResolve) {
        this.disconnectResolve();
      }
      throw error;
    }
  }

  async waitForDisconnect(): Promise<void> {
    if (!this.disconnectPromise) {
      throw new Error("Not connected");
    }
    return this.disconnectPromise;
  }

  private async connectControlChannel() {
    const port = this.container?.getTcpPort(this.CONTROL_PORT);
    if (!port) {
      throw new Error("Failed to get control channel TCP port");
    }

    console.error("Connecting to control channel on port", this.CONTROL_PORT);
    
    // Retry connection with exponential backoff (deployed containers start slower)
    let lastError: Error | null = null;
    const maxRetries = 10;
    const retryDelays = [500, 1000, 2000, 3000, 5000, 5000, 5000, 5000, 5000, 5000]; // ms
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.error(`Control channel connection attempt ${attempt + 1}/${maxRetries} after ${retryDelays[attempt - 1]}ms delay`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt - 1]));
        }
        
        this.controlSocket = port.connect(`localhost:${this.CONTROL_PORT}`);
        const socketInfo = await this.controlSocket.opened;
        this.ctx.waitUntil(this.controlSocket.closed.then(async () => {
          const status = await this.stateProvider();
          console.error("Control channel socket closed " + JSON.stringify(status));
        }));
        console.error("Control channel socket opened", socketInfo);
        this.isConnected = true;
        
        this.controlWriter = this.controlSocket.writable.getWriter();
        this.controlReader = this.controlSocket.readable.getReader();
        
        // Start reading control messages
        this.waitUntil(this.readControlMessages(), "readControlMessages");
        // Start heartbeat watchdog
        this.waitUntil(this.startHeartbeatWatchdog(), "startHeartbeatWatchdog");
        
        console.error("Control channel connected successfully");
        return; // Success!
      } catch (error) {
        lastError = error as Error;
        console.error(`Control channel connection attempt ${attempt + 1}/${maxRetries} failed:`, error);
        // Clean up on failure
        this.controlReader = null;
        this.controlWriter = null;
        this.controlSocket = null;
        
        // Check if we should continue retrying
        const status = await this.stateProvider();
        if (status === 'stopping' || status === 'stopped') {
          console.error("Container stopped, aborting control channel connection");
          throw new Error("Container stopped during connection");
        }
      }
    }
    
    // All retries exhausted
    console.error("Failed to connect control channel after", maxRetries, "attempts");
    throw lastError || new Error("Failed to connect control channel");
  }

  private async connectDataChannels() {
    console.error(`Connecting data channels ${this.DATA_PORT_START}-${this.DATA_PORT_END}...`);
    
    for (let portNum = this.DATA_PORT_START; portNum <= this.DATA_PORT_END; portNum++) {
      this.dataChannels.set(portNum, {
        port: portNum,
        socket: null,
        reader: null,
        writer: null,
        inUse: false,
      });
    }
    
    console.error(`${this.dataChannels.size} data channels initialized`);
  }

  private async readControlMessages() {
    console.error("Reading control messages");
    if (!this.controlReader) {
      console.error("Control reader not available");
      return;
    }

    try {
      while (this.isConnected && this.controlReader) {
        console.error("Reading control message stream");
        const { done, value } = await this.controlReader.read();
        if (done) {
          console.error("Control channel closed");
          this.handleDisconnect();
          return;
        }


        // Append incoming bytes to rolling buffer
        const incoming = Buffer.from(value);
        this.controlBuffer = Buffer.concat([this.controlBuffer, incoming]);
        console.error("Got control message stream", incoming.byteLength, this.controlBuffer.byteLength);

        // Extract as many complete frames as available
        while (true) {
          if (this.controlBuffer.length < 4) {
            // Not enough data to know frame length yet
            break;
          }

          const frameLength = this.controlBuffer.readUInt32LE(0);
          const totalFrameSize = 4 + frameLength;

          if (this.controlBuffer.length < totalFrameSize) {
            // Incomplete frame, wait for more data
            break;
          }

          // Slice out this complete frame and advance buffer
          const frame = this.controlBuffer.slice(0, totalFrameSize);
          this.controlBuffer = this.controlBuffer.slice(totalFrameSize);

          const message = this.parseControlMessage(frame);
          if (message) {
            await this.handleControlMessage(message);
          } else {
            console.error("Failed to parse control message frame; skipping");
          }
        }
      }
    } catch (error) {
      console.error("Error reading control messages:", error);
      // Ignore errors if we're already disconnecting
      if (this.isConnected) {
        console.error("Error reading control messages:", error);
      }
      this.handleDisconnect();
    }
    console.error("Control messages read", !!this.isConnected, !!this.controlReader);
  }

  private parseControlMessage(data: Buffer): ControlMessage | null {
    //console.debug("Parsing control message:", data);
    try {
      if (data.length < 4) return null;
      
      const length = data.readUInt32LE(0);
      if (data.length < 4 + length) return null;
      
      const jsonData = data.slice(4, 4 + length);
      const jsonText = jsonData.toString('utf-8');
      //console.debug("Parsed control message:", jsonText);
      return JSON.parse(jsonText) as ControlMessage;
    } catch (error) {
      console.error("Failed to parse control message:", error);
      return null;
    }
  }

  private async handleControlMessage(message: ControlMessage) {
    console.error("Received control message:", message);
    switch (message.type) {
      case "allocate_channel":
        await this.handleChannelAllocation(message.requestId, message.port);
        break;
        
      case "channel_released":
        await this.releaseChannel(message.port);
        break;
      case "heartbeat":
        // Update heartbeat timestamp
        this.lastHeartbeatAt = Date.now();
        break;
      default:
        console.error("Unknown control message type:", message.type);
        break;
    }
  }

  private async handleChannelAllocation(requestId: string, port: number) {
    console.error("Handling channel allocation for:", requestId, "on port:", port);
    try {
      // Use the port specified by http-proxy.ts
      const channel = this.dataChannels.get(port);
      
      if (!channel) {
        console.error("Requested channel not found:", port);
        await this.sendControlMessage({
          type: "error",
          requestId,
          message: "Requested channel not found",
        });
        return;
      }
      
      if (channel.inUse) {
        console.error("Requested channel already in use:", port);
        await this.sendControlMessage({
          type: "error",
          requestId,
          message: "Requested channel already in use",
        });
        return;
      }

      // Mark as in use
      channel.inUse = true;
      
      // Connect to the data channel
      await this.connectDataChannel(channel);
      
      // Send allocation response
      await this.sendControlMessage({
        type: "channel_allocated",
        requestId,
        port: channel.port,
      });
      
      // Handle the HTTP request/response on this channel
      this.waitUntil(this.handleDataChannel(channel), "handleDataChannel");
      
    } catch (error) {
      console.error(`Failed to allocate channel for ${requestId}:`, error);
      await this.sendControlMessage({
        type: "error",
        requestId,
        message: String(error),
      });
    }
  }

  private async connectDataChannel(channel: DataChannelState) {
    const port = this.container?.getTcpPort(channel.port);
    if (!port) {
      console.error("Failed to get TCP port", channel.port);
      throw new Error(`Failed to get TCP port ${channel.port}`);
    }

    console.error(`Connecting to data channel on port ${channel.port}`);
    channel.socket = port.connect(`localhost:${channel.port}`);
    await channel.socket.opened;
    
    channel.writer = channel.socket.writable.getWriter();
    channel.reader = channel.socket.readable.getReader();
    
    console.error(`Data channel ${channel.port} connected`);
  }

  private async handleDataChannel(channel: DataChannelState) {
    // Keep-alive loop: handle multiple requests on the same channel
    while (channel.socket && channel.reader && channel.writer) {
      try {
        // Read HTTP request from the data channel
        const request = await this.readHTTPRequest(channel);
        
        // Make the actual fetch request
        console.error(`Proxying ${request.method} ${request.url}`);
        const response = await this.fetchImplementation(request);
        
        // Send HTTP response back to the data channel
        await this.sendHTTPResponse(channel, response);
        
        // Successfully completed request - loop to handle next one
        console.error(`Data channel ${channel.port} ready for next request`);
        
      } catch (error) {
        console.error(`Error handling data channel ${channel.port}:`, error);
        
        // Check if it's a socket closure (normal end of keep-alive)
        const errorMessage = String(error);
        if (errorMessage.includes("closed") || errorMessage.includes("EOF") || errorMessage.includes("done")) {
          console.error(`Data channel ${channel.port} closed gracefully, exiting loop`);
          break;
        }
        
        // Try to send error response
        try {
          await this.sendErrorResponse(channel, errorMessage);
        } catch (e) {
          console.error("Failed to send error response:", e);
          break; // Exit loop if we can't send error
        }
        
        // On error, close the channel and exit loop
        break;
      }
    }
    
    // Clean up when exiting loop
    await this.closeDataChannel(channel);
  }

  private async readHTTPRequest(channel: DataChannelState): Promise<Request> {
    //console.debug("Reading HTTP request from data channel:", channel.port);
    if (!channel.reader) {
      console.error("Channel reader not available");
      throw new Error("Channel reader not available");
    }

    let buffer = Buffer.alloc(0);
    let headersParsed = false;
    let method = "GET";
    let url = "";
    let headers = new Headers();
    let bodyChunks: Uint8Array[] = [];
    let contentLength: number | null = null;
    let isChunked = false;
    let bodyReceived = 0;

    while (true) {
      const { done, value } = await channel.reader.read();
      
      if (done) {
        // Stream closed - if we haven't parsed headers yet, this is an error
        if (!headersParsed) {
          throw new Error("Connection closed before receiving complete request");
        }
        break;
      }

      const chunk = Buffer.from(value);
      buffer = Buffer.concat([buffer, chunk]);

      if (!headersParsed) {
        // Look for end of headers (\r\n\r\n)
        const headerEnd = buffer.indexOf('\r\n\r\n');
        
        if (headerEnd !== -1) {
          const headerText = buffer.slice(0, headerEnd).toString('utf-8');
          const lines = headerText.split('\r\n');
          
          // Parse request line
          const requestLine = lines[0];
          const [reqMethod, path] = requestLine.split(' ');
          method = reqMethod;
          
          // Parse headers to get Host
          let host = 'localhost';
          for (let i = 1; i < lines.length; i++) {
            const colonIndex = lines[i].indexOf(':');
            if (colonIndex > 0) {
              const key = lines[i].slice(0, colonIndex).trim().toLowerCase();
              const value = lines[i].slice(colonIndex + 1).trim();
              headers.set(key, value);
              
              if (key === 'host') {
                host = value;
              }
              if (key === 'content-length') {
                contentLength = parseInt(value);
              }
              if (key === 'transfer-encoding' && value.toLowerCase().includes('chunked')) {
                isChunked = true;
              }
            }
          }
          
          // Construct full URL. We don't use the protocol from the request because we want to force HTTPS.
          const protocol = 'https';
          url = `${protocol}://${host}${path}`;
          
          headersParsed = true;
          
          // Remaining data is body
          const bodyStart = headerEnd + 4;
          if (bodyStart < buffer.length) {
            const bodyData = buffer.slice(bodyStart);
            bodyChunks.push(bodyData);
            bodyReceived += bodyData.length;
          }
          
          buffer = Buffer.alloc(0);
          
          // Check if we're done reading the body
          if (this.isRequestBodyComplete(contentLength, bodyReceived, isChunked, bodyChunks)) {
            break;
          }
        }
      } else {
        // Collecting body
        bodyChunks.push(buffer);
        bodyReceived += buffer.length;
        buffer = Buffer.alloc(0);
        
        // Check if we're done reading the body
        if (this.isRequestBodyComplete(contentLength, bodyReceived, isChunked, bodyChunks)) {
          break;
        }
      }
    }

    // Decode body if needed
    let body: Buffer | null = null;
    if (bodyChunks.length > 0) {
      const combinedChunks = Buffer.concat(bodyChunks);
      
      if (isChunked) {
        // Decode chunked encoding
        body = this.decodeChunkedBody(combinedChunks);
        console.error(`Decoded chunked body: ${body.length} bytes`);
      } else {
        body = combinedChunks;
      }
    }

    return new Request(url, {
      method,
      headers,
      // @ts-expect-error
      body: body || undefined,
    });
  }

  private isRequestBodyComplete(
    contentLength: number | null,
    bodyReceived: number,
    isChunked: boolean,
    bodyChunks: Uint8Array[]
  ): boolean {
    // If we have content-length, check if we've received enough
    if (contentLength !== null && bodyReceived >= contentLength) {
      return true;
    }
    
    // If chunked, look for the terminator
    if (isChunked && bodyChunks.length > 0) {
      const lastChunk = bodyChunks[bodyChunks.length - 1];
      const lastBytes = lastChunk.slice(-5);
      // @ts-expect-error
      const text = lastBytes.toString('utf-8');
      if (text.includes('0\r\n\r\n')) {
        return true;
      }
    }
    
    // If no content-length and not chunked, we have no body
    if (contentLength === null && !isChunked) {
      return true;
    }
    
    return false;
  }

  private decodeChunkedBody(encoded: Buffer): Buffer {
    const decodedChunks: Buffer[] = [];
    let pos = 0;
    
    while (pos < encoded.length) {
      // Find the chunk size line (ends with \r\n)
      let lineEnd = pos;
      while (lineEnd < encoded.length - 1) {
        if (encoded[lineEnd] === 0x0d && encoded[lineEnd + 1] === 0x0a) {
          break;
        }
        lineEnd++;
      }
      
      if (lineEnd >= encoded.length - 1) break;
      
      const sizeLine = encoded.slice(pos, lineEnd).toString('utf-8');
      const chunkSize = parseInt(sizeLine.split(';')[0].trim(), 16);
      
      if (chunkSize === 0) {
        // Last chunk
        break;
      }
      
      pos = lineEnd + 2; // Skip \r\n
      
      if (pos + chunkSize <= encoded.length) {
        decodedChunks.push(encoded.slice(pos, pos + chunkSize));
        pos += chunkSize + 2; // Skip chunk data and trailing \r\n
      } else {
        break;
      }
    }
    
    return decodedChunks.length > 0 ? Buffer.concat(decodedChunks) : Buffer.alloc(0);
  }

  private async sendHTTPResponse(channel: DataChannelState, response: Response) {
    if (!channel.writer) {
      throw new Error("Channel writer not available");
    }

    // Status line
    const statusLine = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
    await channel.writer.write(new TextEncoder().encode(statusLine));

    // Headers
    let hasContentLength = false;
    let hasTransferEncodingChunked = false;
    for (const [key, value] of (response as unknown as CloudflareResponse).headers.entries()) {
      const headerLine = `${key}: ${value}\r\n`;
      await channel.writer.write(new TextEncoder().encode(headerLine));
      const lower = key.toLowerCase();
      if (lower === 'content-length') hasContentLength = true;
      if (lower === 'transfer-encoding' && value.toLowerCase().includes('chunked')) hasTransferEncodingChunked = true;
    }

    // If no body and no content-length, explicitly write zero content length
    if (!response.body && !hasContentLength) {
      await channel.writer.write(new TextEncoder().encode(`Content-Length: 0\r\n`));
    }

    // Decide whether to use chunked encoding for body
    let useChunkedEncoding = false;
    if (response.body && !hasContentLength && !hasTransferEncodingChunked) {
      await channel.writer.write(new TextEncoder().encode(`Transfer-Encoding: chunked\r\n`));
      useChunkedEncoding = true;
    }

    // End headers
    await channel.writer.write(new TextEncoder().encode('\r\n'));

    // Body
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (useChunkedEncoding) {
            await channel.writer.write(new TextEncoder().encode(value.length.toString(16) + "\r\n"));
            await channel.writer.write(value);
            await channel.writer.write(new TextEncoder().encode("\r\n"));
          } else {
            await channel.writer.write(value);
          }
        }
        if (useChunkedEncoding) {
          await channel.writer.write(new TextEncoder().encode("0\r\n\r\n"));
        }
      } finally {
        reader.releaseLock();
      }
    }
  }

  private async sendErrorResponse(channel: DataChannelState, error: string) {
    console.error("Sending error response:", error);
    if (!channel.writer) return;

    const errorBody = `Proxy Error: ${error}`;
    const statusLine = `HTTP/1.1 502 Bad Gateway\r\n`;
    const headers = `Content-Type: text/plain\r\nContent-Length: ${errorBody.length}\r\n\r\n`;
    
    await channel.writer.write(new TextEncoder().encode(statusLine + headers + errorBody));
  }

  private async closeDataChannel(channel: DataChannelState) {
    console.error("Closing data channel:", channel.port);
    try {
      if (channel.reader) {
        await channel.reader.cancel();
        channel.reader.releaseLock();
        channel.reader = null;
      }
      
      if (channel.writer) {
        await channel.writer.close();
        channel.writer = null;
      }
      
      if (channel.socket) {
        await channel.socket.close();
        channel.socket = null;
      }
      
      channel.inUse = false;
      
      //console.debug(`Data channel ${channel.port} closed`);
    } catch (error) {
      console.error(`Error closing data channel ${channel.port}:`, error);
    }
  }

  private async releaseChannel(port: number) {
    const channel = this.dataChannels.get(port);
    if (channel) {
      await this.closeDataChannel(channel);
    }
  }

  private async sendControlMessage(message: ControlMessage): Promise<void> {
    console.error("Sending control message:", message);
    if (!this.controlWriter) {
      console.warn("Cannot send control message, writer not available");
      return;
    }

    try {
      const json = JSON.stringify(message);
      const jsonBytes = Buffer.from(json, 'utf-8');
      
      // Length-prefixed message
      const buffer = Buffer.alloc(4 + jsonBytes.length);
      buffer.writeUInt32LE(jsonBytes.length, 0);
      jsonBytes.copy(buffer, 4);
      
      await this.controlWriter.write(new Uint8Array(buffer));
    } catch (error) {
      console.error("Failed to send control message:", error);
    }
  }

  private handleDisconnect() {
    this.isConnected = false;
    this.stopHeartbeatWatchdog();
    
    // Signal disconnection to the infinite retry loop
    if (this.disconnectResolve) {
      this.disconnectResolve();
      this.disconnectResolve = null;
      this.disconnectReject = null;
    }
  }

  async disconnect() {
    console.error("Disconnecting HTTP Proxy");
    this.stopHeartbeatWatchdog();
    // Close all data channels
    for (const channel of this.dataChannels.values()) {
      await this.closeDataChannel(channel);
    }

    // Close control channel
    try {
      if (this.controlReader) {
        await this.controlReader.cancel();
        this.controlReader.releaseLock();
        this.controlReader = null;
      }
      
      if (this.controlWriter) {
        await this.controlWriter.close();
        this.controlWriter = null;
      }
      
      if (this.controlSocket) {
        await this.controlSocket.close();
        this.controlSocket = null;
      }
    } catch (error) {
      console.error("Error disconnecting HTTP Proxy:", error);
    }

    this.isConnected = false;
    
    // Clean up disconnect promise
    if (this.disconnectResolve) {
      this.disconnectResolve();
      this.disconnectResolve = null;
      this.disconnectReject = null;
    }
    this.disconnectPromise = null;
  }

  private async startHeartbeatWatchdog() {
    if (this.heartbeatWatchdogInterval !== null) {
      console.error("Control heartbeat watchdog already running, stopping");
      return;
    };
    let thisPromise = new Promise<void>(async (resolve) => {
      const startedAt = Date.now();
      let lastNow = Date.now();
      try{
        while(true) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          if(this.heartbeatWatchdogInterval !== thisPromise) {
            console.error("Heartbeat watchdog interval changed, stopping");
            return;
          }
          const status = await this.stateProvider();
          if(status !== 'running') {
            console.error("Container not running, stopping control heartbeat watchdog");
            return;
          }

          console.error("Running control heartbeat watchdog");
          try {
            const now = Date.now();
            console.error(`Heartbeat watchdog check ${now - lastNow}ms ${now}, ${lastNow}, ${this.lastHeartbeatAt}`);
            const elapsed = now - this.lastHeartbeatAt;
            const timeSinceStarted = now - startedAt;
            lastNow = now;
            if (elapsed > 20000 && timeSinceStarted > 10000) {
              console.error("No control heartbeat for", elapsed, "ms; closing control channel to trigger reconnect");
              // Force close only the control channel; reconnect loop will re-establish
              await this.forceCloseControlChannel();

            }
          } catch (e) {
            console.error("Heartbeat watchdog error:", e);
          }
        }
      } finally {
        console.error("Heartbeat watchdog exiting");
        this.heartbeatWatchdogInterval = null;
        resolve();
      }
    });
    this.heartbeatWatchdogInterval = thisPromise;
    return thisPromise;
  }

  private stopHeartbeatWatchdog() {
    if (this.heartbeatWatchdogInterval !== null) {
      this.heartbeatWatchdogInterval = null;
      console.error("Stopped control heartbeat watchdog");
    }
  }

  private async forceCloseControlChannel() {
    try {
      if (this.controlReader) {
        try {
          await this.controlReader.cancel();
          this.controlReader.releaseLock();
        } catch (e) {
          console.error("Error while canceling control reader:", e);
        }
        this.controlReader = null;
      }
      if (this.controlWriter) {
        try {
          await this.controlWriter.close();
        } catch (e) {
          console.error("Error while closing control writer:", e);
        }
        this.controlWriter = null;
      }
      if (this.controlSocket) {
        try {
          await this.controlSocket.close();
        } catch (e) {
          console.error("Error while closing control socket:", e);
        }
        this.controlSocket = null;
      }
    } catch (e) {
      console.error("Error while force-closing control channel:", e);
    } finally {
      this.handleDisconnect();
    }
  }
}

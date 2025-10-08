// =====================
// Auth crypto helpers
// =====================

import Elysia from "elysia";
import { getNodeEnv } from "../client/utils/node-env";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import cors from "@elysiajs/cors";
import { getMinecraftContainer } from "./get-minecraft-container";

const AUTH_COOKIE_NAME = 'mf_auth';
const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  const b64 = btoa(str);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

async function encryptToken(symKeyB64: string, payload: { n: string; exp: number }): Promise<string> {
  const keyBytes = base64urlDecode(symKeyB64);
  const keyBuf = new Uint8Array(keyBytes).buffer as ArrayBuffer;
  const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const enc = new TextEncoder();
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, enc.encode(JSON.stringify(payload)));
  return `v1.${base64urlEncode(iv)}.${base64urlEncode(cipherBuf)}`;
}

async function decryptToken(symKeyB64: string, token: string): Promise<{ n: string; exp: number } | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const iv = base64urlDecode(parts[1]);
    const cipher = base64urlDecode(parts[2]);
    const keyBytes = base64urlDecode(symKeyB64);
    const keyBuf = new Uint8Array(keyBytes).buffer as ArrayBuffer;
    const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-GCM' }, false, ['decrypt']);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv).buffer as ArrayBuffer }, key, new Uint8Array(cipher).buffer as ArrayBuffer);
    const plainText = new TextDecoder().decode(plainBuf);
    return JSON.parse(plainText);
  } catch {
    return null;
  }
}

function parseCookie(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      cookies[key] = val;
    }
  }
  return cookies;
}

function buildSetCookie(value: string, maxAge: number): string {
  const secureFlag = getNodeEnv() === 'production' ? 'Secure; ' : '';
  return `${AUTH_COOKIE_NAME}=${value}; HttpOnly; ${secureFlag}SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function buildClearCookie(): string {
  const secureFlag = getNodeEnv() === 'production' ? 'Secure; ' : '';
  return `${AUTH_COOKIE_NAME}=; HttpOnly; ${secureFlag}SameSite=Lax; Path=/; Max-Age=0`;
}

async function getPasswordSetCached(request: Request): Promise<boolean> {
  const cacheKeyReq = new Request(new URL('/__mf/password-set-v1', request.url).toString(), { method: 'GET' });
  
  // Try cache first
  const cache = await caches.open('mf-auth');
  const cached = await cache.match(cacheKeyReq);
  if (cached) {
    const text = await cached.text();
    return text === 'true';
  }
  
  // Fall back to Durable Object
  const container = getMinecraftContainer();
  const isPasswordSet = await container.isPasswordSet();
  
  // Seed the cache for future requests
  await cache.put(
    cacheKeyReq,
    new Response(isPasswordSet ? 'true' : 'false', {
      headers: {
        'Cache-Control': `max-age=${AUTH_COOKIE_MAX_AGE_SECONDS}`,
        'Content-Type': 'text/plain',
      },
    })
  );
  
  return isPasswordSet;
}

async function getSymKeyCached(request: Request): Promise<string | null> {
  const cacheKeyReq = new Request(new URL('/__mf/sym-key-v1', request.url).toString(), { method: 'GET' });
  
  // Try cache first
  const cache = await caches.open('mf-auth');
  const cached = await cache.match(cacheKeyReq);
  if (cached) {
    return await cached.text();
  }
  
  // Fall back to Durable Object
  const container = getMinecraftContainer();
  const { symKey } = await container.getSymmetricKey();
  if (!symKey) return null;
  
  // Seed the cache for future requests
  await cache.put(
    cacheKeyReq,
    new Response(symKey, {
      headers: {
        'Cache-Control': `max-age=${AUTH_COOKIE_MAX_AGE_SECONDS}`,
        'Content-Type': 'text/plain',
      },
    })
  );
  
  return symKey;
}

const corsHeaders = (request: Request): HeadersInit | null => {
    const origin = request.headers.get('Origin');
    if(getNodeEnv() === 'development' && origin) {
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Max-Age": "86400",
        } as const;
    }
    return null;
}

export async function requireAuth(request: Request): Promise<Response | null> {
  try {
    const symKey = await getSymKeyCached(request);
    if (!symKey) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { // need cors headers on these responses in development
            "Content-Type": "application/json",
            ...corsHeaders(request),
         }
      });
    }
    
    const cookies = parseCookie(request.headers.get('Cookie'));
    const token = cookies[AUTH_COOKIE_NAME];
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders(request) }
      });
    }
    
    const payload = await decryptToken(symKey, token);
    if (!payload || payload.exp <= Math.floor(Date.now() / 1000)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders(request) }
      });
    }
    
    return null; // Auth successful
  } catch (error) {
    console.error("Auth check failed", error);
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) }
    });
  }
}

// Create Elysia app with proper typing for Cloudflare Workers
export const authApp = (
  getNodeEnv() === 'development'
  ? new Elysia({
      adapter: CloudflareAdapter,
      // aot: false,
    }).use(cors({
        origin: /^http:\/\/localhost(:\d+)?$/,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
        credentials: true,
        maxAge: 86400,
    }))
  : new Elysia({
      adapter: CloudflareAdapter,
      // aot: false,
    })
  )
  
  // =====================
  // Auth endpoints (no auth required)
  // =====================
  
  /**
   * Check auth status: passwordSet and authenticated
   */
  .get("/status", async ({ request }: any) => {
    try {
      // Check passwordSet from cache (no DO wakeup!)
      const passwordSet = await getPasswordSetCached(request);
      
      // Check if user is authenticated via cookie
      let authenticated = false;
      if (passwordSet) {
        const symKey = await getSymKeyCached(request);
        if (symKey) {
          const cookies = parseCookie(request.headers.get('Cookie'));
          const token = cookies[AUTH_COOKIE_NAME];
          if (token) {
            const payload = await decryptToken(symKey, token);
            if (payload && payload.exp > Math.floor(Date.now() / 1000)) {
              authenticated = true;
            }
          }
        }
      }
      
      return { passwordSet, authenticated };
    } catch (error) {
      console.error("Failed to get auth status", error);
      return { passwordSet: false, authenticated: false };
    }
  })
  
  /**
   * Setup password (first time only)
   */
  .post("/setup", async ({ request, body }: any) => {
    try {
      const { password } = body as { password: string };
      if (!password || password.length < 8) {
        return new Response(JSON.stringify({ error: "Password must be at least 8 characters" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      const container = getMinecraftContainer();
      console.log("Calling setupPassword on container...");
      const result = await container.setupPassword({ password });
      console.log("setupPassword result:", result);
      
      if (!result.created) {
        console.log("Password already set, returning 409");
        return new Response(JSON.stringify({ error: "Password already set" }), {
          status: 409,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      console.log("Password created successfully, seeding cache...");
      // Seed cache with both the symmetric key and password-set status
      const cache = await caches.open('mf-auth');
      
      const symKeyCacheReq = new Request(new URL('/__mf/sym-key-v1', request.url).toString(), { method: 'GET' });
      await cache.put(
        symKeyCacheReq,
        new Response(result.symKey, {
          headers: {
            'Cache-Control': `max-age=${AUTH_COOKIE_MAX_AGE_SECONDS}`,
            'Content-Type': 'text/plain',
          },
        })
      );
      
      const passwordSetCacheReq = new Request(new URL('/__mf/password-set-v1', request.url).toString(), { method: 'GET' });
      await cache.put(
        passwordSetCacheReq,
        new Response('true', {
          headers: {
            'Cache-Control': `max-age=${AUTH_COOKIE_MAX_AGE_SECONDS}`,
            'Content-Type': 'text/plain',
          },
        })
      );
      
      // Create auth cookie
      const nonce = new Uint8Array(16);
      crypto.getRandomValues(nonce);
      const exp = Math.floor(Date.now() / 1000) + AUTH_COOKIE_MAX_AGE_SECONDS;
      const token = await encryptToken(result.symKey!, { n: base64urlEncode(nonce), exp });
      
      console.log("Setup complete, returning success with cookie");
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": buildSetCookie(token, AUTH_COOKIE_MAX_AGE_SECONDS)
        }
      });
    } catch (error) {
      console.error("Failed to setup password", error);
      return new Response(JSON.stringify({ error: "Failed to setup password" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  })
  
  /**
   * Login with password
   */
  .post("/login", async ({ request, body }: any) => {
    try {
      const { password } = body as { password: string };
      if (!password) {
        return new Response(JSON.stringify({ error: "Password required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      const container = getMinecraftContainer();
      const result = await container.verifyPassword({ password });
      
      if (!result.ok) {
        return new Response(JSON.stringify({ error: "Invalid password" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      // Get symmetric key (from cache or DO)
      const symKey = await getSymKeyCached(request);
      if (!symKey) {
        return new Response(JSON.stringify({ error: "Authentication not configured" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      // Create auth cookie
      const nonce = new Uint8Array(16);
      crypto.getRandomValues(nonce);
      const exp = Math.floor(Date.now() / 1000) + AUTH_COOKIE_MAX_AGE_SECONDS;
      const token = await encryptToken(symKey, { n: base64urlEncode(nonce), exp });
      
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": buildSetCookie(token, AUTH_COOKIE_MAX_AGE_SECONDS)
        }
      });
    } catch (error) {
      console.error("Failed to login", error);
      return new Response(JSON.stringify({ error: "Login failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  })
  
  /**
   * Logout (clear cookie)
   */
  .post("/logout", async () => {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildClearCookie()
      }
    });
  })

  /**
   * Get a short-lived WebSocket token (20 minutes)
   * Requires authentication via cookie
   */
  .get("/ws-token", async ({ request }: any) => {
    try {
      // Verify the user is authenticated via cookie first
      const symKey = await getSymKeyCached(request);
      if (!symKey) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      }
      
      const cookies = parseCookie(request.headers.get('Cookie'));
      const cookieToken = cookies[AUTH_COOKIE_NAME];
      if (!cookieToken) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      }
      
      const cookiePayload = await decryptToken(symKey, cookieToken);
      if (!cookiePayload || cookiePayload.exp <= Math.floor(Date.now() / 1000)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) }
        });
      }
      
      // Generate short-lived WebSocket token (20 minutes)
      const nonce = new Uint8Array(16);
      crypto.getRandomValues(nonce);
      const exp = Math.floor(Date.now() / 1000) + (20 * 60); // 20 minutes
      const wsToken = await encryptToken(symKey, { n: base64urlEncode(nonce), exp });
      
      return { token: wsToken };
    } catch (error) {
      console.error("Failed to generate WebSocket token", error);
      return new Response(JSON.stringify({ error: "Failed to generate token" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders(request) }
      });
    }
  })
  .compile()

// Export helpers for use in WebSocket validation
export { decryptToken, parseCookie, getSymKeyCached, base64urlEncode };

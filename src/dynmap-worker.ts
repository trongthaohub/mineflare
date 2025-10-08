import type { dynmapWorker } from "../alchemy.run";
import { WorkerEntrypoint } from "cloudflare:workers";

function stripLeadingSlash(path: string) {
    return path.startsWith("/") ? path.slice(1) : path;
}

export default class DynmapWorker extends WorkerEntrypoint<typeof dynmapWorker.Env> {

    async fetch(request: Request) {
        const url = new URL(request.url);
        if(url.pathname === "/") {
            url.pathname = "/index.html";
        } else if(this.env.BUCKET_DOMAIN && !url.pathname.startsWith("/tiles/")) {
            // redirect to /
            return Response.redirect(`https://${this.env.BUCKET_DOMAIN}${url.pathname}`, 302);
        }
        const obj = await this.env.DYNMAP_BUCKET.get(stripLeadingSlash(url.pathname));

        // Check if this is a tile request
        const isTileRequest = url.pathname.startsWith("/tiles/");

        // Common headers for iframe embedding
        const embedHeaders = {
            // Allow embedding from any Cloudflare Workers domain and localhost for dev
"Content-Security-Policy": `frame-ancestors 'self' ${this.env.MINECRAFT_WORKER_URL} http://localhost:* http://127.0.0.1:*`,
            // Explicitly allow embedding by setting X-Frame-Options to "ALLOWALL"
            "X-Frame-Options": "ALLOWALL",
        };

        if (!obj) {
            // handle HEAD
            if (request.method === "HEAD") {
                return new Response(null, { 
                    status: 200,
                    headers: embedHeaders
                });
            }
            const blankImage = await this.env.DYNMAP_BUCKET.get("images/blank.png");
            if (!blankImage) {
                return new Response("Not found", { 
                    status: 404,
                    headers: embedHeaders
                });
            }
            // add a cache control header for tiles (10s)
            return new Response(blankImage.body as unknown as ReadableStream, {
                headers: {
                    "Content-Type": "image/png",
                    // cache control for 10 seconds (tile caching)
                    "Cache-Control": "public, max-age=10",
                    ...embedHeaders
                }
            });
        }
        // handle HEAD with headers
        if (request.method === "HEAD") {
            return new Response(null, { status: 200, headers: {
                "Content-Type": obj.httpMetadata?.contentType ?? "text/html",
                ...(isTileRequest && { "Cache-Control": "public, max-age=10" }),
                ...embedHeaders
            } });
        }
        return new Response(obj.body as unknown as ReadableStream, {
            headers: { 
                "Content-Type": obj.httpMetadata?.contentType ?? "text/html",
                ...(isTileRequest && { "Cache-Control": "public, max-age=10" }),
                ...embedHeaders
            }
        });
    }
}

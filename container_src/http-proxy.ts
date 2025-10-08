#!/usr/bin/env bun
/**
 * HTTP Proxy Server for Docker Container
 * 
 * Architecture:
 * - Control Channel (8084): Lightweight request routing, channel allocation
 * - Data Channels (8085-8094): Dedicated TCP connections for each HTTP request
 * - HTTP Server (3128): Accept requests from container processes
 */

import { Server, Socket, TCPSocketListener } from "bun";

const CONTROL_PORT = 8084;
const DATA_PORT_START = 8085;
const DATA_PORT_END = 8109;
const HTTP_PORT = 3128;
const MAX_CHANNELS = DATA_PORT_END - DATA_PORT_START + 1;

// Control channel messages
type ControlMessage = 
  | { type: "allocate_channel"; requestId: string; port: number }
  | { type: "channel_allocated"; requestId: string; port: number }
  | { type: "channel_released"; port: number }
  | { type: "error"; requestId: string; message: string }
  | { type: "heartbeat"; ts?: number };

// Data channel state
interface DataChannelState {
  port: number;
  server: TCPSocketListener<undefined>;
  currentSocket: Socket | null;
  inUse: boolean;
  handler: {
    onData: (data: Buffer<ArrayBufferLike>) => void;
    onClose: () => void;
  };
}

class HTTPProxyServer {
  private controlSocket: Socket | null = null;
  private dataChannels: Map<number, DataChannelState> = new Map();
  private pendingAllocations: Map<string, (port: number) => void> = new Map();
  private requestIdCounter = 0;
  private statusLoggerInterval: Timer | null = null;
  private heartbeatInterval: Timer | null = null;
  
  // Metrics
  private successfulRequests = 0;
  private serviceUnavailableCount = 0;

  async start() {
    console.log("[Proxy] Starting HTTP Proxy Server...");
    
    // Start control channel listener
    await this.startControlChannel();
    
    // Start data channel listeners
    await this.startDataChannels();
    
    // Start HTTP server for container processes
    await this.startHTTPServer();
    
    // Start periodic status logger
    this.startStatusLogger();
    
    console.log("[Proxy] All services started successfully");
  }

  private startStatusLogger() {
    console.log("[Proxy] Starting status logger (every 5 seconds)...");
    
    this.statusLoggerInterval = setInterval(() => {
      const controlStatus = this.controlSocket ? "CONNECTED" : "DISCONNECTED";
      
      const dataChannelStatus = Array.from(this.dataChannels.values()).map(ch => ({
        port: ch.port,
        status: ch.inUse ? "IN_USE" : (ch.currentSocket ? "AVAILABLE" : "NO_SOCKET")
      }));
      
      const inUseCount = dataChannelStatus.filter(ch => ch.status === "IN_USE").length;
      const availableCount = dataChannelStatus.filter(ch => ch.status === "AVAILABLE").length;
      const noSocketCount = dataChannelStatus.filter(ch => ch.status === "NO_SOCKET").length;
      
      console.log(`[Proxy Status] Control: ${controlStatus} | Data Channels: ${inUseCount} in-use, ${availableCount} available, ${noSocketCount} no-socket | Pending: ${this.pendingAllocations.size} | Requests: ${this.successfulRequests} OK, ${this.serviceUnavailableCount} 503s`);
      
      // Log individual channel details if any are in use or have issues
      if (inUseCount > 0 || noSocketCount > 0) {
        const details = dataChannelStatus
          .filter(ch => ch.status !== "AVAILABLE")
          .map(ch => `${ch.port}:${ch.status}`)
          .join(", ");
        console.log(`[Proxy Status] Channel details: ${details}`);
      }
    }, 5000);
  }

  private async startControlChannel() {
    console.log(`[Proxy] Starting control channel on port ${CONTROL_PORT}...`);
    
    Bun.listen({
      hostname: "0.0.0.0",
      port: CONTROL_PORT,
      socket: {
        open: (socket) => {
          console.log("[Control] Container.ts connected to control channel");
          this.controlSocket = socket;
          // Start periodic heartbeats to container.ts
          this.startHeartbeat();
        },
        
        data: (socket, data) => {
          const message = this.parseControlMessage(data);
          if (message) {
            this.handleControlMessage(message);
          }
        },
        
        close: (socket) => {
          console.log("[Control] Control channel closed, waiting for reconnection...");
          this.controlSocket = null;
          this.stopHeartbeat();
        },
        
        error: (socket, error) => {
          console.error("[Control] Control channel error:", error);
        },
      },
    });
    
    console.log(`[Control] Control channel listening on port ${CONTROL_PORT}`);
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) return;
    console.log("[Control] Starting heartbeat interval (10s)");
    this.heartbeatInterval = setInterval(() => {
      try {
        this.sendControlMessage({ type: "heartbeat", ts: Date.now() });
      } catch (e) {
        console.error("[Control] Failed to send heartbeat:", e);
      }
    }, 10000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log("[Control] Stopped heartbeat interval");
    }
  }

  private defaultDataChannelHandler = (data: Buffer<ArrayBufferLike>) => {
    console.log(`[Data] Unexpected data from container.ts`);
  }

  private defaultDataChannelCloseHandler = () => {
    // Default: no-op
  }

  private async startDataChannels() {
    console.log(`[Proxy] Starting data channels ${DATA_PORT_START}-${DATA_PORT_END}...`);

    for (let port = DATA_PORT_START; port <= DATA_PORT_END; port++) {
      const handler = {
        onData: this.defaultDataChannelHandler,
        onClose: this.defaultDataChannelCloseHandler,
      }
      const server = Bun.listen({
        hostname: "0.0.0.0",
        port,
        socket: {
          open: (socket) => {
            console.log(`[Data:${port}] Connection opened`);
            const channel = this.dataChannels.get(port);
            if (channel) {
              channel.currentSocket = socket;
            }
          },
          
          data: (socket, data) => {
            // Get the channel and call its current handler
            const port = this.findPortBySocket(socket);
            if (port) {
              const channel = this.dataChannels.get(port);
              if (channel) {
                channel.handler.onData(data);
              }
            }
          },
          
          close: (socket) => {
            const port = this.findPortBySocket(socket);
            if (port) {
              console.log(`[Data:${port}] Connection closed by container.ts`);
              const channel = this.dataChannels.get(port);
              if (channel) {
                // Invoke close handler first (for response finalization)
                channel.handler.onClose();
                
                // Then clean up channel state - socket is gone
                channel.currentSocket = null;
                channel.inUse = false;
                channel.handler.onData = this.defaultDataChannelHandler;
                channel.handler.onClose = this.defaultDataChannelCloseHandler;
                
                // Don't send channel_released - container.ts closed it, not us
                // It will reconnect on next allocation
              }
            }
          },
          
          error: (socket, error) => {
            const port = this.findPortBySocket(socket);
            console.error(`[Data:${port}] Error:`, error);
          },
        },
      });
      
      this.dataChannels.set(port, {
        port,
        server,
        handler,
        currentSocket: null,
        inUse: false,
      });
    }
    
    console.log(`[Proxy] ${MAX_CHANNELS} data channels initialized`);
  }

  private async startHTTPServer() {
    console.log(`[Proxy] Starting HTTP server on port ${HTTP_PORT}...`);
    
    const self = this;
    const server = Bun.serve({
      idleTimeout: 255, // Maximum allowed by Bun (4.25 minutes)
      hostname: "0.0.0.0",
      port: HTTP_PORT,
      
      async fetch(req) {
        return await self.handleHTTPRequest(req);
      },
    });
    
    console.log(`[HTTP] HTTP proxy server listening on ${server.hostname}:${server.port}`);
  }

  private async handleHTTPRequest(req: Request): Promise<Response> {
    const requestId = `req_${this.requestIdCounter++}_${Date.now()}`;
    console.log(`[HTTP] ${requestId} ${req.method} ${req.url}`);
    
    // Healthcheck endpoint
    const url = new URL(req.url);
    if (url.pathname === '/healthcheck' || url.pathname === '/health') {
      const status = this.controlSocket ? "CONNECTED" : "DISCONNECTED";
      return new Response(status, {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }
    
    try {
      // Request a data channel allocation
      const port = await this.allocateDataChannel(requestId);
      console.log(`[HTTP] ${requestId} allocated data channel on port ${port}`);
      
      const channel = this.dataChannels.get(port);
      if (!channel) {
        throw new Error(`Data channel ${port} not found`);
      }
      
      // Only wait for connection if socket isn't already there (new connections)
      if (!channel.currentSocket) {
        await this.waitForDataChannelConnection(port, 5000);
        if (!channel.currentSocket) {
          throw new Error(`Data channel ${port} not ready`);
        }
      }
      
      // Start reading response immediately (sets up handlers)
      const receivePromise = new Promise<Response>((resolve, reject) => {
        this.readHTTPResponseFromDataChannel(channel, resolve, reject);
      });
      
      // Start sending request (including body streaming)
      const sendPromise = this.sendHTTPRequestOverDataChannel(channel, req);
      
      // Wait for BOTH to complete - send and receive happen in parallel
      // This is critical for large uploads where the server may start responding
      // before the full body is sent, or may only respond after receiving everything
      const [response] = await Promise.all([receivePromise, sendPromise]);
      
      // Track successful request
      this.successfulRequests++;
      
      return response;
      
    } catch (error) {
      
      // Return 503 if we're out of channels (saturation)
      if (error instanceof Error && error.message === "No available data channels") {
        this.serviceUnavailableCount++;
        return new Response("Service Unavailable: All proxy channels in use", { 
          status: 503,
          headers: {
            "Retry-After": "1" // suggest retry after 1 second
          }
        });
      } else {
        // log other cases
        console.error(`[HTTP] ${requestId} error:`, error);
      }
      
      return new Response(`Proxy Error: ${error}`, { status: 502 });
    }
  }

  private async allocateDataChannel(requestId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      // Find an available data channel (not in use, may or may not have a socket)
      const availableChannel = Array.from(this.dataChannels.values()).find(ch => !ch.inUse);
      
      if (!availableChannel) {
        reject(new Error("No available data channels"));
        return;
      }
      
      // Mark as in use
      availableChannel.inUse = true;
      
      // If channel already has a socket (keep-alive reuse), resolve immediately
      if (availableChannel.currentSocket) {
        console.log(`[HTTP] ${requestId} reusing existing connection on port ${availableChannel.port}`);
        resolve(availableChannel.port);
        return;
      }
      
      // No socket yet - need to request container.ts to connect
      console.log(`[HTTP] ${requestId} requesting new connection on port ${availableChannel.port}`);
      this.pendingAllocations.set(requestId, resolve);
      this.sendControlMessage({
        type: "allocate_channel",
        requestId,
        port: availableChannel.port,
      });
      
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingAllocations.has(requestId)) {
          this.pendingAllocations.delete(requestId);
          availableChannel.inUse = false;
          reject(new Error("Channel allocation timeout"));
        }
      }, 10000);
    });
  }

  private async waitForDataChannelConnection(port: number, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const channel = this.dataChannels.get(port);
      if (channel?.currentSocket) {
        return;
      }
      await Bun.sleep(50);
    }
    
    throw new Error(`Data channel ${port} connection timeout after ${timeoutMs}ms`);
  }

  private async sendHTTPRequestOverDataChannel(channel: DataChannelState, req: Request) {
    console.log("[Data] Sending HTTP request to container.ts");
    // Serialize the HTTP request as HTTP/1.1 wire format
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    
    if (!channel.currentSocket) {
      throw new Error("Data channel not connected");
    }
    
    // Add headers
    const headers = new Headers(req.headers);
    // Ensure Host header
    if (!headers.has("host")) {
      headers.set("host", url.host);
    }
    
    // Handle body and Content-Length
    let bodyBytes: Uint8Array | null = null;
    let hasContentLength = false;
    let hasChunkedEncoding = false;
    if (req.body) {
      hasContentLength = headers.has("content-length");
      hasChunkedEncoding = headers.get("transfer-encoding")?.toLowerCase().includes("chunked") ?? false;
      
      // If no content-length and not chunked, buffer the body to calculate length
      if (!hasContentLength && !hasChunkedEncoding) {
        console.log(`[Data] Buffering body to calculate Content-Length for ${req.method} ${req.url}`);
        const chunks: Uint8Array[] = [];
        const reader = req.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        
        // Combine chunks
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        bodyBytes = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          bodyBytes.set(chunk, offset);
          offset += chunk.length;
        }
        
        // Add Content-Length header
        headers.set("content-length", bodyBytes.length.toString());
        console.log(`[Data] Set Content-Length: ${bodyBytes.length}`);
      }
    }
    
    // Build request line and headers
    let requestLine = `${req.method} ${path} HTTP/1.1\r\n`;
    for (const [key, value] of headers.entries()) {
      requestLine += `${key}: ${value}\r\n`;
    }
    requestLine += "\r\n";
    
    // Convert headers to bytes and send
    const headerBytes = new TextEncoder().encode(requestLine);
    let sentBytes = 0;
    while (sentBytes < headerBytes.length) {
      const bytesWritten = channel.currentSocket.write(headerBytes.slice(sentBytes));
      if (bytesWritten < 0) {
        console.error("[Data] Failed to send headers, socket is blocked");
        throw new Error("Socket is blocked");
      }
      sentBytes += bytesWritten;
    }
    channel.currentSocket.flush();
    
    // Send body if present
    if (req.body || bodyBytes) {
      if (bodyBytes) {
        // Send buffered body
        let sentBytes = 0;
        while (sentBytes < bodyBytes.length) {
          const bytesWritten = channel.currentSocket.write(bodyBytes.slice(sentBytes));
          if (bytesWritten < 0) {
            console.error("[Data] Failed to send body, socket is blocked");
            throw new Error("Socket is blocked");
          }
          sentBytes += bytesWritten;
        }
        channel.currentSocket.flush();
      } else if (req.body) {
        // Stream body. If the incoming request used chunked transfer encoding,
        // we must re-encode chunks on the wire. Otherwise, send raw bytes.
        const reader = req.body.getReader();
        let totalSent = 0;
        let chunkCount = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunkCount++;

            if (hasChunkedEncoding) {
              // Write chunk size in hex followed by CRLF
              const sizeLine = new TextEncoder().encode(value.length.toString(16) + "\r\n");
              let written = 0;
              while (written < sizeLine.length) {
                const n = channel.currentSocket.write(sizeLine.slice(written));
                if (n < 0) {
                  console.error("[Data] Failed to send chunk size, socket is blocked");
                  throw new Error("Socket is blocked");
                }
                written += n;
              }
            }

            // Write chunk/body bytes
            let sentBytes = 0;
            while (sentBytes < value.length) {
              const bytesWritten = channel.currentSocket.write(value.slice(sentBytes));
              if (bytesWritten < 0) {
                console.error("[Data] Failed to send body chunk, socket is blocked");
                throw new Error("Socket is blocked");
              }
              sentBytes += bytesWritten;
              totalSent += bytesWritten;
            }

            if (hasChunkedEncoding) {
              // Write CRLF after the chunk data
              const crlf = new TextEncoder().encode("\r\n");
              let written = 0;
              while (written < crlf.length) {
                const n = channel.currentSocket.write(crlf.slice(written));
                if (n < 0) {
                  console.error("[Data] Failed to send chunk CRLF, socket is blocked");
                  throw new Error("Socket is blocked");
                }
                written += n;
              }
            }

            // Flush after each chunk to ensure it's sent
            channel.currentSocket.flush();
          }

          if (hasChunkedEncoding) {
            // Send terminating zero-length chunk
            const endChunk = new TextEncoder().encode("0\r\n\r\n");
            let written = 0;
            while (written < endChunk.length) {
              const n = channel.currentSocket.write(endChunk.slice(written));
              if (n < 0) {
                console.error("[Data] Failed to send final chunk, socket is blocked");
                throw new Error("Socket is blocked");
              }
              written += n;
            }
          }

          // Final flush to ensure everything is sent
          channel.currentSocket.flush();
          console.log(`[Data] Streamed request body: ${totalSent} bytes in ${chunkCount} chunks${hasChunkedEncoding ? " (chunked)" : ""}`);
        } finally {
          reader.releaseLock();
        }
      }
    }
    
    console.log(`[Data] Sent HTTP request to container.ts`);
  }

  private readHTTPResponseFromDataChannel(channel: DataChannelState, resolve: (response: Response) => void, reject: (error: Error) => void) {

      let buffer = new Uint8Array(0);
      let headersParsed = false;
      let statusCode = 200;
      let statusText = "OK";
      let headers = new Headers();
      let bodyChunks: Uint8Array[] = [];
      let contentLength: number | null = null;
      let isChunked = false;
      let bodyReceived = 0;
      let responseComplete = false;

      // Cleanup function to reset handlers and mark channel available
      const cleanup = () => {
        if (responseComplete) return;
        responseComplete = true;
        clearTimeout(timeout);
        channel.handler.onData = this.defaultDataChannelHandler;
        channel.handler.onClose = this.defaultDataChannelCloseHandler;
        
        // Mark channel as available for reuse (keep socket open!)
        channel.inUse = false;
        console.log(`[Data:${channel.port}] Channel marked available for reuse`);
      };

      // Timeout if no response received
      // Use 10 minutes for multipart uploads which can take a long time
      const timeout = setTimeout(() => {
        if (!responseComplete) {
          cleanup();
          reject(new Error("Response timeout after 10 minutes"));
        }
      }, 600000); // 10 minutes

      // Handle connection close
      const closeHandler = () => {
        if (responseComplete) return;
        
        // If headers were parsed, finalize with what we have
        // This handles responses without content-length or chunked encoding
        if (headersParsed) {
          cleanup();
          this.finalizeResponse(statusCode, statusText, headers, bodyChunks, isChunked, resolve);
        } else {
          cleanup();
          reject(new Error("Connection closed before headers received"));
        }
      };

      // Handle incoming data from socket
      const dataHandler = (data: Buffer | Uint8Array) => {
        if (responseComplete) return;

        const chunk = new Uint8Array(data);
        const combined = new Uint8Array(buffer.length + chunk.length);
        combined.set(buffer);
        combined.set(chunk, buffer.length);
        buffer = combined;

        if (!headersParsed) {
          const headerEnd = this.findHeaderEnd(buffer);
          
          if (headerEnd !== -1) {
            // Parse headers
            const headerText = new TextDecoder().decode(buffer.slice(0, headerEnd));
            const lines = headerText.split("\r\n");
            
            // Parse status line: HTTP/1.1 200 OK
            const statusLine = lines[0];
            const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+)(.*)/);
            if (statusMatch) {
              statusCode = parseInt(statusMatch[1]);
              statusText = statusMatch[2].trim() || "OK";
            }
            
            // Parse headers
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i];
              const colonIndex = line.indexOf(":");
              if (colonIndex > 0) {
                const key = line.slice(0, colonIndex).trim();
                const value = line.slice(colonIndex + 1).trim();
                headers.set(key.toLowerCase(), value);
              }
            }
            
            // Check for content-length or chunked encoding
            const contentLengthHeader = headers.get("content-length");
            const transferEncoding = headers.get("transfer-encoding");
            
            if (contentLengthHeader) {
              contentLength = parseInt(contentLengthHeader);
            }
            if (transferEncoding?.toLowerCase().includes("chunked")) {
              isChunked = true;
            }
            
            headersParsed = true;
            
            // If this status code never has a response body (1xx, 204, 304),
            // finalize immediately without waiting for a connection close
            if (statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode < 200)) {
              cleanup();
              this.finalizeResponse(statusCode, statusText, headers, [], false, resolve);
              return;
            }

            // Process remaining data as body
            const bodyStart = headerEnd + 4;
            if (bodyStart < buffer.length) {
              const bodyData = buffer.slice(bodyStart);
              bodyChunks.push(bodyData);
              bodyReceived += bodyData.length;
            }
            
            buffer = new Uint8Array(0);
            
            // Check if response is complete
            if (this.isResponseComplete(contentLength, bodyReceived, isChunked, bodyChunks)) {
              cleanup();
              this.finalizeResponse(statusCode, statusText, headers, bodyChunks, isChunked, resolve);
            }
          }
        } else {
          // Collecting body
          bodyChunks.push(buffer);
          bodyReceived += buffer.length;
          buffer = new Uint8Array(0);
          
          // Check if response is complete
          if (this.isResponseComplete(contentLength, bodyReceived, isChunked, bodyChunks)) {
            cleanup();
            this.finalizeResponse(statusCode, statusText, headers, bodyChunks, isChunked, resolve);
          }
        }
      };
      
      // Register handlers
      channel.handler.onData = dataHandler;
      channel.handler.onClose = closeHandler;
    
  }

  private isResponseComplete(
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
    if (isChunked) {
      // Check for chunked encoding terminator (0\r\n\r\n)
      if (bodyChunks.length > 0) {
        const lastChunk = bodyChunks[bodyChunks.length - 1];
        const text = new TextDecoder().decode(lastChunk.slice(-5));
        if (text.includes("0\r\n\r\n")) {
          return true;
        }
      }
    }
    
    // If no content-length and not chunked, we have no body (e.g., 204 No Content)
    // We should rely on connection close to signal completion
    // Return false here so we wait for close event
    return false;
  }

  private finalizeResponse(
    statusCode: number,
    statusText: string,
    headers: Headers,
    bodyChunks: Uint8Array[],
    isChunked: boolean,
    resolve: (response: Response) => void
  ) {
    let body: Uint8Array;
    
    if (isChunked) {
      // Decode chunked encoding
      body = this.decodeChunkedBody(bodyChunks);
    } else {
      // Combine body chunks
      const totalLength = bodyChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      body = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of bodyChunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
    }
    
    const bodyInit = body.length > 0
      ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      : null;
    const response = new Response(bodyInit as ArrayBuffer | null, {
      status: statusCode,
      statusText: statusText,
      headers: headers,
    });
    
    console.log(`[Data] Parsed HTTP response: ${statusCode} ${statusText}, body size: ${body.length}`);
    resolve(response);
  }

  private decodeChunkedBody(chunks: Uint8Array[]): Uint8Array {
    // Combine all chunks first
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Parse chunked encoding
    const decodedChunks: Uint8Array[] = [];
    let pos = 0;
    
    while (pos < combined.length) {
      // Find the chunk size line (ends with \r\n)
      let lineEnd = pos;
      while (lineEnd < combined.length - 1) {
        if (combined[lineEnd] === 0x0d && combined[lineEnd + 1] === 0x0a) {
          break;
        }
        lineEnd++;
      }
      
      if (lineEnd >= combined.length - 1) break;
      
      const sizeLine = new TextDecoder().decode(combined.slice(pos, lineEnd));
      const chunkSize = parseInt(sizeLine.split(";")[0].trim(), 16);
      
      if (chunkSize === 0) {
        // Last chunk
        break;
      }
      
      pos = lineEnd + 2; // Skip \r\n
      
      if (pos + chunkSize <= combined.length) {
        decodedChunks.push(combined.slice(pos, pos + chunkSize));
        pos += chunkSize + 2; // Skip chunk data and trailing \r\n
      } else {
        break;
      }
    }
    
    // Combine decoded chunks
    const decodedLength = decodedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const decoded = new Uint8Array(decodedLength);
    offset = 0;
    for (const chunk of decodedChunks) {
      decoded.set(chunk, offset);
      offset += chunk.length;
    }
    
    return decoded;
  }

  private findHeaderEnd(buffer: Uint8Array): number {
    // Look for \r\n\r\n
    for (let i = 0; i < buffer.length - 3; i++) {
      if (buffer[i] === 0x0d && buffer[i+1] === 0x0a && 
          buffer[i+2] === 0x0d && buffer[i+3] === 0x0a) {
        return i;
      }
    }
    return -1;
  }

  private parseControlMessage(data: Buffer | Uint8Array): ControlMessage | null {
    try {
      const text = new TextDecoder().decode(data);
      // Messages are length-prefixed: [4-byte length][JSON]
      if (text.length < 4) return null;
      
      const dataView = new DataView(data instanceof Buffer ? data.buffer : data.buffer);
      const length = dataView.getUint32(0, true); // little-endian
      
      if (data.length < 4 + length) return null;
      
      const jsonData = data.slice(4, 4 + length);
      const jsonText = new TextDecoder().decode(jsonData);
      return JSON.parse(jsonText) as ControlMessage;
    } catch (error) {
      console.error("[Control] Failed to parse message:", error);
      return null;
    }
  }

  private handleControlMessage(message: ControlMessage) {
    console.log("[Control] Received message:", message);
    
    switch (message.type) {
      case "channel_allocated":
        const resolver = this.pendingAllocations.get(message.requestId);
        if (resolver) {
          resolver(message.port);
          this.pendingAllocations.delete(message.requestId);
        }
        break;
        
      case "error":
        console.error(`[Control] Error for ${message.requestId}:`, message.message);
        break;
    }
  }

  private sendControlMessage(message: ControlMessage) {
    console.log("[Control] Sending message:", message); 
    console.error("[Control] Sending message:", message);
    if (!this.controlSocket) {
      console.warn("[Control] Cannot send message, control socket not connected");
      return;
    }
    
    try {
      const json = JSON.stringify(message);
      const jsonBytes = new TextEncoder().encode(json);
      
      // Length-prefixed message
      const buffer = new Uint8Array(4 + jsonBytes.length);
      const dataView = new DataView(buffer.buffer);
      dataView.setUint32(0, jsonBytes.length, true); // little-endian
      buffer.set(jsonBytes, 4);
      
      let sentBytes = 0;
      const bufferLength = buffer.length;
      while (sentBytes < bufferLength) {
        const bytesWritten = this.controlSocket.write(sentBytes === 0 ? buffer : buffer.slice(sentBytes));
        if(bytesWritten < 0) {
          console.error("[Control] Failed to send message, socket is blocked");
          throw new Error("Socket is blocked");
        }
        
        sentBytes += bytesWritten;
      }
      this.controlSocket.flush();
      console.error("[Control] Message sent");
    
    } catch (error) {
      console.error("[Control] Failed to send message:", error);
    }
  }

  private findPortBySocket(socket: Socket): number | null {
    for (const [port, channel] of this.dataChannels.entries()) {
      if (channel.currentSocket === socket) {
        return port;
      }
    }
    return null;
  }
}

// Start the proxy server
const proxy = new HTTPProxyServer();
proxy.start().catch((error) => {
  console.error("[Proxy] Fatal error:", error);
  process.exit(1);
});


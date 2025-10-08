#!/usr/bin/env bun
/**
 * File Server with R2 Backup Support
 * 
 * Serves files from the container filesystem and handles backup requests
 * that create tar.gz archives and upload to R2 storage.
 * 
 * Endpoints:
 * - GET /path/to/file - Serve file content
 * - GET /path/to/directory?backup=true - Create tar.gz and upload to R2
 *   Note: .jar files in plugins folders are automatically excluded from backup to save space
 * - GET /path/to/directory?restore=<backup_filename> - Fetch backup from R2 and restore to directory
 *   Note: .jar files in plugins folders are automatically excluded from restore to prevent overwriting updated plugins
 * - GET /path/to/directory?list_backups=true - List available backups for the directory
 * 
 * Why reverse-epoch filenames?
 * - S3-compatible storage (including Cloudflare R2) returns ListObjects results
 *   in lexicographic (alphabetical) ascending order only. There is no server-side
 *   option to sort by last-modified or to request newest-first.
 * - To make an ascending alphabetical listing return the newest backups first,
 *   we prefix backup object keys with a fixed-width reverse-epoch (seconds)
 *   value, followed by a human-readable UTC date (YYYYMMDDHH) and the directory
 *   name: backups/<reverseEpochSec>_<YYYYMMDDHH>_<dir>.tar.gz.
 * - This ensures that simple S3 list calls yield the most recent backups first,
 *   avoiding extra client-side fetching and sorting.
 */

import { spawn } from "bun";
import { file, S3Client } from "bun";

const PORT = 8083;

// Use a fixed "max epoch" ~100 years in the future to compute reverse-epoch seconds
// New backup filenames start with this reverse-epoch so lexicographic ascending order
// yields newest-first.
const MAX_EPOCH_SECONDS = Math.floor(new Date('2125-01-01T00:00:00Z').getTime() / 1000);
const REV_SECONDS_WIDTH = String(MAX_EPOCH_SECONDS).length;

function formatUTCDateYYYYMMDDHH(d: Date): string {
  const yyyy = d.getUTCFullYear().toString();
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const HH = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}${MM}${dd}${HH}`;
}

function generateBackupKey(dirName: string, at: Date = new Date()): string {
  const nowSeconds = Math.floor(at.getTime() / 1000);
  const reverseEpochSeconds = MAX_EPOCH_SECONDS - nowSeconds;
  const reversePart = String(reverseEpochSeconds).padStart(REV_SECONDS_WIDTH, '0');
  const datePart = formatUTCDateYYYYMMDDHH(at);
  // Global ordering by reverse-epoch; include human-readable date and dir name
  return `backups/${reversePart}_${datePart}_${dirName}.tar.gz`;
}

interface BackupResult {
  success: boolean;
  backup_path: string;
  size: number;
  note?: string;
}

interface RestoreResult {
  success: boolean;
  restored_from: string;
  restored_to: string;
  size: number;
  note?: string;
}

interface BackupListItem {
  path: string;
  size: number;
  timestamp: string;
}

interface ListBackupsResult {
  success: boolean;
  directory: string;
  backups: BackupListItem[];
}

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// /**
//  * Retry wrapper for fetch requests to cloud storage
//  * Retries up to MAX_RETRIES times with exponential backoff
//  */
// async function fetchWithRetry(
//   url: string,
//   options: RequestInit,
//   operationName: string
// ): Promise<Response> {
//   let lastError: Error | null = null;
  
//   for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
//     try {
//       console.log(`[FileServer] ${operationName}: Attempt ${attempt}/${MAX_RETRIES}`);
//       const response = await fetch(url, options);
      
//       // Return response (caller will check if it's ok)
//       return response;
//     } catch (error: any) {
//       lastError = error;
//       console.warn(
//         `[FileServer] ${operationName}: Attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`
//       );

//       // Don't wait after the last attempt
//       if (attempt < MAX_RETRIES) {
//         const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff
//         console.log(`[FileServer] ${operationName}: Retrying in ${delayMs}ms...`);
//         await new Promise(resolve => setTimeout(resolve, delayMs));
//       }
//     }
//   }

//   // All retries failed
//   throw new Error(
//     `${operationName} failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
//   );
// }

/**
 * Create an S3Client instance with credentials from environment variables
 */
function createS3Client(bucketName: 'dynmap' | 'data'): S3Client {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const bucket = bucketName === 'data' ? process.env.DATA_BUCKET_NAME : process.env.DYNMAP_BUCKET;

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    throw new Error("Missing AWS credentials in environment");
  }

  return new S3Client({
    accessKeyId,
    secretAccessKey,
    endpoint,
    bucket,
    virtualHostedStyle: false,
  });
}

class FileServer {
  private requestCount = 0;
  private backupCount = 0;
  private restoreCount = 0;
  private activeRestores = 0;
  private backupJobs: Map<string, {
    id: string;
    directory: string;
    status: "pending" | "running" | "success" | "failed";
    startedAt: number;
    completedAt?: number;
    result?: { backup_path: string; size: number; note?: string };
    error?: string;
  }> = new Map();

  private jsonResponse(data: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
    const body = JSON.stringify(data);
    const byteLength = new TextEncoder().encode(body).length;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(byteLength),
      ...(init?.headers || {}),
    };
    return new Response(body, { status: init?.status ?? 200, headers });
  }

  async start() {
    console.log(`[FileServer] Starting on port ${PORT}...`);

    const self = this;
    const server = Bun.serve({
      port: PORT,
      idleTimeout: 255, // THis is essential to support large uploads
      hostname: "0.0.0.0",
      async fetch(req) {
        return await self.handleRequest(req);
      },
      error(error) {
        console.error("[FileServer] Error:", error);
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    console.log(`[FileServer] Listening on ${server.hostname}:${server.port}`);
    
    // Start periodic status logger
    setInterval(() => {
      const restoreStatus = self.activeRestores > 0 ? ` | Restore in progress (${self.activeRestores})` : '';
      console.log(
        `[FileServer Status] Requests: ${self.requestCount} | Backups: ${self.backupCount} | Restores: ${self.restoreCount}${restoreStatus}`
      );
    }, 30000); // Every 30 seconds
  }

  private async handleRequest(req: Request): Promise<Response> {
    this.requestCount++;
    
    const url = new URL(req.url);
    // Background backup status endpoint
    if (url.pathname === "/backup-status") {
      const id = url.searchParams.get("id");
      if (!id) {
        return this.jsonResponse({ error: "Missing id" }, { status: 400 });
      }
      const job = this.backupJobs.get(id);
      if (!job) {
        return this.jsonResponse({ id, status: "not_found" });
      }
      return this.jsonResponse({
        id: job.id,
        directory: job.directory,
        status: job.status,
        startedAt: job.startedAt,
        completedAt: job.completedAt ?? null,
        result: job.result ?? null,
        error: job.error ?? null,
      });
    }
    const isBackup = url.searchParams.get("backup")?.toLowerCase() === "true";
    const restoreParam = url.searchParams.get("restore");
    const isListBackups = url.searchParams.get("list_backups")?.toLowerCase() === "true";

    if (isBackup) {
      const id = url.searchParams.get("backup_id");
      if (id) {
        // Start background backup and return immediately
        return await this.handleBackgroundBackupStart(url.pathname, id);
      }
      return await this.handleBackup(url.pathname);
    } else if (restoreParam) {
      return await this.handleRestore(url.pathname, restoreParam);
    } else if (isListBackups) {
      return await this.handleListBackups(url.pathname);
    } else {
      return await this.handleFileServe(url.pathname);
    }
  }

  private async handleBackgroundBackupStart(pathname: string, id: string): Promise<Response> {
    // Normalize directory path
    let directory = pathname;
    if (!directory.startsWith("/")) {
      directory = "/" + directory;
    }

    // If already exists, return its current state
    const existing = this.backupJobs.get(id);
    if (existing) {
      return this.jsonResponse({
        id: existing.id,
        directory: existing.directory,
        status: existing.status,
        startedAt: existing.startedAt,
        completedAt: existing.completedAt ?? null,
      });
    }

    // Create new job
    const job = {
      id,
      directory,
      status: "pending" as const,
      startedAt: Date.now(),
    };
    this.backupJobs.set(id, job);
    this.backupCount++;
    console.log(`[FileServer] Background backup job created: ${id} for ${directory}`);

    // Start async work (do not await)
    this.executeBackupJob(job).then(r => {
      console.log(`[FileServer] Background backup job completed: ${id} for ${directory}`);
      return r;
    }).catch((err) => {
      const j = this.backupJobs.get(id);
      if (j) {
        j.status = "failed";
        j.completedAt = Date.now();
        j.error = String(err?.message || err);
        this.backupJobs.set(id, j);
      }
      console.error(`[FileServer] Background backup job failed: ${id}`, err);
    });

    return this.jsonResponse({
      id,
      started: true,
      directory,
      status: job.status,
      startedAt: job.startedAt,
    });
  }

  private async executeBackupJob(job: { id: string; directory: string; status: "pending" | "running" | "success" | "failed"; startedAt: number; completedAt?: number; result?: { backup_path: string; size: number; note?: string }; error?: string; }): Promise<void> {
    const { id, directory } = job;
    console.log(`[FileServer] Starting background backup execution for ${id}: ${directory}`);

    try {
      job.status = "running";
      this.backupJobs.set(id, job);

      // Create S3 client
      const s3Client = createS3Client('data');

      // Generate backup filename using reverse-epoch seconds for newest-first lex order
      const now = new Date();
      const dirName = directory.split("/").filter(Boolean).pop() || "backup";
      const backupFilename = generateBackupKey(dirName, now);

      console.log(`[FileServer] [${id}] Creating backup: ${directory} -> ${backupFilename} (excluding plugins/*.jar)`);

      // Create tar.gz archive using tar command
      const tempFile = `/tmp/backup_${formatUTCDateYYYYMMDDHH(new Date())}_${id}.tar.gz`;
      const tarProc = spawn([
        "tar",
        "-czf",
        tempFile,
        "-C",
        directory.substring(0, directory.lastIndexOf("/")) || "/",
        "--exclude=*/plugins/*.jar",
        dirName,
      ]);
      const tarExit = await tarProc.exited;
      if (tarExit !== 0) {
        const stderr = await new Response(tarProc.stderr).text();
        throw new Error(`tar command failed with exit code ${tarExit}: ${stderr}`);
      }

      console.log(`[FileServer] [${id}] Archive created: ${tempFile}`);

      // Get file size
      const tarFile = Bun.file(tempFile);
      const tarStat = await tarFile.stat();
      const fileSize = tarStat?.size || 0;
      const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
      console.log(`[FileServer] [${id}] Archive size: ${fileSize} bytes (${fileSizeMB} MB)`);

      // // Calculate MD5 hash by streaming the file
      // const md5Hash = await this.calculateMD5FromFile(tempFile);
      // console.log(`[FileServer] [${id}] Archive MD5: ${md5Hash}`);

      // // Check for existing backup
      // const existingBackup = await this.findExistingBackupByMD5(
      //   s3Client,
      //   dirName,
      //   md5Hash
      // );
      // if (existingBackup) {
      //   console.log(`[FileServer] [${id}] Found existing backup with same MD5: ${existingBackup.path}`);
      //   try { await unlink(tempFile); } catch {}
      //   job.status = "success";
      //   job.completedAt = Date.now();
      //   job.result = { backup_path: existingBackup.path, size: existingBackup.size, note: "Duplicate backup skipped (same content already exists). Plugin .jar files were excluded." };
      //   this.backupJobs.set(id, job);
      //   console.log(`[FileServer] [${id}] Background backup marked success (duplicate)`);
      //   return;
      // }

      console.log(`[FileServer] [${id}] Uploading to S3: ${backupFilename} (streaming from disk)`);
      const fileForUpload = Bun.file(tempFile);
      await s3Client.write(backupFilename, fileForUpload, {
        type: "application/x-tar",
      });
      try {
        await Bun.write(tempFile, "");
        await unlink(tempFile);
      } catch {
        console.error(`[FileServer] [${id}] Failed to clean up temp file: ${tempFile}`);
      }

      console.log(`[FileServer] [${id}] Backup completed successfully`);
      job.status = "success";
      job.completedAt = Date.now();
      job.result = { backup_path: backupFilename, size: fileSize, note: "Plugin .jar files were excluded from backup to save space" };
      this.backupJobs.set(id, job);
    } catch (error: any) {
      job.status = "failed";
      job.completedAt = Date.now();
      job.error = `Backup failed: ${error?.message || String(error)}`;
      this.backupJobs.set(id, job);
      console.error(`[FileServer] [${id}] ${job.error}`);
    }
  }
  private async handleFileServe(pathname: string): Promise<Response> {
    console.log(`[FileServer] File serve request for: ${pathname}`);
    // Normalize path
    let filePath = pathname === "/" ? "/" : pathname;
    if (!filePath.startsWith("/")) {
      filePath = "/" + filePath;
    }
    if(filePath.startsWith("//")) {
      filePath = filePath.substring(1);
    }

    try {
      console.log(`[FileServer] Checking if file exists: ${filePath}`);
      // Check if file exists
      // this returns false for directories!
      const fileHandle = Bun.file(filePath);
      const exists = await fileHandle.exists();

      if (!exists) {
        return new Response("File not found", { status: 404 });
      }

      // Bun's stat doesn't have isDirectory, so we try to read it
      // If it fails with a specific error, it's likely a directory
      try {
        const content = await fileHandle.arrayBuffer();
        
        return new Response(content, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": content.byteLength.toString(),
          },
        });
      } catch (e: any) {
        if (e.message?.includes("EISDIR") || e.code === "EISDIR") {
          return new Response("Path is a directory", { status: 404 });
        }
        throw e;
      }
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return new Response("File not found", { status: 404 });
      } else if (error.code === "EACCES") {
        return new Response("Permission denied", { status: 500 });
      } else {
        console.error("[FileServer] Error serving file:", error);
        return new Response(`Internal server error: ${error.message}`, {
          status: 500,
        });
      }
    }
  }

  private async handleBackup(pathname: string): Promise<Response> {
    this.backupCount++;
    console.log(`[FileServer] Backup request for: ${pathname}`);

    try {
      // Normalize directory path
      let directory = pathname;
      if (!directory.startsWith("/")) {
        directory = "/" + directory;
      }
      
      // Create S3 client
      const s3Client = createS3Client('data');

      // Generate backup filename using reverse-epoch seconds for newest-first lex order
      const now = new Date();
      const dirName = directory.split("/").filter(Boolean).pop() || "backup";
      const backupFilename = generateBackupKey(dirName, now);

      console.log(`[FileServer] Creating backup: ${directory} -> ${backupFilename} (excluding plugins/*.jar)`);

      // Create tar.gz archive using tar command
      // Exclude .jar files from plugins folders to save space (they won't be restored anyway)
      const tempFile = `/tmp/backup_${formatUTCDateYYYYMMDDHH(now)}.tar.gz`;
      
      const tarProc = spawn([
        "tar",
        "-czf",
        tempFile,
        "-C",
        directory.substring(0, directory.lastIndexOf("/")) || "/",
        "--exclude=*/plugins/*.jar",  // Exclude all .jar files in any plugins directory
        dirName,
      ]);

      const tarExit = await tarProc.exited;
      
      if (tarExit !== 0) {
        const stderr = await new Response(tarProc.stderr).text();
        throw new Error(`tar command failed with exit code ${tarExit}: ${stderr}`);
      }

      console.log(`[FileServer] Archive created: ${tempFile}`);

      // Get file size
      const tarFile = Bun.file(tempFile);
      const tarStat = await tarFile.stat();
      const fileSize = tarStat?.size || 0;
      const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

      console.log(`[FileServer] Archive size: ${fileSize} bytes (${fileSizeMB} MB)`);

      // // Calculate MD5 hash by streaming the file
      // const md5Hash = await this.calculateMD5FromFile(tempFile);
      // console.log(`[FileServer] Archive MD5: ${md5Hash}`);

      // // Check if a backup with the same MD5 already exists
      // const existingBackup = await this.findExistingBackupByMD5(
      //   s3Client,
      //   dirName,
      //   md5Hash
      // );

      // if (existingBackup) {
      //   console.log(`[FileServer] Found existing backup with same MD5: ${existingBackup.path}`);
        
      //   // Clean up temp file
      //   try {
      //     await unlink(tempFile);
      //   } catch (e) {
      //     console.warn(`[FileServer] Failed to clean up temp file: ${e}`);
      //   }

      //   const result: BackupResult = {
      //     success: true,
      //     backup_path: existingBackup.path,
      //     size: existingBackup.size,
      //     note: "Duplicate backup skipped (same content already exists). Plugin .jar files were excluded.",
      //   };

      //   return this.jsonResponse(result);
      // }

      // No existing backup found, proceed with upload
      console.log(`[FileServer] Uploading to S3: ${backupFilename} (streaming from disk)`);

      // Upload to S3 using Bun's S3 client (automatically handles streaming and retries)
      const fileForUpload = Bun.file(tempFile);
      await s3Client.write(backupFilename, fileForUpload, {
        type: "application/x-tar",
      });

      // Clean up temp file
      try {
        await Bun.write(tempFile, ""); // Empty the file first
        await unlink(tempFile);
      } catch (e) {
        console.warn(`[FileServer] Failed to clean up temp file: ${e}`);
      }

      console.log(`[FileServer] Backup completed successfully`);

      const result: BackupResult = {
        success: true,
        backup_path: backupFilename,
        size: fileSize,
        note: "Plugin .jar files were excluded from backup to save space",
      };

      return this.jsonResponse(result);
    } catch (error: any) {
      const errorMsg = `Backup failed: ${error.message}`;
      console.error(`[FileServer] ${errorMsg}`);
      console.error(error.stack);

      return this.jsonResponse({ error: errorMsg }, { status: 500 });
    }
  }

  // private async calculateMD5FromFile(filePath: string): Promise<string> {
  //   // Use Node.js crypto module which is available in Bun
  //   const crypto = await import("crypto");
  //   const hash = crypto.createHash('md5');
    
  //   // Stream the file in chunks to avoid loading into memory
  //   const file = Bun.file(filePath);
  //   const stream = file.stream();
  //   const reader = stream.getReader();
    
  //   try {
  //     while (true) {
  //       const { done, value } = await reader.read();
  //       if (done) break;
  //       hash.update(value);
  //     }
  //   } finally {
  //     reader.releaseLock();
  //   }
    
  //   return hash.digest('hex');
  // }

  // private async findExistingBackupByMD5(
  //   s3Client: S3Client,
  //   dirName: string,
  //   md5Hash: string
  // ): Promise<{ path: string; size: number } | null> {
  //   try {
  //     console.log(`[FileServer] Checking for existing backups with prefix: backups/${dirName}_`);
      
  //     // List recent backups globally, then filter by dir suffix
  //     const listResult = await s3Client.list({
  //       prefix: `backups/`,
  //       maxKeys: 50, // check a reasonable window
  //     });
      
  //     if (!listResult.contents) {
  //       console.log(`[FileServer] No existing backups found`);
  //       return null;
  //     }

  //     const contents = await listResult.contents;
      
  //     // using plain fetch here because bun client doesn't give us md5s
  //     const endpoint = process.env.AWS_ENDPOINT_URL;
  //     const bucket = process.env.DATA_BUCKET_NAME || process.env.DYNMAP_BUCKET;
  //     const keys = contents.map(c => c.key);
  //     // Check each backup's MD5
  //     for (const key of keys) {
  //       const headUrl = `${endpoint}/${bucket}/${key}`;
        
  //       const headResponse = await fetchWithRetry(
  //         headUrl,
  //         {
  //           method: "HEAD",
  //         },
  //         `Check MD5 for ${key}`
  //       );

  //       if (headResponse.ok) {
  //         const existingMD5 = headResponse.headers.get("x-amz-meta-md5");
  //         const contentLength = headResponse.headers.get("Content-Length");
          
  //         if (existingMD5 === md5Hash) {
  //           console.log(`[FileServer] Found matching backup: ${key} (MD5: ${existingMD5})`);
  //           return {
  //             path: key,
  //             size: contentLength ? parseInt(contentLength) : 0,
  //           };
  //         }
  //       }
  //     }

  //     console.log(`[FileServer] No existing backup with matching MD5 found`);
  //     return null;
  //   } catch (error) {
  //     console.warn(`[FileServer] Error checking for existing backups:`, error);
  //     return null;
  //   }
  // }

  private async handleRestore(pathname: string, backupFilename: string): Promise<Response> {
    this.restoreCount++;
    this.activeRestores++;
    console.log(`[FileServer] Restore request: ${backupFilename} -> ${pathname}`);

    try {
      // Normalize directory path
      let directory = pathname;
      if (!directory.startsWith("/")) {
        directory = "/" + directory;
      }

      // Create S3 client
      const s3Client = createS3Client('data');

      // Validate backup filename (prevent path traversal)
      if (backupFilename.includes("..") || !backupFilename.startsWith("backups/")) {
        return new Response(
          JSON.stringify({ error: "Invalid backup filename" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      console.log(`[FileServer] Downloading from S3: ${backupFilename}`);

      // // Check if the backup exists first
      const s3File = s3Client.file(backupFilename);
      // const exists = await s3File.exists();
      
      // if (!exists) {
      //   return new Response(
      //     JSON.stringify({ 
      //       error: `Backup not found: ${backupFilename}`,
      //     }),
      //     {
      //       status: 404,
      //       headers: { "Content-Type": "application/json" },
      //     }
      //   );
      // }

      // Save to temp file - stream directly to disk without loading into memory
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\..+/, "")
        .replace("T", "_");
      const tempFile = `/tmp/restore_${timestamp}.tar.gz`;
      
      // Download from S3 and write to temp file
      const fileData = await s3File.arrayBuffer();
      await Bun.write(tempFile, fileData);

      // Get file size from written file
      const restoredFile = Bun.file(tempFile);
      const restoredStat = await restoredFile.stat();
      const downloadedSize = restoredStat?.size || 0;

      console.log(`[FileServer] Downloaded ${downloadedSize} bytes to ${tempFile}`);

      // Ensure target directory exists
      const parentDir = directory.substring(0, directory.lastIndexOf("/")) || "/";
      await ensureDirectory(parentDir);

      // Extract tar.gz archive to the parent directory
      // The tar will create/overwrite the target directory
      // IMPORTANT: Exclude .jar files in plugins folders to prevent overwriting manually updated plugins
      console.log(`[FileServer] Extracting to: ${parentDir} (excluding plugins/*.jar)`);
      
      const tarProc = spawn([
        "tar",
        "-xzf",
        tempFile,
        "-C",
        parentDir,
        "--exclude=*/plugins/*.jar",  // Exclude all .jar files in any plugins directory
      ]);

      const tarExit = await tarProc.exited;
      
      if (tarExit !== 0) {
        const stderr = await new Response(tarProc.stderr).text();
        throw new Error(`tar extraction failed with exit code ${tarExit}: ${stderr}`);
      }

      console.log(`[FileServer] Extraction completed successfully (plugins/*.jar excluded)`);

      // Clean up temp file
      try {
        await unlink(tempFile);
      } catch (e) {
        console.warn(`[FileServer] Failed to clean up temp file: ${e}`);
      }

      const result: RestoreResult = {
        success: true,
        restored_from: backupFilename,
        restored_to: directory,
        size: downloadedSize,
        note: "Plugin .jar files were excluded from restore to preserve manual updates",
      };

      return this.jsonResponse(result);
    } catch (error: any) {
      const errorMsg = `Restore failed: ${error.message}`;
      console.error(`[FileServer] ${errorMsg}`);
      console.error(error.stack);

      return this.jsonResponse({ error: errorMsg }, { status: 500 });
    } finally {
      this.activeRestores--;
    }
  }

  private async handleListBackups(pathname: string): Promise<Response> {
    console.log(`[FileServer] List backups request for: ${pathname}`);

    try {
      // Normalize directory path
      let directory = pathname;
      if (!directory.startsWith("/")) {
        directory = "/" + directory;
      }

      // Create S3 client (or check credentials)
      const s3Client = createS3Client('data');

      // Get directory name for filtering
      const dirName = directory.split("/").filter(Boolean).pop() || "backup";
      
      console.log(`[FileServer] Listing backups for dir: ${dirName}`);
      
      // List all backups globally then filter by dir suffix
      const listResult = await S3Client.list({
        prefix: `backups/`,
      }, {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        endpoint: process.env.AWS_ENDPOINT_URL!,
        bucket: process.env.DATA_BUCKET_NAME || process.env.DYNMAP_BUCKET!,
      });

      // Convert S3 list result to our BackupListItem format
      const backups: BackupListItem[] = [];
      
      if (listResult.contents) {
        for (const item of listResult.contents) {
          if (!item.key.endsWith(`_${dirName}.tar.gz`)) continue;
          backups.push({
            path: item.key,
            size: item.size || 0,
            timestamp: item.lastModified ? item.lastModified.toString() : "unknown",
          });
        }
      }

      // Sort backups by timestamp (newest first)
      backups.sort((a, b) => {
        if (a.timestamp === "unknown" || b.timestamp === "unknown") return 0;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });

      console.log(`[FileServer] Found ${backups.length} backups`);

      const result: ListBackupsResult = {
        success: true,
        directory: directory,
        backups: backups,
      };

      return this.jsonResponse(result);
    } catch (error: any) {
      const errorMsg = `List backups failed: ${error.message}`;
      console.error(`[FileServer] ${errorMsg}`);
      console.error(error.stack);

      return this.jsonResponse({ error: errorMsg }, { status: 500 });
    }
  }
}

// Helper to delete file (Bun doesn't have unlink in standard API)
async function unlink(path: string): Promise<void> {
  const proc = spawn(["rm", "-f", path]);
  await proc.exited;
}

// Helper to ensure directory exists
async function ensureDirectory(path: string): Promise<void> {
  const proc = spawn(["mkdir", "-p", path]);
  await proc.exited;
}

// Start the server
const server = new FileServer();
server.start().catch((error) => {
  console.error("[FileServer] Failed to start:", error);
  process.exit(1);
});


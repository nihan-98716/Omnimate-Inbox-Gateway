import crypto from 'crypto';
import { performance } from 'perf_hooks';

export interface SystemStats {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  cpuUser: number;
  cpuSystem: number;
}

export class ResourceMonitor {
  private lastCpuUsage: NodeJS.CpuUsage;
  private lastCpuTime: number;
  private intervalId: NodeJS.Timeout | null = null;
  private lagIntervalId: NodeJS.Timeout | null = null;
  private lastTickTime: number = 0;
  private maxEventLoopLag: number = 0;
  private totalEventLoopLag: number = 0;
  private eventLoopLagChecks: number = 0;

  constructor() {
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = performance.now();
  }

  /**
   * Starts event loop lag monitoring
   */
  startLagMonitor(intervalMs: number = 10) {
    this.lastTickTime = performance.now();
    this.maxEventLoopLag = 0;
    this.totalEventLoopLag = 0;
    this.eventLoopLagChecks = 0;

    this.lagIntervalId = setInterval(() => {
      const now = performance.now();
      const delay = Math.max(0, now - this.lastTickTime - intervalMs);
      this.totalEventLoopLag += delay;
      this.eventLoopLagChecks++;
      if (delay > this.maxEventLoopLag) {
        this.maxEventLoopLag = delay;
      }
      this.lastTickTime = now;
    }, intervalMs);
  }

  /**
   * Stops event loop lag monitoring
   */
  stopLagMonitor(): { maxLagMs: number; avgLagMs: number } {
    if (this.lagIntervalId) {
      clearInterval(this.lagIntervalId);
      this.lagIntervalId = null;
    }
    const avgLag = this.eventLoopLagChecks > 0 ? this.totalEventLoopLag / this.eventLoopLagChecks : 0;
    return {
      maxLagMs: this.maxEventLoopLag,
      avgLagMs: avgLag
    };
  }

  /**
   * Gets current CPU and memory statistics
   */
  getStats(): SystemStats {
    const memory = process.memoryUsage();
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage);
    const now = performance.now();
    const timeDiffMs = now - this.lastCpuTime;

    // Reset CPU base benchmarks
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = now;

    // Convert microseconds to milliseconds
    const userMs = currentCpuUsage.user / 1000;
    const systemMs = currentCpuUsage.system / 1000;

    // Calculate percentage based on time passed and cpu count
    const cpuUser = (userMs / timeDiffMs) * 100;
    const cpuSystem = (systemMs / timeDiffMs) * 100;

    return {
      rss: memory.rss / (1024 * 1024), // MB
      heapUsed: memory.heapUsed / (1024 * 1024), // MB
      heapTotal: memory.heapTotal / (1024 * 1024), // MB
      external: memory.external / (1024 * 1024), // MB
      cpuUser,
      cpuSystem
    };
  }
}

/**
 * Builds a multipart/form-data request body matching Fastify's parser
 */
export function buildMultipartBody(
  filename: string,
  mimetype: string,
  fileContent: Buffer | string,
  fields: Record<string, string>,
  boundary: string
): Buffer {
  const parts: Buffer[] = [];
  
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`));
    parts.push(Buffer.from(`${value}\r\n`));
  }

  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`));
  parts.push(Buffer.from(`Content-Type: ${mimetype}\r\n\r\n`));
  parts.push(Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return Buffer.concat(parts);
}

/**
 * Generates a high-entropy buffer of a given size
 */
export function generateRandomBuffer(sizeInBytes: number): Buffer {
  // Use pseudo-random bytes if large to avoid blocking crypto entropy pool
  const buf = Buffer.alloc(sizeInBytes);
  let offset = 0;
  while (offset < sizeInBytes) {
    const chunkSize = Math.min(sizeInBytes - offset, 65536);
    const chunk = crypto.randomBytes(chunkSize);
    chunk.copy(buf, offset);
    offset += chunkSize;
  }
  return buf;
}

export interface RequestResult {
  index: number;
  success: boolean;
  statusCode: number;
  latencyMs: number;
  error?: string;
  data?: any;
}

/**
 * Executes a target request function concurrently with a max concurrency cap.
 * Spreads requests sequentially using a queue mechanism to avoid socket exhaustion.
 */
export async function runConcurrentRequests(
  totalRequests: number,
  concurrency: number,
  requestFn: (index: number) => Promise<{ statusCode: number; data?: any }>
): Promise<RequestResult[]> {
  const results: RequestResult[] = new Array(totalRequests);
  let activeCount = 0;
  let nextIndex = 0;

  return new Promise((resolve) => {
    function runNext() {
      if (nextIndex >= totalRequests && activeCount === 0) {
        resolve(results);
        return;
      }

      while (activeCount < concurrency && nextIndex < totalRequests) {
        const currentIndex = nextIndex++;
        activeCount++;

        const start = performance.now();
        requestFn(currentIndex)
          .then((res) => {
            const end = performance.now();
            results[currentIndex] = {
              index: currentIndex,
              success: res.statusCode >= 200 && res.statusCode < 300,
              statusCode: res.statusCode,
              latencyMs: end - start,
              data: res.data
            };
          })
          .catch((err) => {
            const end = performance.now();
            results[currentIndex] = {
              index: currentIndex,
              success: false,
              statusCode: err.statusCode || 500,
              latencyMs: end - start,
              error: err.message || String(err)
            };
          })
          .finally(() => {
            activeCount--;
            runNext();
          });
      }
    }

    runNext();
  });
}

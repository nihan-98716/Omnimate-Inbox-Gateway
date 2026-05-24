import crypto from 'crypto';
import { Readable } from 'stream';

/**
 * Calculates the SHA-256 hash and size of a readable stream.
 */
export async function calculateStreamHash(stream: Readable): Promise<{ hash: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;

    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve({ hash: hash.digest('hex'), size });
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Calculates the SHA-256 hash and size of a Buffer.
 */
export function calculateBufferHash(buffer: Buffer): { hash: string; size: number } {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return { hash, size: buffer.length };
}

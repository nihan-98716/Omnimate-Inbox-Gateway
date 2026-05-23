import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { config } from '../config';

export interface StorageService {
  saveToTemp(tempKey: string, stream: Readable): Promise<string>;
  moveToPermanent(tempKey: string, permanentKey: string): Promise<string>;
  deleteTemp(tempKey: string): Promise<void>;
  deleteFile(fileKey: string): Promise<void>;
  getFilePath(fileKey: string): string;
}

export class LocalStorageService implements StorageService {
  private baseDir: string;
  private tmpDir: string;

  constructor() {
    this.baseDir = path.resolve(config.UPLOAD_DIR);
    this.tmpDir = path.join(this.baseDir, 'tmp');

    // Ensure main upload directory exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }

    // Ensure temp directory exists
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
  }

  /**
   * Helper to resolve the absolute file path on disk
   */
  getFilePath(fileKey: string): string {
    return path.join(this.baseDir, fileKey);
  }

  /**
   * Saves an incoming readable stream to the temp directory
   */
  async saveToTemp(tempKey: string, stream: Readable): Promise<string> {
    const tempPath = path.join(this.tmpDir, tempKey);
    const writeStream = fs.createWriteStream(tempPath);
    await pipeline(stream, writeStream);
    return tempPath;
  }

  /**
   * Moves a file from temp storage to its permanent location in the upload directory
   */
  async moveToPermanent(tempKey: string, permanentKey: string): Promise<string> {
    const tempPath = path.join(this.tmpDir, tempKey);
    const destPath = this.getFilePath(permanentKey);
    const destDir = path.dirname(destPath);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Perform atomic move on the local file system
    await fs.promises.rename(tempPath, destPath);
    return permanentKey;
  }

  /**
   * Removes a file from the temp directory if it exists
   */
  async deleteTemp(tempKey: string): Promise<void> {
    const tempPath = path.join(this.tmpDir, tempKey);
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath);
      }
    } catch (err) {
      console.error(`⚠️ Failed to clean up temp file ${tempPath}:`, err);
    }
  }

  /**
   * Removes a file from permanent storage
   */
  async deleteFile(fileKey: string): Promise<void> {
    const destPath = this.getFilePath(fileKey);
    try {
      if (fs.existsSync(destPath) && !fs.lstatSync(destPath).isDirectory()) {
        await fs.promises.unlink(destPath);
      }
    } catch (err) {
      console.error(`⚠️ Failed to delete file ${destPath}:`, err);
    }
  }
}

export const storageService: StorageService = new LocalStorageService();

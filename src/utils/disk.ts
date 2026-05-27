import checkDiskSpace from 'check-disk-space';
import path from 'path';
import { config } from '../config';

export async function checkFreeDiskSpace(): Promise<{ ok: boolean; freePercent: number }> {
  try {
    const uploadPath = path.resolve(config.UPLOAD_DIR);
    const diskSpace = await checkDiskSpace(uploadPath);
    
    if (diskSpace.size === 0) {
      return { ok: true, freePercent: 100 };
    }
    
    const freePercent = (diskSpace.free / diskSpace.size) * 100;
    const ok = freePercent >= config.MIN_FREE_SPACE_PERCENT;
    return { ok, freePercent };
  } catch (err) {
    console.error('Disk space check failed:', err);
    return { ok: true, freePercent: 100 };
  }
}

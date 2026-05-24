import fs from 'fs';
import path from 'path';
import { PresetType } from '@prisma/client';
import { storageService } from './storage.service';

export interface PresetExecutionResult {
  success: boolean;
  executedAt: string;
  target: string;
  error?: string;
  details?: any;
}

export class PresetService {
  /**
   * Executes a preset dispatch (local folder copy or HTTP webhook) for an asset.
   */
  async execute(
    asset: { id: string; title: string; fileKey: string; mimeType: string; source: string },
    preset: { id: string; name: string; type: PresetType; config: any; schemaVersion: number }
  ): Promise<PresetExecutionResult> {
    const fileSourcePath = storageService.getFilePath(asset.fileKey);

    // Guard: Source file must exist
    if (!fs.existsSync(fileSourcePath)) {
      return {
        success: false,
        executedAt: new Date().toISOString(),
        target: preset.name,
        error: `Source file does not exist in storage: ${asset.fileKey}`
      };
    }

    // Normalize config based on schema version (Backward compatibility handling)
    const normalizedConfig = this.getNormalizedConfig(preset);

    try {
      switch (preset.type) {
        case PresetType.LOCAL_FOLDER:
          return await this.executeLocalFolder(fileSourcePath, asset.fileKey, normalizedConfig);
        case PresetType.WEBHOOK:
          return await this.executeWebhook(asset, normalizedConfig);
        default:
          return {
            success: false,
            executedAt: new Date().toISOString(),
            target: preset.name,
            error: `Preset target type ${preset.type} not supported in this run.`
          };
      }
    } catch (err: any) {
      return {
        success: false,
        executedAt: new Date().toISOString(),
        target: preset.name,
        error: err.message || String(err)
      };
    }
  }

  /**
   * Normalizes legacy preset configurations to maintain backward compatibility
   */
  private getNormalizedConfig(preset: { type: PresetType; schemaVersion: number; config: any }): any {
    const config = preset.config;
    if (preset.schemaVersion === 1) {
      // Legacy conversion: map "legacy_folder_path" to the new "destination_path" standard
      if (preset.type === PresetType.LOCAL_FOLDER && config.legacy_folder_path && !config.destination_path) {
        return {
          ...config,
          destination_path: config.legacy_folder_path
        };
      }
    }
    return config;
  }

  private async executeLocalFolder(
    sourcePath: string,
    fileKey: string,
    config: any
  ): Promise<PresetExecutionResult> {
    const destDir = config.destination_path;
    if (!destDir) {
      throw new Error("Missing parameter 'destination_path' in preset config");
    }

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const fileName = path.basename(fileKey);
    const destPath = path.join(destDir, fileName);

    await fs.promises.copyFile(sourcePath, destPath);

    return {
      success: true,
      executedAt: new Date().toISOString(),
      target: destPath,
      details: {
        copiedBytes: fs.statSync(destPath).size
      }
    };
  }

  private async executeWebhook(asset: any, config: any): Promise<PresetExecutionResult> {
    const url = config.url;
    if (!url) {
      throw new Error("Missing parameter 'url' in preset config");
    }

    const payload = {
      event: 'omnimate.inbox.asset_archived',
      asset: {
        id: asset.id,
        title: asset.title,
        fileKey: asset.fileKey,
        mimeType: asset.mimeType,
        source: asset.source
      },
      timestamp: new Date().toISOString()
    };

    const headers = config.headers || {};
    headers['Content-Type'] = 'application/json';

    // 5-second Webhook Dispatch Timeout Safeguard
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Webhook target responded with status: ${response.status} ${response.statusText}`);
      }

      let responseText = '';
      try {
        responseText = await response.text();
      } catch {}

      return {
        success: true,
        executedAt: new Date().toISOString(),
        target: url,
        details: {
          statusCode: response.status,
          response: responseText.slice(0, 500)
        }
      };
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error('Webhook request timed out after 5 seconds');
      }
      throw err;
    }
  }
}

export const presetService = new PresetService();

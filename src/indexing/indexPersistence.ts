import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface FileMetadata {
  filePath: string;
  mtime: number;
  contentHash: string;
}

export interface PersistedIndex {
  version: number;
  timestamp: number;
  fileMetadata: Map<string, FileMetadata>;
  vectorStoreData: any; // Serialized vector store
}

const INDEX_DIR = '.code-archeologist';
const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;

export class IndexPersistence {
  private indexPath: string;

  constructor(workspacePath: string) {
    this.indexPath = path.join(workspacePath, INDEX_DIR, INDEX_FILE);
  }

  /**
   * Save index to disk with file metadata
   */
  async save(data: {
    fileMetadata: Map<string, FileMetadata>;
    vectorStoreData: any;
  }): Promise<void> {
    try {
      const dir = path.dirname(this.indexPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const persisted: PersistedIndex = {
        version: INDEX_VERSION,
        timestamp: Date.now(),
        fileMetadata: data.fileMetadata,
        vectorStoreData: data.vectorStoreData,
      };

      fs.writeFileSync(
        this.indexPath,
        JSON.stringify(persisted, (key, value) => {
          if (value instanceof Map) {
            return Object.fromEntries(value);
          }
          return value;
        }, 2)
      );
    } catch (err) {
      console.error(`Failed to save index: ${err}`);
      throw err;
    }
  }

  /**
   * Load index from disk
   */
  async load(): Promise<PersistedIndex | null> {
    try {
      if (!fs.existsSync(this.indexPath)) {
        return null;
      }

      const content = fs.readFileSync(this.indexPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Convert fileMetadata back to Map
      const fileMetadata = new Map<string, FileMetadata>(
        Object.entries(parsed.fileMetadata || {})
      );

      return {
        version: parsed.version,
        timestamp: parsed.timestamp,
        fileMetadata,
        vectorStoreData: parsed.vectorStoreData,
      };
    } catch (err) {
      console.error(`Failed to load index: ${err}`);
      return null;
    }
  }

  /**
   * Delete persisted index
   */
  async delete(): Promise<void> {
    try {
      if (fs.existsSync(this.indexPath)) {
        fs.unlinkSync(this.indexPath);
      }
    } catch (err) {
      console.error(`Failed to delete index: ${err}`);
    }
  }

  /**
   * Check if index exists
   */
  exists(): boolean {
    return fs.existsSync(this.indexPath);
  }

  /**
   * Get file modification time
   */
  static getFileMtime(filePath: string): number {
    try {
      const stats = fs.statSync(filePath);
      return stats.mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Compute simple content hash
   */
  static computeContentHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /**
   * Check if file has changed
   */
  static hasFileChanged(
    oldMetadata: FileMetadata | undefined,
    newMtime: number,
    newContentHash: string
  ): boolean {
    if (!oldMetadata) return true;
    return oldMetadata.mtime !== newMtime || oldMetadata.contentHash !== newContentHash;
  }
}

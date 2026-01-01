import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { Document } from '@langchain/core/documents';

import { makeEmbeddings, withEmbeddingRetry } from '../llm/embeddings';
import { CodeChunk } from '../types';
import { IndexPersistence, FileMetadata } from './indexPersistence';

type IndexState = {
  vectorStore: MemoryVectorStore;
  chunks: CodeChunk[];
  workspaceKey: string;
  fileMetadata: Map<string, FileMetadata>;
};

let INDEX: IndexState | undefined;
let PERSISTENCE: IndexPersistence | undefined;

export async function clearIndex(): Promise<void> {
  INDEX = undefined;
  if (PERSISTENCE) {
    await PERSISTENCE.delete();
  }
}

function getWorkspaceKey(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return 'no-workspace';
  return folders.map(f => f.uri.toString()).join('|');
}

function getWorkspacePath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

function isProbablyTextFile(uri: vscode.Uri): boolean {
  const p = uri.path.toLowerCase();
  if (p.includes('/.git/')) return false;
  if (p.includes('/node_modules/')) return false;
  if (p.includes('/out/')) return false;
  if (p.includes('/dist/')) return false;
  if (p.includes('/.code-archeologist/')) return false;
  if (p.endsWith('.png') || p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.gif') || p.endsWith('.webp')) return false;
  if (p.endsWith('.ico') || p.endsWith('.zip') || p.endsWith('.pdf')) return false;
  return true;
}

function chunkByLines(uri: vscode.Uri, text: string, chunkLines: number, overlapLines: number): CodeChunk[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const chunks: CodeChunk[] = [];
  const step = Math.max(1, chunkLines - overlapLines);

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + chunkLines);
    const chunkText = lines.slice(start, end).join('\n');

    if (chunkText.trim().length === 0) continue;

    chunks.push({
      uri,
      startLine0: start,
      endLine0: Math.max(start, end - 1),
      text: chunkText
    });

    if (end === lines.length) break;
  }

  return chunks;
}

async function readWorkspaceFiles(cancellationToken?: vscode.CancellationToken): Promise<vscode.Uri[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return [];

  const uris = await vscode.workspace.findFiles('**/*', '{**/.git/**,**/node_modules/**,**/out/**,**/dist/**,**/.vscode-test/**,**/.code-archeologist/**}', 10000);

  if (cancellationToken?.isCancellationRequested) return [];

  return uris.filter(isProbablyTextFile);
}

export async function buildOrGetIndex(opts: {
  context: vscode.ExtensionContext;
  token: string;
  logger: vscode.OutputChannel;
  force: boolean;
  cancellationToken?: vscode.CancellationToken;
}): Promise<IndexState> {
  const key = getWorkspaceKey();
  const workspacePath = getWorkspacePath();

  opts.logger.appendLine('[index] buildOrGetIndex called');

  // Initialize persistence
  if (workspacePath && !PERSISTENCE) {
    opts.logger.appendLine('[index] initializing persistence layer');
    PERSISTENCE = new IndexPersistence(workspacePath);
  }

  // Return cached index if available
  if (!opts.force && INDEX && INDEX.workspaceKey === key) {
    opts.logger.appendLine('[index] using cached in-memory index');
    return INDEX;
  }

  // Try to load from disk
  if (!opts.force && PERSISTENCE && PERSISTENCE.exists()) {
    try {
      opts.logger.appendLine('[index] attempting to load from disk cache...');
      const loaded = await PERSISTENCE.load();
      if (loaded && loaded.version === 1) {
        opts.logger.appendLine('[index] loaded index from disk, rebuilding vector store...');
        const embeddings = makeEmbeddings({ token: opts.token });
        const docs = (loaded.vectorStoreData.docs || []).map((d: any) => 
          new Document({ pageContent: d.pageContent, metadata: d.metadata })
        );
        opts.logger.appendLine(`[index] creating MemoryVectorStore with ${docs.length} docs...`);
        try {
          const vectorStore = await withEmbeddingRetry(() => 
            MemoryVectorStore.fromDocuments(docs, embeddings)
          );
          INDEX = {
            vectorStore,
            chunks: loaded.vectorStoreData.chunks || [],
            workspaceKey: key,
            fileMetadata: loaded.fileMetadata
          };
        } catch (embedErr) {
          opts.logger.appendLine(`[index] failed to rebuild vector store from cache: ${embedErr}`);
          throw embedErr;
        }
        opts.logger.appendLine('[index] successfully loaded from disk cache');
        return INDEX;
      }
    } catch (err) {
      opts.logger.appendLine(`[index] failed to load cached index: ${err}`);
    }
  }

  // Full rebuild
  opts.logger.appendLine('[index] performing full index rebuild...');

  const config = vscode.workspace.getConfiguration('codeArcheologist');
  const chunkLines = Math.max(20, Math.min(400, config.get<number>('chunkLines', 80)));
  const overlapLines = Math.max(0, Math.min(200, config.get<number>('chunkOverlapLines', 20)));

  opts.logger.appendLine('[index] creating embeddings instance...');
  const embeddings = makeEmbeddings({ token: opts.token });

  opts.logger.appendLine('[index] reading workspace files...');
  const files = await readWorkspaceFiles(opts.cancellationToken);
  opts.logger.appendLine(`[index] found ${files.length} files`);

  const allChunks: CodeChunk[] = [];
  const docs: Document[] = [];
  const fileMetadata = new Map<string, FileMetadata>();

  let filesProcessed = 0;
  for (const uri of files) {
    if (opts.cancellationToken?.isCancellationRequested) {
      opts.logger.appendLine('[index] cancelled');
      break;
    }

    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(data).toString('utf8');

      // Skip huge files for MVP
      if (text.length > 600_000) continue;

      const mtime = IndexPersistence.getFileMtime(uri.fsPath);
      const contentHash = IndexPersistence.computeContentHash(text);

      const chunks = chunkByLines(uri, text, chunkLines, overlapLines);
      for (const chunk of chunks) {
        allChunks.push(chunk);
        docs.push(
          new Document({
            pageContent: chunk.text,
            metadata: {
              uri: chunk.uri.toString(),
              startLine0: chunk.startLine0,
              endLine0: chunk.endLine0
            }
          })
        );
      }

      fileMetadata.set(uri.fsPath, { filePath: uri.fsPath, mtime, contentHash });
      filesProcessed++;
      if (filesProcessed % 50 === 0) {
        opts.logger.appendLine(`[index] processed ${filesProcessed} files, ${docs.length} chunks so far`);
      }
    } catch {
      // ignore unreadable files
    }
  }

  opts.logger.appendLine(`[index] finished reading files: ${allChunks.length} chunks total`);
  
  // Limit chunks for MVP to prevent long embedding times
  const maxChunks = 2000;
  if (docs.length > maxChunks) {
    opts.logger.appendLine(`[index] limiting to ${maxChunks} chunks (was ${docs.length})`);
    docs.splice(maxChunks);
    allChunks.splice(maxChunks);
  }

  opts.logger.appendLine(`[index] creating vector store with ${docs.length} docs (this may take a minute)...`);
  let vectorStore: MemoryVectorStore;
  try {
    vectorStore = await withEmbeddingRetry(() => 
      MemoryVectorStore.fromDocuments(docs, embeddings)
    );
  } catch (err) {
    opts.logger.appendLine(`[index] failed to create vector store after retries: ${err}`);
    throw new Error(`Failed to create embeddings (HuggingFace API error): ${err instanceof Error ? err.message : String(err)}`);
  }
  opts.logger.appendLine('[index] vector store created successfully');

  INDEX = { vectorStore, chunks: allChunks, workspaceKey: key, fileMetadata };

  // Persist index to disk
  if (PERSISTENCE) {
    try {
      opts.logger.appendLine('[index] saving index to disk...');
      await PERSISTENCE.save({
        fileMetadata,
        vectorStoreData: {
          docs: docs.map(d => ({ pageContent: d.pageContent, metadata: d.metadata })),
          chunks: allChunks
        }
      });
      opts.logger.appendLine('[index] saved index to disk');
    } catch (err) {
      opts.logger.appendLine(`[index] failed to persist index: ${err}`);
    }
  }

  opts.logger.appendLine('[index] build complete!');
  return INDEX;
}

/**
 * Re-index changed files incrementally
 */
export async function incrementalReindex(
  changedFiles: string[],
  opts: {
    token: string;
    logger: vscode.OutputChannel;
    cancellationToken?: vscode.CancellationToken;
  }
): Promise<void> {
  if (!INDEX) return;

  const config = vscode.workspace.getConfiguration('codeArcheologist');
  const chunkLines = Math.max(20, Math.min(400, config.get<number>('chunkLines', 80)));
  const overlapLines = Math.max(0, Math.min(200, config.get<number>('chunkOverlapLines', 20)));

  opts.logger.appendLine(`[index] incrementally re-indexing ${changedFiles.length} files...`);

  const embeddings = makeEmbeddings({ token: opts.token });
  const changedPaths = new Set(changedFiles);

  // Remove old chunks from changed files
  INDEX.chunks = INDEX.chunks.filter(chunk => !changedPaths.has(chunk.uri.fsPath));

  // Re-index changed files
  for (const filePath of changedFiles) {
    if (!fs.existsSync(filePath)) {
      INDEX.fileMetadata.delete(filePath);
      continue;
    }

    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      if (text.length > 600_000) continue;

      const uri = vscode.Uri.file(filePath);
      const mtime = IndexPersistence.getFileMtime(filePath);
      const contentHash = IndexPersistence.computeContentHash(text);

      const chunks = chunkByLines(uri, text, chunkLines, overlapLines);
      INDEX.chunks.push(...chunks);
      INDEX.fileMetadata.set(filePath, { filePath, mtime, contentHash });
    } catch {
      // ignore unreadable files
    }
  }

  // Rebuild vector store
  const docs = INDEX.chunks.map(chunk =>
    new Document({
      pageContent: chunk.text,
      metadata: {
        uri: chunk.uri.toString(),
        startLine0: chunk.startLine0,
        endLine0: chunk.endLine0
      }
    })
  );
  INDEX.vectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);

  // Persist updated index
  if (PERSISTENCE) {
    try {
      await PERSISTENCE.save({
        fileMetadata: INDEX.fileMetadata,
        vectorStoreData: {
          docs: docs.map(d => ({ pageContent: d.pageContent, metadata: d.metadata })),
          chunks: INDEX.chunks
        }
      });
      opts.logger.appendLine('[index] saved updated index to disk');
    } catch (err) {
      opts.logger.appendLine(`[index] failed to persist updated index: ${err}`);
    }
  }
}

export type InMemoryIndex = Awaited<ReturnType<typeof buildOrGetIndex>>;

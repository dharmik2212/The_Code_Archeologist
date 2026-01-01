import type { InMemoryIndex } from '../indexing/inMemoryIndex';
import * as vscode from 'vscode';

import { CodeChunk } from '../types';

export async function findTopChunks(opts: {
  index: InMemoryIndex;
  query: string;
  topK: number;
  cancellationToken?: vscode.CancellationToken;
}): Promise<CodeChunk[]> {
  const results = await opts.index.vectorStore.similaritySearch(opts.query, opts.topK);

  const chunks: CodeChunk[] = [];
  for (const doc of results) {
    if (opts.cancellationToken?.isCancellationRequested) break;

    const uri = vscode.Uri.parse(String(doc.metadata.uri));
    const startLine0 = Number(doc.metadata.startLine0);
    const endLine0 = Number(doc.metadata.endLine0);

    chunks.push({ uri, startLine0, endLine0, text: doc.pageContent });
  }

  return chunks;
}

import { HuggingFaceInferenceEmbeddings } from '@langchain/community/embeddings/hf';
import * as vscode from 'vscode';

export function makeEmbeddings(opts: { token: string }) {
  const config = vscode.workspace.getConfiguration('codeArcheologist');
  const model = config.get<string>('embeddingModel', 'sentence-transformers/all-MiniLM-L6-v2');

  return new HuggingFaceInferenceEmbeddings({
    apiKey: opts.token,
    model,
  });
}

/**
 * Retry wrapper for embedding operations with exponential backoff
 */
export async function withEmbeddingRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isNetworkError =
        (err instanceof Error && (
          err.message.includes('fetch') ||
          err.message.includes('network') ||
          err.message.includes('timeout') ||
          err.message.includes('ECONNREFUSED') ||
          err.message.includes('ENOTFOUND')
        ));
      
      if (!isNetworkError || attempt === maxRetries) throw err;
      
      // Exponential backoff: 1s, 2s, 4s
      const delayMs = Math.pow(2, attempt - 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Embedding retry failed');
}

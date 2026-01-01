import * as vscode from 'vscode';

import { BlameResult, CodeChunk, BlamedLine } from '../types';
import { runGit } from './gitExec';
import { findRepoRootForUri } from './repo';

function parsePorcelainBlame(porcelain: string): BlamedLine[] {
  const lines = porcelain.replace(/\r\n/g, '\n').split('\n');

  const blamed: BlamedLine[] = [];
  let currentCommit = '';
  let currentFinalLine = 0;
  let currentAuthor: string | undefined;
  let currentSummary: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Header: <hash> <orig> <final> <num>
    const m = /^([0-9a-f]{8,40})\s+\d+\s+(\d+)\s+(\d+)/.exec(line);
    if (m) {
      currentCommit = m[1];
      currentFinalLine = Number(m[2]);
      currentAuthor = undefined;
      currentSummary = undefined;
      continue;
    }

    if (line.startsWith('author ')) {
      currentAuthor = line.slice('author '.length);
      continue;
    }

    if (line.startsWith('summary ')) {
      currentSummary = line.slice('summary '.length);
      continue;
    }

    // Source line begins with tab.
    if (line.startsWith('\t')) {
      if (currentFinalLine > 0 && currentCommit) {
        blamed.push({
          line1: currentFinalLine,
          commit: currentCommit,
          author: currentAuthor,
          summary: currentSummary
        });
        currentFinalLine += 1;
      }
    }
  }

  return blamed;
}

function uniqueChunks(chunks: CodeChunk[]): CodeChunk[] {
  const seen = new Set<string>();
  const out: CodeChunk[] = [];
  for (const c of chunks) {
    const key = `${c.uri.toString()}|${c.startLine0}|${c.endLine0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function getDirtyTextIfOpen(uri: vscode.Uri): string | undefined {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (!doc) return undefined;
  if (!doc.isDirty) return undefined;
  return doc.getText();
}

export async function blameRangesForChunks(opts: {
  chunks: CodeChunk[];
  cancellationToken?: vscode.CancellationToken;
}): Promise<BlameResult[]> {
  const chunks = uniqueChunks(opts.chunks);
  const results: BlameResult[] = [];

  for (const chunk of chunks) {
    if (opts.cancellationToken?.isCancellationRequested) break;

    const repoRoot = await findRepoRootForUri(chunk.uri);
    if (!repoRoot) {
      results.push({
        uri: chunk.uri,
        startLine0: chunk.startLine0,
        endLine0: chunk.endLine0,
        lines: [],
        error: 'Not a git repository (could not find repo root).'
      });
      continue;
    }

    const filePath = chunk.uri.fsPath;
    const start1 = chunk.startLine0 + 1;
    const end1 = chunk.endLine0 + 1;

    const dirtyText = getDirtyTextIfOpen(chunk.uri);
    const args = ['blame', '--porcelain', '-L', `${start1},${end1}`];

    if (dirtyText !== undefined) {
      // blame current editor buffer
      args.push('--contents', '-', '--', filePath);
    } else {
      args.push('--', filePath);
    }

    const out = await runGit({
      args,
      cwd: repoRoot,
      stdinText: dirtyText,
      cancellationToken: opts.cancellationToken
    });

    if (!out.ok) {
      results.push({
        uri: chunk.uri,
        startLine0: chunk.startLine0,
        endLine0: chunk.endLine0,
        lines: [],
        raw: out.stdout,
        error: out.stderr.trim() || 'git blame failed'
      });
      continue;
    }

    results.push({
      uri: chunk.uri,
      startLine0: chunk.startLine0,
      endLine0: chunk.endLine0,
      lines: parsePorcelainBlame(out.stdout),
      raw: out.stdout
    });
  }

  return results;
}

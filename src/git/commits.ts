import * as vscode from 'vscode';
import * as path from 'node:path';

import { BlameResult } from '../types';
import { findRepoRootForUri } from './repo';
import { runGit } from './gitExec';

export type CommitContext = {
  commit: string;
  author?: string;
  authorTime?: string;
  subject?: string;
  repoRoot?: string;
  patches?: Array<{ file: string; patch: string }>;
};

function uniqueCommits(blame: BlameResult[]): string[] {
  const commits = new Set<string>();
  for (const b of blame) {
    for (const line of b.lines) {
      if (line.commit) commits.add(line.commit);
    }
  }
  return [...commits];
}

function commitToFiles(blame: BlameResult[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const b of blame) {
    const file = b.uri.fsPath;
    for (const line of b.lines) {
      if (!line.commit) continue;
      const set = map.get(line.commit) ?? new Set<string>();
      set.add(file);
      map.set(line.commit, set);
    }
  }
  return map;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... (truncated, ${text.length - maxChars} more chars)`;
}

export async function getCommitContexts(opts: {
  blame: BlameResult[];
  cancellationToken?: vscode.CancellationToken;
}): Promise<Map<string, CommitContext>> {
  const map = new Map<string, CommitContext>();
  const commits = uniqueCommits(opts.blame).slice(0, 15); // cap for prompt size
  const filesByCommit = commitToFiles(opts.blame);

  // Find any repo root we can use. (commits are per-repo; for multi-repo, we keep best effort.)
  const anyUri = opts.blame.find((b) => b.uri)?.uri;
  if (!anyUri) return map;

  const repoRoot = await findRepoRootForUri(anyUri);
  if (!repoRoot) return map;

  for (const sha of commits) {
    if (opts.cancellationToken?.isCancellationRequested) break;

    // Use a stable delimiter to parse.
    const out = await runGit({
      cwd: repoRoot,
      args: ['show', '-s', `--format=%H\u001f%an\u001f%ad\u001f%s`, sha],
      cancellationToken: opts.cancellationToken
    });

    if (!out.ok) {
      map.set(sha, { commit: sha, subject: 'git show failed' });
      continue;
    }

    const line = out.stdout.trim();
    const [commit, author, authorTime, subject] = line.split('\u001f');

    const patches: Array<{ file: string; patch: string }> = [];
    const files = [...(filesByCommit.get(sha) ?? new Set<string>())].slice(0, 2);
    for (const absFile of files) {
      if (opts.cancellationToken?.isCancellationRequested) break;
      const rel = path.relative(repoRoot, absFile);

      // Keep diff small and stable; no color, minimal context.
      const diff = await runGit({
        cwd: repoRoot,
        args: ['show', '--no-color', '-U0', sha, '--', rel],
        cancellationToken: opts.cancellationToken
      });

      if (diff.ok) {
        patches.push({ file: rel, patch: truncate(diff.stdout.trim(), 3500) });
      }
    }

    map.set(sha, {
      commit: commit || sha,
      author,
      authorTime,
      subject,
      repoRoot,
      patches: patches.length ? patches : undefined
    });
  }

  return map;
}

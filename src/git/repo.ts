import * as vscode from 'vscode';
import * as path from 'node:path';

import { runGit } from './gitExec';

export async function findRepoRootForUri(uri: vscode.Uri): Promise<string | undefined> {
  // Prefer VS Code's Git extension to correctly pick the repo in multi-root.
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (gitExt) {
      const git = await gitExt.activate();
      const api = git?.getAPI?.(1);
      if (api) {
        const repo = api.getRepository(uri);
        if (repo?.rootUri?.fsPath) return repo.rootUri.fsPath;
      }
    }
  } catch {
    // fall through
  }

  // Fallback to asking git directly.
  const cwd = uri.fsPath ? path.dirname(uri.fsPath) : undefined;
  if (!cwd) return undefined;

  const out = await runGit({ args: ['rev-parse', '--show-toplevel'], cwd });
  if (!out.ok) return undefined;

  const root = out.stdout.trim();
  return root.length ? root : undefined;
}

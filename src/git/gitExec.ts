import { spawn } from 'node:child_process';
import type * as vscode from 'vscode';

export type GitRunResult = { ok: boolean; stdout: string; stderr: string };

export function runGit(opts: {
  args: string[];
  cwd: string;
  stdinText?: string;
  cancellationToken?: vscode.CancellationToken;
}): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', opts.args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    const onCancel = () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    };

    if (opts.cancellationToken) {
      if (opts.cancellationToken.isCancellationRequested) onCancel();
      opts.cancellationToken.onCancellationRequested(onCancel);
    }

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    child.on('error', (e) => {
      resolve({ ok: false, stdout, stderr: stderr + String(e) });
    });

    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });

    if (opts.stdinText !== undefined) {
      child.stdin.write(opts.stdinText);
    }
    child.stdin.end();
  });
}

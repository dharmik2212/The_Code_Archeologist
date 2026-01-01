import * as vscode from 'vscode';

import { buildOrGetIndex, clearIndex, incrementalReindex } from './indexing/inMemoryIndex';
import { findTopChunks } from './retrieval/search';
import { blameRangesForChunks } from './git/blame';
import { getCommitContexts } from './git/commits';
import { generateAnswer } from './llm/answer';
import { clearHfToken, getHfToken, setHfToken } from './secrets';
import { ChatPanelProvider } from './webview/chatPanel';

const output = vscode.window.createOutputChannel('Code Archeologist');

// Track files needing re-indexing
let pendingReindexFiles = new Set<string>();
let reindexTimeout: NodeJS.Timeout | null = null;

export async function activate(context: vscode.ExtensionContext) {
  output.appendLine('Activating Code Archeologist...');

  // Load cached index on startup
  const hfToken = await getHfToken(context);
  if (hfToken && vscode.workspace.workspaceFolders) {
    output.appendLine('[startup] loading cached index if available...');
    try {
      await buildOrGetIndex({ context, token: hfToken, logger: output, force: false });
    } catch (err) {
      output.appendLine(`[startup] failed to load cached index: ${err}`);
    }
  }

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('codeArcheologist.setHfToken', async () => {
      await setHfToken(context);
    }),
    vscode.commands.registerCommand('codeArcheologist.clearHfToken', async () => {
      await clearHfToken(context);
    }),
    vscode.commands.registerCommand('codeArcheologist.reindex', async () => {
      const token = await getHfToken(context);
      if (!token) {
        vscode.window.showErrorMessage('Set a Hugging Face token first.');
        return;
      }
      await clearIndex();
      await buildOrGetIndex({ context, token, logger: output, force: true });
      vscode.window.showInformationMessage('Code Archeologist: indexed workspace in memory.');
    })
  );

  // Watch for file changes and queue re-indexing
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!e.document.isDirty) return;
      const fsPath = e.document.uri.fsPath;
      pendingReindexFiles.add(fsPath);
      scheduleReindex(context);
    }),
    vscode.workspace.onDidCreateFiles(e => {
      for (const uri of e.files) {
        pendingReindexFiles.add(uri.fsPath);
      }
      scheduleReindex(context);
    }),
    vscode.workspace.onDidDeleteFiles(e => {
      for (const uri of e.files) {
        pendingReindexFiles.add(uri.fsPath);
      }
      scheduleReindex(context);
    })
  );

  const participant = vscode.chat.createChatParticipant(
    'code-archeologist',
    async (
      request: vscode.ChatRequest,
      _chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      cancellationToken: vscode.CancellationToken
    ) => {
      try {
        const hfToken = await getHfToken(context);
        if (!hfToken) {
          stream.markdown('Set a Hugging Face token first: run **Code Archeologist: Set Hugging Face Token**.');
          return;
        }

        const config = vscode.workspace.getConfiguration('codeArcheologist');
        const topK = Math.max(1, Math.min(20, config.get<number>('topK', 6)));

        stream.progress('Indexing (in-memory) if needed...');
        const index = await buildOrGetIndex({
          context,
          token: hfToken,
          logger: output,
          force: false,
          cancellationToken
        });

        stream.progress('Retrieving relevant code...');
        const chunks = await findTopChunks({ index, query: request.prompt, topK, cancellationToken });

        if (chunks.length === 0) {
          stream.markdown('I could not find any relevant code in this workspace.');
          return;
        }

        stream.progress('Running git blame for relevant lines (includes unsaved edits)...');
        const blame = await blameRangesForChunks({ chunks, cancellationToken });

        stream.progress('Fetching commit context for blamed lines...');
        const commitContext = await getCommitContexts({ blame, cancellationToken });

        stream.progress('Generating final answer...');
        const answer = await generateAnswer({
          token: hfToken,
          question: request.prompt,
          chunks,
          blame,
          commitContext,
          cancellationToken
        });

        stream.markdown(answer);

        // Make results clickable.
        for (const chunk of chunks) {
          stream.reference(
            new vscode.Location(
              chunk.uri,
              new vscode.Range(chunk.startLine0, 0, chunk.endLine0, 0)
            )
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`[error] ${message}`);
        stream.markdown(`Error: ${message}`);
      }
    }
  );

  participant.iconPath = vscode.ThemeIcon.File;
  context.subscriptions.push(participant);

  // Register the sidebar webview provider
  const chatPanelProvider = new ChatPanelProvider(context, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatPanelProvider.viewType,
      chatPanelProvider
    )
  );
}

/**
 * Schedule incremental re-indexing with debouncing (1 second)
 */
function scheduleReindex(context: vscode.ExtensionContext) {
  if (reindexTimeout) clearTimeout(reindexTimeout);

  reindexTimeout = setTimeout(async () => {
    if (pendingReindexFiles.size === 0) return;

    const files = Array.from(pendingReindexFiles);
    pendingReindexFiles.clear();

    try {
      const hfToken = await getHfToken(context);
      if (!hfToken) return;

      output.appendLine(`[reindex] updating ${files.length} changed file(s)...`);
      await incrementalReindex(files, { token: hfToken, logger: output });
      output.appendLine('[reindex] done');
    } catch (err) {
      output.appendLine(`[reindex] error: ${err}`);
    }
  }, 1000);
}

export function deactivate() {}

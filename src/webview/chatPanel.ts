import * as vscode from 'vscode';
import { findTopChunks } from '../retrieval/search';
import { blameRangesForChunks } from '../git/blame';
import { getCommitContexts } from '../git/commits';
import { generateAnswer } from '../llm/answer';
import { buildOrGetIndex } from '../indexing/inMemoryIndex';
import { getHfToken } from '../secrets';

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codeArcheologist.chatPanel';

  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: vscode.OutputChannel
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent();

    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message);
    });
  }

  private async handleMessage(message: any) {
    if (message.command === 'ask') {
      const question = message.text;
      if (!question || !question.trim()) {
        this.postMessage({ type: 'error', text: 'Please enter a question.' });
        return;
      }

      try {
        const hfToken = await getHfToken(this.context);
        if (!hfToken) {
          this.postMessage({
            type: 'error',
            text: 'Set a Hugging Face token first. Run: Code Archeologist: Set Hugging Face Token',
          });
          return;
        }

        this.postMessage({ type: 'progress', text: 'Indexing workspace if needed...' });
        
        // Create cancellation token with timeout
        const cts = new vscode.CancellationTokenSource();
        const timeoutHandle = setTimeout(() => cts.cancel(), 120000); // 2 minute timeout
        
        try {
          const index = await buildOrGetIndex({
            context: this.context,
            token: hfToken,
            logger: this.logger,
            force: false,
            cancellationToken: cts.token,
          });
          clearTimeout(timeoutHandle);

          this.postMessage({ type: 'progress', text: 'Retrieving relevant code...' });
          const config = vscode.workspace.getConfiguration('codeArcheologist');
          const topK = Math.max(1, Math.min(20, config.get<number>('topK', 6)));
          const chunks = await findTopChunks({ index, query: question, topK, cancellationToken: cts.token });

          if (chunks.length === 0) {
            this.postMessage({ type: 'answer', text: 'No relevant code found in this workspace.' });
            return;
          }

          this.postMessage({ type: 'progress', text: 'Running git blame...' });
          const blame = await blameRangesForChunks({ chunks, cancellationToken: cts.token });

          this.postMessage({ type: 'progress', text: 'Fetching commit context...' });
          const commitContext = await getCommitContexts({ blame, cancellationToken: cts.token });

          this.postMessage({ type: 'progress', text: 'Generating answer...' });
          const answer = await generateAnswer({
            token: hfToken,
            question,
            chunks,
            blame,
            commitContext,
            cancellationToken: cts.token,
          });

          this.postMessage({ type: 'answer', text: answer });

          // Send references with blame info
          for (const chunk of chunks) {
            const blameInfo = blame.find(b => b.uri.toString() === chunk.uri.toString());
            const author = blameInfo?.lines?.[0]?.author || 'unknown';
            this.postMessage({
              type: 'reference',
              uri: chunk.uri.toString(),
              startLine: chunk.startLine0,
              endLine: chunk.endLine0,
              blame: blameInfo ? { author } : undefined,
            });
          }
        } finally {
          clearTimeout(timeoutHandle);
          cts.dispose();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.appendLine(`[error] ${message}`);
        this.postMessage({ type: 'error', text: `Error: ${message}` });
      }
    } else if (message.command === 'openFile') {
      const uri = vscode.Uri.parse(message.uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const start = new vscode.Position(message.startLine, 0);
      const end = new vscode.Position(message.endLine, 0);
      editor.selection = new vscode.Selection(start, start);
      editor.revealRange(new vscode.Range(start, end));
    }
  }

  private postMessage(message: any) {
    if (this.view) {
      this.view.webview.postMessage(message);
    }
  }

  private getHtmlContent(): string {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Archeologist</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    html, body {
      height: 100%;
      width: 100%;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    .chat-container {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    
    .messages-area {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scroll-behavior: smooth;
    }
    
    .messages-area::-webkit-scrollbar {
      width: 8px;
    }
    
    .messages-area::-webkit-scrollbar-track {
      background: transparent;
    }
    
    .messages-area::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 4px;
    }
    
    .message {
      display: flex;
      gap: 8px;
      animation: slideIn 0.3s ease-out;
    }
    
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    .message.user {
      justify-content: flex-end;
    }
    
    .message.assistant {
      justify-content: flex-start;
    }
    
    .message-bubble {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 12px;
      line-height: 1.5;
      word-wrap: break-word;
      font-size: 13px;
    }
    
    .message.user .message-bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 18px 4px 18px 18px;
    }
    
    .message.assistant .message-bubble {
      background: var(--vscode-editor-lineHighlightBackground);
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      border-radius: 4px 18px 18px 4px;
    }
    
    .message.progress .message-bubble {
      background: var(--vscode-editorInfo-background);
      color: var(--vscode-editorInfo-foreground);
      border-left: 3px solid var(--vscode-editorInfo-foreground);
      border-radius: 4px;
      padding: 8px 12px;
    }
    
    .thinking-dots {
      display: inline-flex;
      gap: 4px;
      align-items: center;
    }
    
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      animation: thinking 1.4s infinite;
    }
    
    .dot:nth-child(1) {
      animation-delay: 0ms;
    }
    
    .dot:nth-child(2) {
      animation-delay: 200ms;
    }
    
    .dot:nth-child(3) {
      animation-delay: 400ms;
    }
    
    @keyframes thinking {
      0%, 60%, 100% {
        opacity: 0.3;
        transform: translateY(0);
      }
      30% {
        opacity: 1;
        transform: translateY(-6px);
      }
    }
    
    .message.error .message-bubble {
      background: var(--vscode-editorError-background);
      color: var(--vscode-editorError-foreground);
      border-left: 3px solid var(--vscode-editorError-foreground);
      border-radius: 4px;
      padding: 8px 12px;
    }
    
    .code-block {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      margin-top: 8px;
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      overflow-x: auto;
    }
    
    .code-lang {
      color: var(--vscode-editorInfo-foreground);
      font-size: 11px;
      margin-bottom: 6px;
      font-weight: 500;
    }
    
    .code-content {
      color: var(--vscode-editor-foreground);
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    
    .reference {
      margin-top: 8px;
      padding: 8px 12px;
      background: var(--vscode-editor-lineHighlightBackground);
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: inline-block;
    }
    
    .reference:hover {
      background: var(--vscode-list-hoverBackground);
      transform: translateY(-2px);
    }
    
    .input-area {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 12px;
      background: var(--vscode-editor-background);
      flex-shrink: 0;
    }
    
    .input-group {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    
    #questionInput {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid var(--vscode-input-border);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 13px;
      border-radius: 8px;
      font-family: inherit;
      resize: none;
      max-height: 100px;
      line-height: 1.4;
    }
    
    #questionInput:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 2px rgba(100, 150, 255, 0.1);
    }
    
    #askButton {
      padding: 10px 16px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      transition: all 0.2s ease;
      flex-shrink: 0;
    }
    
    #askButton:hover:not(:disabled) {
      background-color: var(--vscode-button-hoverBackground);
      transform: translateY(-1px);
    }
    
    #askButton:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 16px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: 32px;
    }
    
    .empty-state-icon {
      font-size: 48px;
      opacity: 0.5;
    }
    
    .empty-state-text {
      font-size: 13px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="chat-container">
    <div class="messages-area" id="messages">
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-text">
          <strong>Code Archeologist</strong><br>
          Ask a question about your codebase
        </div>
      </div>
    </div>
    <div class="input-area">
      <div class="input-group">
        <textarea 
          id="questionInput" 
          placeholder="Ask about your code..." 
          rows="1"
          autocomplete="off"
        ></textarea>
        <button id="askButton">Send</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const questionInput = document.getElementById('questionInput');
    const askButton = document.getElementById('askButton');
    const messagesContainer = document.getElementById('messages');

    let isFirstMessage = true;

    questionInput.addEventListener('input', () => {
      questionInput.style.height = 'auto';
      questionInput.style.height = Math.min(questionInput.scrollHeight, 100) + 'px';
    });

    questionInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        askButton.click();
      }
    });

    let inFlightTimer: number | null = null;

    askButton.addEventListener('click', () => {
      const text = questionInput.value.trim();
      if (text) {
        if (isFirstMessage) {
          messagesContainer.innerHTML = '';
          isFirstMessage = false;
        }

        const userMsg = document.createElement('div');
        userMsg.className = 'message user';
        userMsg.innerHTML = '<div class="message-bubble">' + escapeHtml(text) + '</div>';
        messagesContainer.appendChild(userMsg);

        vscode.postMessage({ command: 'ask', text });
        questionInput.value = '';
        questionInput.style.height = 'auto';
        askButton.disabled = true;
        // Safety: re-enable if no response arrives in time
        if (inFlightTimer) {
          clearTimeout(inFlightTimer);
        }
        inFlightTimer = window.setTimeout(() => {
          askButton.disabled = false;
          lastProgress?.remove();
          lastProgress = null;
        }, 120000);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    });

    let lastProgress: HTMLElement | null = null;

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.type === 'progress') {
        if (!lastProgress) {
          lastProgress = document.createElement('div');
          lastProgress.className = 'message progress';
          lastProgress.innerHTML = '<div class="message-bubble"><span class="thinking-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>';
          messagesContainer.appendChild(lastProgress);
        }
      } else if (message.type === 'answer') {
        askButton.disabled = false;
        if (inFlightTimer) {
          clearTimeout(inFlightTimer);
          inFlightTimer = null;
        }
        lastProgress = null;
        const msg = document.createElement('div');
        msg.className = 'message assistant';
        const content = formatText(message.text);
        msg.innerHTML = '<div class="message-bubble">' + content + '</div>';
        messagesContainer.appendChild(msg);
      } else if (message.type === 'reference') {
        const ref = document.createElement('div');
        ref.className = 'reference';
        const path = message.uri.replace(/^file:\\/\\//,'').split('\\\\').pop() || message.uri;
        let refText = '📄 ' + path + ' (lines ' + (message.startLine + 1) + '-' + (message.endLine + 1) + ')';
        if (message.blame) {
          refText += ' - by ' + message.blame.author;
        }
        ref.textContent = refText;
        ref.addEventListener('click', () => {
          vscode.postMessage({ command: 'openFile', uri: message.uri, startLine: message.startLine, endLine: message.endLine });
        });
        if (messagesContainer.lastChild && messagesContainer.lastChild.classList.contains('assistant')) {
          messagesContainer.lastChild.querySelector('.message-bubble').appendChild(ref);
        }
      } else if (message.type === 'error') {
        askButton.disabled = false;
        if (inFlightTimer) {
          clearTimeout(inFlightTimer);
          inFlightTimer = null;
        }
        lastProgress = null;
        const msg = document.createElement('div');
        msg.className = 'message error';
        msg.innerHTML = '<div class="message-bubble">' + escapeHtml(message.text) + '</div>';
        messagesContainer.appendChild(msg);
      }
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatText(text) {
      return escapeHtml(text).replace(/\\n/g, '<br>');
    }
  </script>
</body>
</html>`;
    return html;
  }
}

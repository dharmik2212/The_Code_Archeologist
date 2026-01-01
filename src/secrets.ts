import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

const SECRET_KEY = 'codeArcheologist.hfToken';

// Load .env file
function loadEnv() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const envPath = path.join(workspaceFolders[0].uri.fsPath, '.env');
    if (fs.existsSync(envPath)) {
      const envConfig = dotenv.parse(fs.readFileSync(envPath));
      return envConfig;
    }
  }
  return {};
}

export async function getHfToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  // First check SecretStorage (user-provided token takes priority)
  const fromSecret = await context.secrets.get(SECRET_KEY);
  if (fromSecret) return fromSecret;

  // Then check .env file
  const envConfig = loadEnv();
  if (envConfig.HF_TOKEN) return envConfig.HF_TOKEN;

  // Fallback to environment variables
  const fromEnv = process.env.HF_TOKEN || process.env.HUGGINGFACEHUB_API_TOKEN || process.env.HUGGINGFACEHUB_API_KEY;
  return fromEnv || undefined;
}

export function getGithubToken(): string | undefined {
  // First check env file
  const envConfig = loadEnv();
  if (envConfig.GITHUB_TOKEN) return envConfig.GITHUB_TOKEN;

  // Fallback to environment variables
  return process.env.GITHUB_TOKEN || undefined;
}

export async function setHfToken(context: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: 'Hugging Face Token',
    prompt: 'Paste your Hugging Face access token (stored in VS Code SecretStorage).',
    password: true,
    ignoreFocusOut: true
  });

  if (!token) return;

  await context.secrets.store(SECRET_KEY, token);
  vscode.window.showInformationMessage('Code Archeologist: Hugging Face token stored.');
}

export async function clearHfToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
  vscode.window.showInformationMessage('Code Archeologist: Hugging Face token cleared.');
}

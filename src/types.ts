import * as vscode from 'vscode';

export type CodeChunk = {
  uri: vscode.Uri;
  startLine0: number;
  endLine0: number;
  text: string;
};

export type BlamedLine = {
  line1: number; // 1-based
  commit: string;
  author?: string;
  summary?: string;
};

export type BlameResult = {
  uri: vscode.Uri;
  startLine0: number;
  endLine0: number;
  lines: BlamedLine[];
  raw?: string;
  error?: string;
};

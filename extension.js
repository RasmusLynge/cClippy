const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CLIPPY_IMAGES = ['DefaultClippy.png', 'WaveClippy.png', 'WinkClippy.png', 'ThinkingClippy.png', 'AfraidClippy.png', 'RelaxClippy.png'];

/** @type {vscode.WebviewPanel | undefined} */
let clippyPanel;

/**
 * The code change the panel's Apply button would make, if any.
 * @type {{ uri: vscode.Uri, line: number, endLine: number, originalLines: string[], codeExample: string } | undefined}
 */
let pendingSuggestion;

/**
 * @typedef {object} ClippyReply
 * @property {string} message Short speech-bubble text.
 * @property {string} image File name in ClippyImage/.
 * @property {string} recommendation Explanation of the suggested change; empty when there is none.
 * @property {number} line 1-based first file line that codeExample replaces; 0 when unknown or none.
 * @property {number} endLine 1-based last file line that codeExample replaces; 0 when unknown or none.
 * @property {string} codeExample Suggested code shown under the recommendation; empty when there is none.
 */

/**
 * Sends a prompt to the local Ollama server and returns the model's reply.
 * @param {string} fileText
 * @param {string} fileName
 * @returns {Promise<ClippyReply>}
 */
async function askOllama(fileText, fileName) {
  const config = vscode.workspace.getConfiguration('clippy');
  const url = config.get('ollamaUrl', 'http://host.docker.internal:11434');
  const model = config.get('model', 'qwen3.5:4b');

  const template = await fs.readFile(path.join(__dirname, 'ClippyPromt', 'SarcasticPromt.md'), 'utf8');
  // Number the lines so the model can point at the exact line its recommendation is about.
  const numberedCode = fileText
    .split(/\r?\n/)
    .map((text, i) => `${i + 1} | ${text}`)
    .join('\n');
  const prompt = template
    .replaceAll('{{fileName}}', () => fileName)
    .replaceAll('{{code}}', () => numberedCode);

  const response = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      // Thinking models (e.g. qwen3.5) otherwise put the whole reply in `thinking` and leave `response` empty.
      think: false,
      format: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          image: { type: 'string', enum: CLIPPY_IMAGES },
          recommendation: { type: 'string' },
          line: { type: 'integer' },
          endLine: { type: 'integer' },
          codeExample: { type: 'string' }
        },
        required: ['message', 'image', 'recommendation', 'line', 'endLine', 'codeExample']
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const reply = JSON.parse(data.response);
  const image = CLIPPY_IMAGES.includes(reply.image) ? reply.image : 'DefaultClippy.png';
  // Line numbers are shown next to the code, so drop a "Line N:" the model wrote at the start.
  const recommendation = String(reply.recommendation ?? '').trim().replace(/^line\s+\d+\s*[:\-–]\s*/i, '');
  const lineCount = fileText.split(/\r?\n/).length;
  const line = Number.isInteger(reply.line) && reply.line >= 1 && reply.line <= lineCount ? reply.line : 0;
  const endLine = line && Number.isInteger(reply.endLine) && reply.endLine >= line && reply.endLine <= lineCount
    ? reply.endLine
    : line;
  // Keep only the code if the model wrapped it in markdown fences anyway.
  let codeExample = recommendation
    ? String(reply.codeExample ?? '').replace(/^\s*```[\w-]*\n?|\n?```\s*$/g, '').replace(/^\n+|\s+$/g, '')
    : '';
  // Small models often drop the indentation; indent the suggestion to match the line it replaces.
  if (codeExample && line) {
    const originalIndent = fileText.split(/\r?\n/)[line - 1].match(/^\s*/)[0];
    const codeIndent = codeExample.match(/^[ \t]*/)[0];
    if (originalIndent.length > codeIndent.length && originalIndent.startsWith(codeIndent)) {
      const extra = originalIndent.slice(codeIndent.length);
      codeExample = codeExample.split('\n').map((text) => (text.trim() ? extra + text : text)).join('\n');
    }
  }
  // Clippy always opens with "Looks like"; add it if the model forgot.
  let message = String(reply.message).trim();
  if (/^looks like\b/i.test(message)) {
    message = message.replace(/^looks like/i, 'Looks like');
  } else {
    message = `Looks like ${message.charAt(0).toLowerCase()}${message.slice(1)}`;
  }
  return { message, image, recommendation, line, endLine, codeExample };
}

/**
 * Shows Clippy's message and image in a panel beside the editor, reusing it between saves.
 * @param {vscode.ExtensionContext} context
 * @param {Pick<ClippyReply, 'message' | 'image'> & Partial<ClippyReply>} reply
 * @param {{ uri: vscode.Uri, fileText: string }} [source] The file and text Clippy reviewed; enables the Apply button.
 */
function showClippy(context, { message, image, recommendation = '', line = 0, endLine = 0, codeExample = '' }, source) {
  const imageDir = vscode.Uri.joinPath(context.extensionUri, 'ClippyImage');

  pendingSuggestion = source && recommendation && codeExample && line
    ? {
      uri: source.uri,
      line,
      endLine,
      originalLines: source.fileText.split(/\r?\n/).slice(line - 1, endLine),
      codeExample
    }
    : undefined;

  if (clippyPanel) {
    clippyPanel.reveal(undefined, true);
  } else {
    clippyPanel = vscode.window.createWebviewPanel(
      'clippy',
      'Clippy',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { localResourceRoots: [imageDir], enableScripts: true }
    );
    clippyPanel.onDidDispose(() => { clippyPanel = undefined; });
    clippyPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'apply' && await applySuggestion()) {
        clippyPanel?.webview.postMessage({ type: 'applied' });
      }
    });
  }

  const webview = clippyPanel.webview;
  const nonce = crypto.randomBytes(16).toString('base64');
  const imageUri = webview.asWebviewUri(vscode.Uri.joinPath(imageDir, image));
  const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  // Render the code like the editor: a line-number gutter (starting at `line`) beside each row.
  const applyHtml = pendingSuggestion
    ? `<div class="code-toolbar"><button id="apply" title="Replace line${line === endLine ? ` ${line}` : `s ${line}-${endLine}`} with this code">Apply</button></div>`
    : '';
  const codeHtml = codeExample
    ? `${applyHtml}<pre class="code">${codeExample.split('\n').map((text, i) =>
      `<span class="code-line"><span class="line-number">${line ? line + i : ''}</span><span class="line-text">${escapeHtml(text) || ' '}</span></span>`
    ).join('')}</pre>`
    : '';
  const recommendationHtml = recommendation
    ? `<div class="recommendation">
    <p>${escapeHtml(recommendation)}</p>
    ${codeHtml}
  </div>`
    : '';

  webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body { display: flex; flex-direction: column; align-items: center; padding: 16px; font-family: var(--vscode-font-family); }
    .bubble { background: #ffffcc; color: #000; border: 1px solid #000; border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; font-size: 1.1em; }
    img { max-width: 180px; }
    .recommendation { margin-top: 12px; width: 100%; max-width: 480px; box-sizing: border-box; padding: 8px 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 4px; }
    .recommendation p { margin: 0; white-space: pre-wrap; }
    .code-toolbar { display: flex; justify-content: flex-end; margin-top: 8px; }
    .code-toolbar button { padding: 2px 10px; font-family: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 2px; cursor: pointer; }
    .code-toolbar button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .code-toolbar button:disabled { opacity: 0.6; cursor: default; }
    .code { margin: 4px 0 0; padding: 6px 0; overflow-x: auto; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 4px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; }
    .code-line { display: flex; }
    .line-number { flex: none; min-width: 3ch; padding: 0 12px 0 8px; text-align: right; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
    .line-text { white-space: pre; padding-right: 12px; }
  </style>
</head>
<body>
  <div class="bubble">${escapeHtml(message)}</div>
  <img src="${imageUri}" alt="Clippy">
  ${recommendationHtml}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const applyButton = document.getElementById('apply');
    applyButton?.addEventListener('click', () => vscode.postMessage({ type: 'apply' }));
    window.addEventListener('message', (event) => {
      if (event.data.type === 'applied' && applyButton) {
        applyButton.textContent = 'Applied';
        applyButton.disabled = true;
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Replaces the lines Clippy reviewed with its suggested code, like Copilot's Apply.
 * Refuses if those lines changed since the save, so it never overwrites the wrong code.
 * @returns {Promise<boolean>} Whether the edit was applied.
 */
async function applySuggestion() {
  const suggestion = pendingSuggestion;
  if (!suggestion) {
    return false;
  }

  const document = await vscode.workspace.openTextDocument(suggestion.uri);
  const { line, endLine, originalLines, codeExample } = suggestion;
  const currentLines = endLine <= document.lineCount
    ? Array.from({ length: endLine - line + 1 }, (_, i) => document.lineAt(line - 1 + i).text)
    : [];
  if (currentLines.join('\n') !== originalLines.join('\n')) {
    vscode.window.showWarningMessage('Clippy: that code has changed since Clippy looked at it. Save again for a fresh suggestion.');
    return false;
  }

  const range = new vscode.Range(line - 1, 0, endLine - 1, document.lineAt(endLine - 1).text.length);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(suggestion.uri, range, codeExample);
  if (!await vscode.workspace.applyEdit(edit)) {
    vscode.window.showErrorMessage('Clippy: could not apply the suggestion.');
    return false;
  }
  pendingSuggestion = undefined;

  // Show the file with the new code selected, in the editor it was already open in.
  const codeLines = codeExample.split('\n');
  const newEnd = new vscode.Position(line - 2 + codeLines.length, codeLines[codeLines.length - 1].length);
  const existingEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === suggestion.uri.toString());
  const editor = await vscode.window.showTextDocument(document, { viewColumn: existingEditor?.viewColumn ?? vscode.ViewColumn.One });
  editor.selection = new vscode.Selection(range.start, newEnd);
  editor.revealRange(editor.selection);
  return true;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // onDidSave doesn't say why a file was saved, so remember which saves were manual (Ctrl+S)
  // and skip auto-saves (after delay or on focus change).
  const manualSaves = new Set();
  // Incremented per request so a slow, older reply can't overwrite a newer one.
  let latestRequest = 0;

  const willSaveDisposable = vscode.workspace.onWillSaveTextDocument((event) => {
    const key = event.document.uri.toString();
    if (event.reason === vscode.TextDocumentSaveReason.Manual) {
      manualSaves.add(key);
    } else {
      manualSaves.delete(key);
    }
  });

  const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (!manualSaves.delete(document.uri.toString())) {
      return;
    }

    const request = ++latestRequest;
    showClippy(context, { message: 'Let me take a look…', image: 'DefaultClippy.png' });

    try {
      const fileText = document.getText();
      const reply = await askOllama(fileText, path.basename(document.fileName));
      if (request === latestRequest) {
        showClippy(context, reply, { uri: document.uri, fileText });
      }
    } catch (err) {
      if (request === latestRequest) {
        showClippy(context, { message: 'Oops, something went wrong.', image: 'DefaultClippy.png' });
      }
      vscode.window.showErrorMessage(`Clippy: could not reach Ollama (${err.message})`);
    }
  });

  context.subscriptions.push(willSaveDisposable, saveDisposable);
}

function deactivate() { }

module.exports = {
  activate,
  deactivate
};

const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');

const CLIPPY_IMAGES = ['DefaultClippy.png', 'WaveClippy.png', 'WinkClippy.png', 'ThinkingClippy.png', 'AfraidClippy.png', 'RelaxClippy.png'];

/** @type {vscode.WebviewPanel | undefined} */
let clippyPanel;

/**
 * @typedef {object} ClippyReply
 * @property {string} message Short speech-bubble text.
 * @property {string} image File name in ClippyImage/.
 * @property {string} recommendation Explanation of the suggested change; empty when there is none.
 * @property {number} line 1-based file line where codeExample starts, used to number its rows; 0 when unknown or none.
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
  const model = config.get('model', 'gemma3:12b');

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
      format: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          image: { type: 'string', enum: CLIPPY_IMAGES },
          recommendation: { type: 'string' },
          line: { type: 'integer' },
          codeExample: { type: 'string' }
        },
        required: ['message', 'image', 'recommendation', 'line', 'codeExample']
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
  // Keep only the code if the model wrapped it in markdown fences anyway.
  const codeExample = recommendation
    ? String(reply.codeExample ?? '').replace(/^\s*```[\w-]*\n?|\n?```\s*$/g, '').replace(/^\n+|\s+$/g, '')
    : '';
  // Clippy always opens with "Looks like"; add it if the model forgot.
  let message = String(reply.message).trim();
  if (/^looks like\b/i.test(message)) {
    message = message.replace(/^looks like/i, 'Looks like');
  } else {
    message = `Looks like ${message.charAt(0).toLowerCase()}${message.slice(1)}`;
  }
  return { message, image, recommendation, line, codeExample };
}

/**
 * Shows Clippy's message and image in a panel beside the editor, reusing it between saves.
 * @param {vscode.ExtensionContext} context
 * @param {Pick<ClippyReply, 'message' | 'image'> & Partial<ClippyReply>} reply
 */
function showClippy(context, { message, image, recommendation = '', line = 0, codeExample = '' }) {
  const imageDir = vscode.Uri.joinPath(context.extensionUri, 'ClippyImage');

  if (clippyPanel) {
    clippyPanel.reveal(undefined, true);
  } else {
    clippyPanel = vscode.window.createWebviewPanel(
      'clippy',
      'Clippy',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { localResourceRoots: [imageDir] }
    );
    clippyPanel.onDidDispose(() => { clippyPanel = undefined; });
  }

  const webview = clippyPanel.webview;
  const imageUri = webview.asWebviewUri(vscode.Uri.joinPath(imageDir, image));
  const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  // Render the code like the editor: a line-number gutter (starting at `line`) beside each row.
  const codeHtml = codeExample
    ? `<pre class="code">${codeExample.split('\n').map((text, i) =>
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline';">
  <style>
    body { display: flex; flex-direction: column; align-items: center; padding: 16px; font-family: var(--vscode-font-family); }
    .bubble { background: #ffffcc; color: #000; border: 1px solid #000; border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; font-size: 1.1em; }
    img { max-width: 180px; }
    .recommendation { margin-top: 12px; width: 100%; max-width: 480px; box-sizing: border-box; padding: 8px 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 4px; }
    .recommendation p { margin: 0; white-space: pre-wrap; }
    .code { margin: 8px 0 0; padding: 6px 0; overflow-x: auto; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 4px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; }
    .code-line { display: flex; }
    .line-number { flex: none; min-width: 3ch; padding: 0 12px 0 8px; text-align: right; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
    .line-text { white-space: pre; padding-right: 12px; }
  </style>
</head>
<body>
  <div class="bubble">${escapeHtml(message)}</div>
  <img src="${imageUri}" alt="Clippy">
  ${recommendationHtml}
</body>
</html>`;
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
      const reply = await askOllama(document.getText(), path.basename(document.fileName));
      if (request === latestRequest) {
        showClippy(context, reply);
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

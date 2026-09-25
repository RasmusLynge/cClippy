const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');

const CLIPPY_IMAGES = ['DefaultClippy.png', 'WaveClippy.png', 'WinkClippy.png', 'ThinkingClippy.png', 'AfraidClippy.png', 'RelaxClippy.png'];

/** @type {vscode.WebviewPanel | undefined} */
let clippyPanel;

/**
 * Sends a prompt to the local Ollama server and returns the model's reply.
 * @param {string} fileText
 * @param {string} fileName
 * @returns {Promise<{ message: string, image: string }>}
 */
async function askOllama(fileText, fileName) {
  const config = vscode.workspace.getConfiguration('clippy');
  const url = config.get('ollamaUrl', 'http://host.docker.internal:11434');
  const model = config.get('model', 'gemma3:12b');

  const template = await fs.readFile(path.join(__dirname, 'ClippyPromt', 'ClassicPromt.md'), 'utf8');
  const prompt = template
    .replaceAll('{{fileName}}', () => fileName)
    .replaceAll('{{code}}', () => fileText);

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
          image: { type: 'string', enum: CLIPPY_IMAGES }
        },
        required: ['message', 'image']
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const reply = JSON.parse(data.response);
  const image = CLIPPY_IMAGES.includes(reply.image) ? reply.image : 'DefaultClippy.png';
  return { message: String(reply.message), image };
}

/**
 * Shows Clippy's message and image in a panel beside the editor, reusing it between saves.
 * @param {vscode.ExtensionContext} context
 * @param {string} message
 * @param {string} image
 */
function showClippy(context, message, image) {
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
  const safeMessage = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline';">
  <style>
    body { display: flex; flex-direction: column; align-items: center; padding: 16px; font-family: var(--vscode-font-family); }
    .bubble { background: #ffffcc; color: #000; border: 1px solid #000; border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; font-size: 1.1em; }
    img { max-width: 180px; }
  </style>
</head>
<body>
  <div class="bubble">${safeMessage}</div>
  <img src="${imageUri}" alt="Clippy">
</body>
</html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
    try {
      const { message, image } = await askOllama(document.getText(), path.basename(document.fileName));
      showClippy(context, message, image);
    } catch (err) {
      vscode.window.showErrorMessage(`Clippy: could not reach Ollama (${err.message})`);
    }
  });

  context.subscriptions.push(saveDisposable);
}

function deactivate() { }

module.exports = {
  activate,
  deactivate
};

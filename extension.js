const vscode = require('vscode');

/**
 * Sends a prompt to the local Ollama server and returns the model's reply.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function askOllama(prompt) {
  const config = vscode.workspace.getConfiguration('clippy');
  const url = config.get('ollamaUrl', 'http://host.docker.internal:11434');
  const model = config.get('model', 'gemma3:12b');

  const response = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false })
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.response.trim();
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const saveDisposable = vscode.workspace.onDidSaveTextDocument(async () => {
    try {
      const reply = await askOllama('Test');
      vscode.window.showInformationMessage(reply);
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

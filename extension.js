const vscode = require('vscode');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const saveDisposable = vscode.workspace.onDidSaveTextDocument(() => {
    vscode.window.showInformationMessage('Saved!');
  });

  context.subscriptions.push(saveDisposable);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};

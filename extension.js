const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CLIPPY_IMAGES = ['DefaultClippy.png', 'WaveClippy.png', 'WinkClippy.png', 'ThinkingClippy.png', 'AfraidClippy.png', 'RelaxClippy.png', 'PukeClippy.png'];

/** Which bounce (a CSS animation in the Clippy view) each pose gets. */
const IMAGE_BOUNCES = {
  'DefaultClippy.png': 'hop',
  'ThinkingClippy.png': 'float',
  'WaveClippy.png': 'wiggle',
  'AfraidClippy.png': 'shake',
  'RelaxClippy.png': 'sway',
  'WinkClippy.png': 'tilt'
};

/**
 * The career ladder, from rock bottom to the top. Everyone starts as an Intern;
 * good code climbs a level, bad code slides down one.
 */
const LEVELS = [
  { name: 'Comic Sans Developer', emoji: '🤡' },
  { name: 'Printer Whisperer', emoji: '🖨️' },
  { name: '"Works on My Machine" Specialist', emoji: '🤷' },
  { name: 'PowerPoint Architect', emoji: '📊' },
  { name: 'Excel Guru', emoji: '📗' },
  { name: 'Stack Overflow Copy-Paster', emoji: '📋' },
  { name: 'Vibe Coder', emoji: '🌈' },
  { name: 'Intern', emoji: '☕' },
  { name: 'Junior Dev', emoji: '🐣' },
  { name: 'Mid-Level Dev', emoji: '💻' },
  { name: 'Senior Dev', emoji: '🧔' },
  { name: 'Staff Engineer', emoji: '🛠️' },
  { name: 'Principal Engineer', emoji: '🏛️' },
  { name: '10x Engineer', emoji: '🚀' },
  { name: 'Code Wizard', emoji: '🧙' },
  { name: 'Clippy\'s Chosen One', emoji: '📎' }
];
const INTERN = LEVELS.findIndex((l) => l.name === 'Intern');
/** globalState key holding the level, counted from Intern so reordering the ladder keeps people's progress. */
const LEVEL_KEY = 'clippy.level';

/** Index into LEVELS. */
let level = INTERN;
/** How the level just moved (1 up, -1 down, 0 not at all); the Clippy view celebrates it once. */
let levelChange = 0;
/** Shows the level in the status bar. @type {vscode.StatusBarItem} */
let levelStatus;

/** Highlights the lines Clippy's suggestion is about. @type {vscode.TextEditorDecorationType} */
let suggestionDecoration;
const codeLensesChanged = new vscode.EventEmitter();

/** The Clippy tab in the bottom panel, once VS Code has opened it. @type {vscode.WebviewView | undefined} */
let clippyView;

/**
 * What the Clippy view shows. `note` stands in for the recommendation when there is none;
 * `entrance` is how Clippy shows up the next time the view is drawn.
 * @type {Pick<ClippyReply, 'message' | 'image' | 'recommendation' | 'line' | 'endLine' | 'change' | 'codeExample'> & { originalLines: string[], note: string, entrance: 'roam' | 'celebrate' | 'none' }}
 */
let clippyState = {
  message: '',
  image: 'RelaxClippy.png',
  recommendation: '',
  line: 0,
  endLine: 0,
  change: 'none',
  codeExample: '',
  originalLines: [],
  note: 'Save a file (Ctrl+S) and Clippy will take a look.',
  entrance: 'none'
};

/**
 * The code change Clippy suggests, if any; implemented from the Clippy view, its CodeLens or hover.
 * @type {{ uri: vscode.Uri, languageId: string, line: number, endLine: number, originalLines: string[], change: 'replace' | 'delete', codeExample: string, recommendation: string } | undefined}
 */
let pendingSuggestion;

/**
 * @typedef {object} ClippyReply
 * @property {string} message Short speech-bubble text.
 * @property {string} image File name in ClippyImage/.
 * @property {string} recommendation Explanation of the suggested change; empty when there is none.
 * @property {number} line 1-based first file line the change affects; 0 when unknown or none.
 * @property {number} endLine 1-based last file line the change affects; 0 when unknown or none.
 * @property {'replace' | 'delete' | 'none'} change Replace lines line..endLine with codeExample, delete them, or nothing to implement.
 * @property {string} codeExample Replacement code when change is 'replace'; empty otherwise.
 * @property {'good' | 'meh' | 'bad'} verdict Clippy's judgement of the code: good levels the developer up, bad levels them down.
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
          change: { type: 'string', enum: ['replace', 'delete', 'none'] },
          codeExample: { type: 'string' },
          verdict: { type: 'string', enum: ['good', 'meh', 'bad'] }
        },
        required: ['message', 'image', 'recommendation', 'line', 'endLine', 'change', 'codeExample', 'verdict']
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
  let codeExample = recommendation && reply.change !== 'delete'
    ? String(reply.codeExample ?? '').replace(/^\s*```[\w-]*\n?|\n?```\s*$/g, '').replace(/^\n+|\s+$/g, '')
    : '';
  // Only a change we know where to make, and (for a replace) what to write, can be implemented.
  /** @type {ClippyReply['change']} */
  let change = 'none';
  if (recommendation && line) {
    if (reply.change === 'delete') {
      change = 'delete';
    } else if (codeExample) {
      change = 'replace';
    }
  }
  // Small models often get the indentation wrong; re-indent the suggestion so its first line
  // matches the line it replaces, keeping the relative indentation of the lines below it.
  if (codeExample && line) {
    const originalIndent = fileText.split(/\r?\n/)[line - 1].match(/^[ \t]*/)[0];
    const codeIndent = codeExample.match(/^[ \t]*/)[0];
    if (codeIndent !== originalIndent) {
      codeExample = codeExample
        .split('\n')
        .map((text) => (text.startsWith(codeIndent) && text.trim() ? originalIndent + text.slice(codeIndent.length) : text))
        .join('\n');
    }
  }
  // Clippy always opens with "Looks like"; add it if the model forgot.
  let message = String(reply.message).trim();
  if (/^looks like\b/i.test(message)) {
    message = message.replace(/^looks like/i, 'Looks like');
  } else {
    message = `Looks like ${message.charAt(0).toLowerCase()}${message.slice(1)}`;
  }
  // Code with something to fix can't be "good"; without a usable verdict, judge by whether there's a recommendation.
  /** @type {ClippyReply['verdict']} */
  let verdict = ['good', 'meh', 'bad'].includes(reply.verdict) ? reply.verdict : recommendation ? 'meh' : 'good';
  if (verdict === 'good' && recommendation) {
    verdict = 'meh';
  }
  return { message, image, recommendation, line, endLine, change, codeExample, verdict };
}

/**
 * Highlights the lines of the pending suggestion, with the recommendation in a hover, and refreshes its CodeLens.
 */
function renderSuggestion() {
  const suggestion = pendingSuggestion;
  for (const editor of vscode.window.visibleTextEditors) {
    if (!suggestion || editor.document.uri.toString() !== suggestion.uri.toString()) {
      editor.setDecorations(suggestionDecoration, []);
      continue;
    }
    const hover = new vscode.MarkdownString();
    hover.isTrusted = { enabledCommands: ['clippy.implement', 'clippy.dismiss'] };
    hover.appendMarkdown('**Clippy:** ');
    hover.appendText(suggestion.recommendation);
    if (suggestion.change === 'replace') {
      hover.appendCodeblock(suggestion.codeExample, suggestion.languageId);
    } else {
      hover.appendMarkdown('\n\nClippy wants these lines deleted.');
    }
    hover.appendMarkdown('\n\n[Implement](command:clippy.implement) · [Dismiss](command:clippy.dismiss)');
    editor.setDecorations(suggestionDecoration, [{
      range: new vscode.Range(suggestion.line - 1, 0, suggestion.endLine - 1, Number.MAX_SAFE_INTEGER),
      hoverMessage: hover
    }]);
  }
  codeLensesChanged.fire();
}

/**
 * Moves the developer up a level for good code or down one for bad code, and remembers it.
 * @param {vscode.ExtensionContext} context
 * @param {ClippyReply['verdict']} verdict
 */
function changeLevel(context, verdict) {
  const next = Math.min(Math.max(level + (verdict === 'good' ? 1 : verdict === 'bad' ? -1 : 0), 0), LEVELS.length - 1);
  levelChange = next - level;
  level = next;
  context.globalState.update(LEVEL_KEY, level - INTERN);
  updateLevelStatus();
}

/**
 * Shows the current level in the status bar.
 */
function updateLevelStatus() {
  const { name, emoji } = LEVELS[level];
  levelStatus.text = `${emoji} ${name}`;
  levelStatus.tooltip = `Clippy level ${level + 1} of ${LEVELS.length}. Good code levels you up; bad code levels you down.`;
}

/**
 * Draws the Clippy view from clippyState: Clippy bouncing in the right corner with his speech bubble,
 * and his recommendation, code and Implement button beside him.
 * @param {vscode.Uri} extensionUri
 */
function renderClippyView(extensionUri) {
  if (!clippyView) {
    return;
  }
  const { message, image, recommendation, line, endLine, change, codeExample, originalLines, note, entrance } = clippyState;
  // Play the entrance once; if VS Code re-creates the view later, Clippy just carries on bouncing.
  clippyState.entrance = 'none';
  const bounce = IMAGE_BOUNCES[image] ?? 'hop';
  const webview = clippyView.webview;
  const nonce = crypto.randomBytes(16).toString('base64');
  const imageUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'ClippyImage', image));
  const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  // Likewise celebrate (or mourn) a level change once. The ladder bar fills from where it was.
  const levelMove = levelChange;
  levelChange = 0;
  const { name: levelName, emoji: levelEmoji } = LEVELS[level];
  const ladderPercent = (index) => ((index / (LEVELS.length - 1)) * 100).toFixed(1);
  const nextLevel = LEVELS[level + 1];
  const levelHtml = `<header class="level${levelMove > 0 ? ' up' : levelMove < 0 ? ' down' : ''}">
      <span class="level-emoji">${levelEmoji}</span>
      <div class="level-text">
        <div><span class="level-name">${escapeHtml(levelName)}</span> <span class="level-rank">Level ${level + 1}/${LEVELS.length}${nextLevel ? ` · next: ${escapeHtml(nextLevel.name)}` : ' · top of the ladder!'}</span></div>
        <div class="ladder"><div class="ladder-fill" id="ladder-fill" style="width: ${ladderPercent(level - levelMove)}%" data-to="${ladderPercent(level)}"></div></div>
      </div>
    </header>`;
  const toastHtml = levelMove ? `<div class="toast ${levelMove > 0 ? 'up' : 'down'}">${levelMove > 0 ? 'LEVEL UP! ⬆' : 'LEVEL DOWN ⬇'}</div>` : '';
  const lineLabel = line === endLine ? `line ${line}` : `lines ${line}-${endLine}`;
  const implementHtml = change !== 'none'
    ? `<div class="code-toolbar">
        <button id="dismiss" class="secondary">Dismiss</button>
        <button id="implement" title="${change === 'delete' ? 'Delete' : 'Replace'} ${lineLabel}">Implement</button>
      </div>`
    : '';
  // Render code like the editor: a line-number gutter (starting at `line`) beside each row.
  // A delete shows the lines that will be removed, struck through.
  const shownLines = change === 'delete' ? originalLines : codeExample ? codeExample.split('\n') : [];
  const codeHtml = shownLines.length
    ? `${implementHtml}<pre class="code${change === 'delete' ? ' removed' : ''}">${shownLines.map((text, i) =>
      `<span class="code-line"><span class="line-number">${line ? line + i : ''}</span><span class="line-text">${escapeHtml(text) || ' '}</span></span>`
    ).join('')}</pre>`
    : '';
  const recommendationHtml = recommendation
    ? `<div class="recommendation">
      <p>${escapeHtml(recommendation)}</p>
      ${codeHtml}
    </div>`
    : `<p class="note">${escapeHtml(note)}</p>`;

  webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    html, body { height: 100%; margin: 0; }
    body { display: flex; align-items: flex-end; gap: 16px; box-sizing: border-box; padding: 12px 16px; font-family: var(--vscode-font-family); }
    main { flex: 1; min-width: 0; align-self: stretch; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }

    /* The level badge: where the developer is on the ladder. */
    .level { display: flex; align-items: center; gap: 10px; max-width: 720px; box-sizing: border-box; padding: 6px 12px; border-radius: 6px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
    .level-emoji { display: inline-block; font-size: 1.8em; line-height: 1; }
    .level-text { flex: 1; min-width: 0; }
    .level-name { font-weight: 700; }
    .level-rank { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .ladder { height: 6px; margin-top: 5px; border-radius: 3px; overflow: hidden; background: var(--vscode-input-background, rgba(128, 128, 128, 0.2)); }
    .ladder-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #ff5f5f, #ffcc00 45%, #3ccf6e); transition: width 1.2s cubic-bezier(0.3, 1.4, 0.5, 1); }
    .level.up { animation: level-up 1.4s ease-out; }
    .level.up .level-emoji { animation: emoji-hop 0.5s ease-out 3; }
    @keyframes emoji-hop {
      0%, 100% { transform: translateY(0) rotate(0); }
      50% { transform: translateY(-8px) rotate(-12deg) scale(1.2); }
    }
    .level.down { animation: level-down 0.7s ease-out; }
    @keyframes level-up {
      0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(60, 207, 110, 0.9); }
      25% { transform: scale(1.04); box-shadow: 0 0 18px 4px rgba(60, 207, 110, 0.8); }
      100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(60, 207, 110, 0); }
    }
    @keyframes level-down {
      0%, 100% { transform: translateX(0); box-shadow: 0 0 0 0 rgba(255, 95, 95, 0); }
      20% { transform: translateX(-8px); box-shadow: 0 0 14px 3px rgba(255, 95, 95, 0.8); }
      40% { transform: translateX(8px); }
      60% { transform: translateX(-5px); }
      80% { transform: translateX(3px); }
    }
    /* "LEVEL UP!" / "LEVEL DOWN" floats up over Clippy's head and fades. */
    .toast { position: absolute; top: 0; left: 50%; z-index: 2; font-size: 1.4em; font-weight: 900; white-space: nowrap; pointer-events: none; text-shadow: 0 2px 0 rgba(0, 0, 0, 0.5); animation: toast 2.4s ease-out forwards; }
    .toast.up { color: #3ccf6e; }
    .toast.down { color: #ff5f5f; }
    @keyframes toast {
      0% { opacity: 0; transform: translate(-50%, 30px) scale(0.4); }
      15% { opacity: 1; transform: translate(-50%, 0) scale(1.25); }
      25% { transform: translate(-50%, 0) scale(1); }
      75% { opacity: 1; transform: translate(-50%, -30px); }
      100% { opacity: 0; transform: translate(-50%, -50px); }
    }
    .note { margin: 0; color: var(--vscode-descriptionForeground); }
    .recommendation { max-width: 720px; padding: 8px 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 4px; }
    .recommendation p { margin: 0; white-space: pre-wrap; }
    .code-toolbar { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
    .code-toolbar button { padding: 2px 10px; font-family: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 2px; cursor: pointer; }
    .code-toolbar button:hover { background: var(--vscode-button-hoverBackground); }
    .code-toolbar button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .code-toolbar button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .code { margin: 4px 0 0; padding: 6px 0; overflow-x: auto; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 4px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; }
    .code-line { display: flex; }
    .line-number { flex: none; min-width: 3ch; padding: 0 12px 0 8px; text-align: right; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
    .line-text { white-space: pre; padding-right: 12px; }
    .removed .code-line { background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.15)); }
    .removed .line-text { text-decoration: line-through; }

    /* Clippy sits in the bottom-right corner with his speech bubble to his left.
       Three layers animate independently: .clippy roams the tab, .body does tricks, and the img does his pose's bounce. */
    .clippy { flex: none; position: relative; z-index: 1; display: flex; align-items: flex-start; gap: 8px; padding-top: 50px; }
    .clippy.settling { transition: transform 0.7s cubic-bezier(0.3, 1.6, 0.5, 1); }
    .bubble { max-width: 240px; margin-top: 8px; padding: 6px 10px; background: #ffffcc; color: #000; border: 1px solid #000; border-radius: 8px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3); line-height: 1.4; transform-origin: 100% 50%; animation: pop 0.45s cubic-bezier(0.3, 1.8, 0.5, 1); }
    .body { transform-origin: 50% 60%; }
    .body.settling { transition: transform 0.5s ease-out; }
    .body.flip { animation: flip 0.9s ease-in-out; }
    .body.spin { animation: spin 0.8s cubic-bezier(0.5, 0, 0.3, 1.3); }
    .body.jump { animation: jump 0.8s; }
    .clippy img { display: block; height: 110px; transform-origin: 50% 100%; }

    @keyframes pop {
      from { transform: scale(0); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    @keyframes flip {
      0% { transform: translateY(0) rotate(0); }
      15% { transform: translateY(8px) scale(1.2, 0.8); }
      50% { transform: translateY(-70px) rotate(180deg); }
      85% { transform: translateY(0) rotate(360deg) scale(1.2, 0.8); }
      100% { transform: translateY(0) rotate(360deg); }
    }
    @keyframes spin {
      from { transform: rotate(0); }
      to { transform: rotate(-360deg); }
    }
    @keyframes jump {
      0%, 100% { transform: translateY(0) scale(1, 1); animation-timing-function: ease-out; }
      15% { transform: translateY(6px) scale(1.25, 0.75); animation-timing-function: ease-out; }
      50% { transform: translateY(-90px) scale(0.85, 1.2); animation-timing-function: ease-in; }
      85% { transform: translateY(4px) scale(1.25, 0.75); animation-timing-function: ease-out; }
    }

    /* One bounce per pose. */
    @keyframes hop {
      0%, 100% { transform: translateY(0) scale(1.2, 0.8); animation-timing-function: ease-out; }
      10% { transform: translateY(-5px) scale(0.95, 1.08); animation-timing-function: ease-out; }
      50% { transform: translateY(-45px) scale(0.92, 1.12); animation-timing-function: ease-in; }
      90% { transform: translateY(-5px) scale(0.95, 1.08); animation-timing-function: ease-in; }
    }
    @keyframes float {
      from { transform: translateY(0) rotate(-8deg); }
      to { transform: translateY(-20px) rotate(8deg); }
    }
    @keyframes wiggle {
      0%, 100% { transform: translateY(0) rotate(0) scale(1.1, 0.9); }
      25% { transform: translateY(-16px) rotate(15deg); }
      50% { transform: translateY(-22px) rotate(0); }
      75% { transform: translateY(-16px) rotate(-15deg); }
    }
    @keyframes shake {
      0%, 100% { transform: translateX(0) rotate(0); }
      25% { transform: translateX(6px) rotate(3deg); }
      75% { transform: translateX(-6px) rotate(-3deg); }
    }
    @keyframes sway {
      0% { transform: rotate(-12deg); }
      50% { transform: translateY(-14px) rotate(0); }
      100% { transform: rotate(12deg); }
    }
    @keyframes tilt {
      0%, 40%, 100% { transform: translateY(0) rotate(0) scale(1, 1); animation-timing-function: ease-out; }
      5%, 35% { transform: translateY(0) scale(1.15, 0.85); animation-timing-function: ease-out; }
      20% { transform: translateY(-40px) rotate(-20deg); animation-timing-function: ease-in; }
    }
    /* Always animated, even when the OS asks for reduced motion: bouncing is the whole point of Clippy. */
    .clippy img.hop { animation: hop 0.8s infinite; }
    .clippy img.float { animation: float 1.2s ease-in-out infinite alternate; }
    .clippy img.wiggle { animation: wiggle 0.5s linear infinite; }
    .clippy img.shake { animation: shake 0.2s linear infinite; }
    .clippy img.sway { animation: sway 1.5s ease-in-out infinite alternate; }
    .clippy img.tilt { animation: tilt 1.4s infinite; }
  </style>
</head>
<body>
  <main>${levelHtml}${recommendationHtml}</main>
  <div class="clippy" id="clippy">
    ${toastHtml}
    ${message ? `<div class="bubble">${escapeHtml(message)}</div>` : ''}
    <div class="body" id="body"><img class="${bounce}" src="${imageUri}" alt="cClippy"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('implement')?.addEventListener('click', () => vscode.postMessage({ type: 'implement' }));
    document.getElementById('dismiss')?.addEventListener('click', () => vscode.postMessage({ type: 'dismiss' }));

    // Fill the ladder from the old level to the new one.
    const ladderFill = document.getElementById('ladder-fill');
    requestAnimationFrame(() => requestAnimationFrame(() => { ladderFill.style.width = ladderFill.dataset.to + '%'; }));

    const clippy = document.getElementById('clippy');
    const body = document.getElementById('body');
    let roaming = false;

    /** Plays one of the .body trick animations. */
    function trick(name) {
      body.classList.remove('flip', 'spin', 'jump');
      void body.offsetWidth; // Restart the animation if the same trick plays twice in a row.
      body.classList.add(name);
      body.addEventListener('animationend', () => body.classList.remove(name), { once: true });
    }

    /** Bounces Clippy all around the tab, tumbling and squashing off the walls, then springs him back to his corner. */
    function roam() {
      roaming = true;
      const home = clippy.getBoundingClientRect();
      // How far he can move from his corner in each direction before hitting a wall.
      const minX = -home.left, maxX = window.innerWidth - home.right;
      const minY = -home.top, maxY = window.innerHeight - home.bottom;
      let x = 0, y = 0;
      const speed = 420 + Math.random() * 180;
      const angle = Math.PI * (1.1 + Math.random() * 0.3);
      let vx = Math.cos(angle) * speed, vy = Math.sin(angle) * speed;
      let spin = vx < 0 ? -360 : 360, rotation = 0, squash = 1;
      const start = performance.now();
      let last = start;
      function step(now) {
        const dt = (now - last) / 1000;
        last = now;
        x += vx * dt;
        y += vy * dt;
        if (x < minX || x > maxX) { vx = -vx; spin = -spin; squash = 0.6; x = Math.min(Math.max(x, minX), maxX); }
        if (y < minY || y > maxY) { vy = -vy; squash = 0.6; y = Math.min(Math.max(y, minY), maxY); }
        rotation += spin * dt;
        squash += (1 - squash) * Math.min(1, dt * 10);
        clippy.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
        body.style.transform = 'rotate(' + rotation + 'deg) scale(' + (2 - squash) + ', ' + squash + ')';
        if (now - start < 4000) {
          requestAnimationFrame(step);
          return;
        }
        // Spring home, landing upright.
        clippy.classList.add('settling');
        body.classList.add('settling');
        clippy.style.transform = '';
        body.style.transform = 'rotate(' + Math.round(rotation / 360) * 360 + 'deg)';
        setTimeout(() => {
          clippy.classList.remove('settling');
          body.classList.remove('settling');
          body.style.transform = '';
          roaming = false;
          trick('jump');
        }, 700);
      }
      requestAnimationFrame(step);
    }

    const entrance = '${entrance}';
    if (entrance === 'roam') {
      roam();
    } else if (entrance === 'celebrate') {
      trick('flip');
    }
    // Now and then he shows off, unless he's busy thinking or scared.
    if ('${bounce}' !== 'float' && '${bounce}' !== 'shake') {
      (function showOff() {
        setTimeout(() => {
          if (!roaming) {
            trick(['flip', 'spin', 'jump'][Math.floor(Math.random() * 3)]);
          }
          showOff();
        }, 4000 + Math.random() * 5000);
      })();
    }
  </script>
</body>
</html>`;
}

/**
 * Opens the Clippy tab in the bottom panel without taking focus from the editor.
 */
async function revealClippyView() {
  if (clippyView) {
    clippyView.show(true);
    return;
  }
  // VS Code only creates the view once it's first opened, and opening it that way focuses it, so hand focus back.
  await vscode.commands.executeCommand('clippy.view.focus');
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
}

/**
 * Changes what Clippy says and shows, and his suggestion if he has one.
 * @param {vscode.Uri} extensionUri
 * @param {Pick<ClippyReply, 'message' | 'image'> & Partial<ClippyReply>} reply
 * @param {{ uri: vscode.Uri, fileText: string, languageId: string }} [source] The file Clippy reviewed; enables implementing the suggestion.
 * @param {string} [note] Shown when there's no recommendation.
 */
function showClippy(extensionUri, { message, image, recommendation = '', line = 0, endLine = 0, change = 'none', codeExample = '' }, source, note = '') {
  const originalLines = source ? source.fileText.split(/\r?\n/).slice(line - 1, endLine) : [];
  pendingSuggestion = source && change !== 'none'
    ? { uri: source.uri, languageId: source.languageId, line, endLine, originalLines, change, codeExample, recommendation }
    : undefined;
  renderSuggestion();
  if (pendingSuggestion) {
    // Scroll the highlighted lines into view (only if they're off-screen), without moving the cursor.
    const range = new vscode.Range(line - 1, 0, endLine - 1, 0);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === pendingSuggestion.uri.toString()) {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
  }
  // Replies (and errors) make an entrance; "Let me take a look…" just starts thinking.
  const entrance = image === 'ThinkingClippy.png' ? 'none' : 'roam';
  clippyState = { message, image, recommendation, line, endLine, change, codeExample, originalLines, note, entrance };
  renderClippyView(extensionUri);
}

/**
 * Makes Clippy's suggested change in the file: replaces the lines it reviewed with its code, or deletes them.
 * Refuses if those lines changed since the save, so it never overwrites the wrong code.
 * @returns {Promise<boolean>} Whether the change was made.
 */
async function implementSuggestion() {
  const suggestion = pendingSuggestion;
  if (!suggestion) {
    return false;
  }

  const document = await vscode.workspace.openTextDocument(suggestion.uri);
  const { line, endLine, originalLines, change, codeExample } = suggestion;
  const currentLines = endLine <= document.lineCount
    ? Array.from({ length: endLine - line + 1 }, (_, i) => document.lineAt(line - 1 + i).text)
    : [];
  if (currentLines.join('\n') !== originalLines.join('\n')) {
    vscode.window.showWarningMessage('Clippy: that code has changed since Clippy looked at it. Save again for a fresh suggestion.');
    return false;
  }

  const lastLineEnd = document.lineAt(endLine - 1).text.length;
  let range;
  if (change === 'replace') {
    range = new vscode.Range(line - 1, 0, endLine - 1, lastLineEnd);
  } else if (endLine < document.lineCount) {
    // Delete the whole lines, including the line break after them.
    range = new vscode.Range(line - 1, 0, endLine, 0);
  } else if (line > 1) {
    // Deleting the last lines: take the line break before them instead.
    range = new vscode.Range(line - 2, document.lineAt(line - 2).text.length, endLine - 1, lastLineEnd);
  } else {
    range = new vscode.Range(0, 0, endLine - 1, lastLineEnd);
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(suggestion.uri, range, change === 'replace' ? codeExample : '');
  if (!await vscode.workspace.applyEdit(edit)) {
    vscode.window.showErrorMessage('Clippy: could not implement the suggestion.');
    return false;
  }
  pendingSuggestion = undefined;

  // Show the file in the editor it was already open in, with the new code selected (or the cursor where the deleted lines were).
  const existingEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === suggestion.uri.toString());
  const editor = await vscode.window.showTextDocument(document, { viewColumn: existingEditor?.viewColumn ?? vscode.ViewColumn.One });
  if (change === 'replace') {
    const codeLines = codeExample.split('\n');
    const newEnd = new vscode.Position(line - 2 + codeLines.length, codeLines[codeLines.length - 1].length);
    editor.selection = new vscode.Selection(range.start, newEnd);
  } else {
    const cursor = document.validatePosition(new vscode.Position(line - 1, 0));
    editor.selection = new vscode.Selection(cursor, cursor);
  }
  editor.revealRange(editor.selection);
  return true;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const { extensionUri } = context;
  // Clippy's speech-bubble yellow, with a bold left edge, his face in the gutter and a mark in the scrollbar.
  suggestionDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
    gutterIconPath: vscode.Uri.joinPath(extensionUri, 'ClippyImage', 'DefaultClippy.png'),
    gutterIconSize: 'contain',
    overviewRulerColor: 'rgba(255, 204, 0, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    light: { backgroundColor: 'rgba(255, 221, 0, 0.3)', borderColor: '#d4a800' },
    dark: { backgroundColor: 'rgba(255, 221, 0, 0.15)', borderColor: '#ffcc00' }
  });

  level = Math.min(Math.max(INTERN + context.globalState.get(LEVEL_KEY, 0), 0), LEVELS.length - 1);
  levelStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  levelStatus.command = 'clippy.view.focus';
  updateLevelStatus();
  levelStatus.show();
  const resetLevelDisposable = vscode.commands.registerCommand('clippy.resetLevel', () => {
    levelChange = INTERN - level;
    level = INTERN;
    context.globalState.update(LEVEL_KEY, 0);
    updateLevelStatus();
    renderClippyView(extensionUri);
  });

  const viewDisposable = vscode.window.registerWebviewViewProvider('clippy.view', {
    resolveWebviewView(view) {
      clippyView = view;
      view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'ClippyImage')] };
      view.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'implement' || msg.type === 'dismiss') {
          vscode.commands.executeCommand(`clippy.${msg.type}`);
        }
      });
      view.onDidDispose(() => { clippyView = undefined; });
      renderClippyView(extensionUri);
    }
  }, { webviewOptions: { retainContextWhenHidden: true } });

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
    showClippy(extensionUri, { message: 'Let me take a look…', image: 'ThinkingClippy.png' });
    revealClippyView();

    try {
      const fileText = document.getText();
      const reply = await askOllama(fileText, path.basename(document.fileName));
      if (request === latestRequest) {
        changeLevel(context, reply.verdict);
        showClippy(extensionUri, reply, { uri: document.uri, fileText, languageId: document.languageId }, 'No code changes to suggest this time.');
      }
    } catch (err) {
      if (request === latestRequest) {
        showClippy(extensionUri, { message: 'Oops, something went wrong.', image: 'AfraidClippy.png' });
      }
      vscode.window.showErrorMessage(`Clippy: could not reach Ollama (${err.message})`);
    }
  });

  const codeLensDisposable = vscode.languages.registerCodeLensProvider({ scheme: '*' }, {
    onDidChangeCodeLenses: codeLensesChanged.event,
    provideCodeLenses(document) {
      const suggestion = pendingSuggestion;
      if (!suggestion || document.uri.toString() !== suggestion.uri.toString() || suggestion.line > document.lineCount) {
        return [];
      }
      const range = new vscode.Range(suggestion.line - 1, 0, suggestion.line - 1, 0);
      const summary = suggestion.recommendation.replace(/\s+/g, ' ');
      const lineLabel = suggestion.line === suggestion.endLine ? `line ${suggestion.line}` : `lines ${suggestion.line}-${suggestion.endLine}`;
      return [
        // An empty command id shows the title as plain text.
        new vscode.CodeLens(range, { title: `📎 ${summary.length > 120 ? `${summary.slice(0, 119)}…` : summary}`, command: '' }),
        new vscode.CodeLens(range, { title: 'Implement', tooltip: `${suggestion.change === 'delete' ? 'Delete' : 'Replace'} ${lineLabel}`, command: 'clippy.implement' }),
        new vscode.CodeLens(range, { title: 'Dismiss', command: 'clippy.dismiss' })
      ];
    }
  });

  // Implementing or dismissing the suggestion removes it from the editor and the Clippy view, and Clippy relaxes.
  const finish = (/** @type {string} */ note) => {
    pendingSuggestion = undefined;
    renderSuggestion();
    clippyState = { ...clippyState, image: 'RelaxClippy.png', recommendation: '', change: 'none', codeExample: '', originalLines: [], note, entrance: 'celebrate' };
    renderClippyView(extensionUri);
  };
  const implementDisposable = vscode.commands.registerCommand('clippy.implement', async () => {
    if (await implementSuggestion()) {
      finish('Suggestion implemented.');
    }
  });
  const dismissDisposable = vscode.commands.registerCommand('clippy.dismiss', () => finish('Suggestion dismissed.'));

  // Decorations belong to an editor, so redraw the highlight when the file is shown again.
  const visibleEditorsDisposable = vscode.window.onDidChangeVisibleTextEditors(() => renderSuggestion());

  context.subscriptions.push(
    suggestionDecoration, codeLensesChanged, viewDisposable, levelStatus, resetLevelDisposable,
    willSaveDisposable, saveDisposable, codeLensDisposable, implementDisposable, dismissDisposable,
    visibleEditorsDisposable
  );
}

function deactivate() { }

module.exports = {
  activate,
  deactivate
};

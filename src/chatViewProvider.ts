import * as vscode from 'vscode';
import { configureProviderInteractively, ensureMeerConfig, getPersistedModel, selectModel, providerLabel, getDefaultModel, updateModelInConfig, ProviderId } from './configManager';
import { MeerAiClient } from './meerAiClient';
import { ChatMessage, ChatSession, createMessage, createSession, loadSessions, saveSessions } from './sessionStore';

interface PendingRequest {
  dispose?: () => void;
  sessionId: string;
  responseBuffer: string;
}

interface WebviewState {
  sessions: ChatSession[];
  provider?: {
    id: string;
    label: string;
    model?: string;
    source?: "workspace" | "config" | "default";
  };
  activeSessionId?: string;
}

type SettingsAction = "configure" | "model" | "reload" | "clear";
export class MeerAiChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'meerai.chat';

  private view?: vscode.WebviewView;
  private sessions: ChatSession[] = [];
  private activeSessionId?: string;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly ready: Promise<void>;
  private resolveReady?: () => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: MeerAiClient
  ) {
    this.sessions = loadSessions(context.workspaceState);
    if (this.sessions.length === 0) {
      const session = createSession('Chat 1');
      this.sessions = [session];
      this.activeSessionId = session.id;
      void saveSessions(this.context.workspaceState, this.sessions);
    } else {
      this.activeSessionId = this.sessions[0]?.id;
    }

    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    if (!this.activeSessionId && this.sessions.length > 0) {
      this.activeSessionId = this.sessions[0].id;
    }

    webviewView.webview.html = this.getHtml(webviewView.webview);
    await this.postState();

    webviewView.webview.onDidReceiveMessage(async (message: any) => {
      switch (message.type) {
        case 'ask':
          await this.handleAsk(message.requestId, message.prompt, message.sessionId);
          break;
        case 'cancel':
          this.cancelRequest(message.requestId);
          break;
        case 'newSession':
          await this.createNewSession();
          break;
        case 'selectSession':
          this.setActiveSession(message.sessionId);
          break;
        case 'renameSession':
          await this.renameSession(message.sessionId, message.title);
          break;
        case 'deleteSession':
          await this.deleteSession(message.sessionId);
          break;
        case 'openSettings':
          await this.showSettingsMenu();
          break;
        default:
          break;
      }
    });

    this.resolveReady?.();
    this.resolveReady = undefined;
  }

  public async createNewSession(title?: string): Promise<void> {
    await this.ensureReady();
    const sessionTitle = title?.trim() || `Chat ${this.sessions.length + 1}`;
    const session = createSession(sessionTitle);
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    this.view?.show?.(true);
    await saveSessions(this.context.workspaceState, this.sessions);
    await this.postState();
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = this.createNonce();
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'meerai.svg')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MeerAI</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    body {
      margin: 0;
      padding: 0;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      height: 100vh;
    }
    #app {
      display: grid;
      grid-template-columns: 220px 1fr;
      height: 100%;
    }
    #sidebar {
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--vscode-editor-background) 8%);
    }
    .sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem;
      gap: 0.5rem;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    .sidebar-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-weight: 600;
    }
    .sidebar-title img {
      width: 20px;
      height: 20px;
      border-radius: 4px;
    }
    .sidebar-button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 0.35rem 0.6rem;
      border-radius: 4px;
      cursor: pointer;
    }
    .sidebar-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    #session-list {
      list-style: none;
      padding: 0.5rem 0.5rem 0;
      margin: 0;
      flex: 1;
      overflow-y: auto;
    }
    .session-item {
      padding: 0.6rem 0.5rem;
      border-radius: 6px;
      cursor: pointer;
      line-height: 1.4;
    }
    .session-item.active {
      background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 55%, transparent);
    }
    .session-item:hover {
      background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 40%, transparent);
    }
    .session-title {
      font-size: 0.9rem;
      font-weight: 600;
      margin-bottom: 0.2rem;
    }
    .session-preview {
      font-size: 0.75rem;
      color: var(--vscode-descriptionForeground);
    }
    #chat {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    #chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: color-mix(in srgb, var(--vscode-editor-background) 94%, transparent);
    }
    #chat-header h1 {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .title-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    #session-mode {
      font-size: 0.75rem;
      color: var(--vscode-descriptionForeground);
      padding: 0.1rem 0.5rem;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent);
    }
    .header-left {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    #session-meta {
      font-size: 0.8rem;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 0.4rem;
      align-items: center;
    }
    #session-meta[aria-hidden="true"] {
      display: none;
    }
    .header-actions {
      display: flex;
      gap: 0.4rem;
    }
    .header-actions button {
      border: none;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 0.35rem 0.8rem;
      border-radius: 999px;
      cursor: pointer;
    }
    .header-actions .ghost {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent);
    }
    .header-actions .ghost.warn {
      border-color: color-mix(in srgb, var(--vscode-errorForeground) 35%, transparent);
      color: var(--vscode-errorForeground);
    }
    .header-actions button:hover {
      background: color-mix(in srgb, var(--vscode-button-hoverBackground) 80%, transparent);
    }
    #conversation {
      flex: 1;
      overflow-y: auto;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      position: relative;
    }
    #empty-state {
      margin: auto;
      text-align: center;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      align-items: center;
      max-width: 420px;
      color: var(--vscode-descriptionForeground);
    }
    #empty-state h2 {
      margin: 0;
      color: var(--vscode-foreground);
    }
    #empty-state .bot-avatar {
      font-size: 2.4rem;
      width: 72px;
      height: 72px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 25%, transparent);
    }
    .empty-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      justify-content: center;
    }
    .empty-actions button {
      border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 30%, transparent);
      background: transparent;
      color: var(--vscode-descriptionForeground);
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      cursor: pointer;
    }
    .empty-actions button:hover {
      color: var(--vscode-button-foreground);
      border-color: color-mix(in srgb, var(--vscode-button-foreground) 35%, transparent);
    }
    .message-card {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.75rem;
      padding: 0.85rem 1rem;
      border-radius: 12px;
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-editorWidget-border) 40%, transparent);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 85%, transparent);
      position: relative;
    }
    .message-card.user {
      background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 25%, transparent);
    }
    .message-card.streaming::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 12px;
      border: 1px dashed color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent);
      pointer-events: none;
    }
    .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      font-size: 1.1rem;
      background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 15%, transparent);
    }
    .message-card.user .avatar {
      background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 35%, transparent);
    }
    .message-body {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .message-meta {
      font-size: 0.75rem;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    .message-content {
      color: var(--vscode-foreground);
      font-size: 0.95rem;
      line-height: 1.6;
    }
    .message-content pre {
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent);
      padding: 0.75rem;
      border-radius: 8px;
      overflow-x: auto;
    }
    form {
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
    }
    .control-deck {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .toggle-group {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.8rem;
      color: var(--vscode-descriptionForeground);
    }
    .toggle input {
      accent-color: color-mix(in srgb, var(--vscode-button-background) 80%, transparent);
    }
    .mode-switch {
      display: flex;
      gap: 0.4rem;
      background: color-mix(in srgb, var(--vscode-editor-background) 95%, transparent);
      padding: 0.2rem;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 40%, transparent);
    }
    .mode-pill {
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      padding: 0.3rem 0.9rem;
      border-radius: 999px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .mode-pill.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    textarea {
      resize: vertical;
      min-height: 4rem;
      max-height: 14rem;
      font-family: inherit;
      font-size: 0.95rem;
      padding: 0.85rem;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--vscode-input-border) 80%, transparent);
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
      color: inherit;
    }
    textarea:focus {
      outline: 1px solid color-mix(in srgb, var(--vscode-button-background) 60%, transparent);
    }
    .composer-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .status {
      font-size: 0.8rem;
      color: var(--vscode-descriptionForeground);
      min-height: 1rem;
    }
    .form-actions {
      display: flex;
      gap: 0.5rem;
    }
    .form-actions button {
      padding: 0.5rem 1.25rem;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    .form-actions button .icon {
      font-size: 0.85rem;
    }
    #submit {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #submit[disabled] {
      opacity: 0.6;
      cursor: default;
    }
    #cancel {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 30%, transparent);
    }
    #cancel[disabled] {
      opacity: 0.35;
      cursor: default;
    }
  </style>
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-title">
          <img src="${iconUri}" alt="MeerAI">
          <span>MeerAI</span>
        </div>
        <button class="sidebar-button" id="new-chat" title="New chat">+</button>
      </div>
      <ul id="session-list"></ul>
    </aside>
    <section id="chat">
      <header id="chat-header">
        <div class="header-left">
          <div class="title-row">
            <h1 id="session-title">Chat</h1>
            <span id="session-mode">Conversational</span>
          </div>
          <div id="session-meta"></div>
        </div>
        <div class="header-actions">
          <button id="settings" class="ghost" title="Configure provider and model">Settings</button>
          <button id="rename-session" class="ghost" title="Rename chat">Rename</button>
          <button id="delete-session" class="ghost warn" title="Delete chat">Delete</button>
        </div>
      </header>
      <main id="conversation" aria-live="polite" aria-label="MeerAI conversation history">
        <div id="empty-state" role="presentation">
          <div class="bot-avatar">🌊</div>
          <h2>What can I help you build?</h2>
          <p>Ask MeerAI about this workspace, explain code, or draft a plan.</p>
          <div class="empty-actions">
            <button data-suggestion="Review the latest changes">Review changes</button>
            <button data-suggestion="Explain the purpose of README.md">Explain a file</button>
            <button data-suggestion="Generate tests for the services directory">Generate tests</button>
          </div>
        </div>
      </main>
      <form id="meerai-form">
        <div class="control-deck">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="auto-approve" checked>
              <span>Auto-approve</span>
            </label>
            <label class="toggle">
              <input type="checkbox" id="read-mode" checked>
              <span>Read</span>
            </label>
            <label class="toggle">
              <input type="checkbox" id="edit-mode">
              <span>Edit</span>
            </label>
          </div>
          <div class="mode-switch">
            <button type="button" class="mode-pill active" data-mode="plan">Plan</button>
            <button type="button" class="mode-pill" data-mode="act">Act</button>
          </div>
        </div>
        <textarea id="prompt" placeholder="Describe your task, or use / for commands…"></textarea>
        <div class="composer-footer">
          <div class="status" id="status"></div>
          <div class="form-actions">
            <button type="button" id="cancel" class="ghost" disabled>Cancel</button>
            <button type="submit" id="submit">
              <span class="icon">➤</span>
              <span>Send</span>
            </button>
          </div>
        </div>
      </form>
    </section>
  </div>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();

      const dom = {
        sessionList: document.getElementById('session-list'),
        conversation: document.getElementById('conversation'),
        emptyState: document.getElementById('empty-state'),
        sessionTitle: document.getElementById('session-title'),
        sessionMeta: document.getElementById('session-meta'),
        sessionMode: document.getElementById('session-mode'),
        form: document.getElementById('meerai-form'),
        textarea: document.getElementById('prompt'),
        status: document.getElementById('status'),
        submitButton: document.getElementById('submit'),
        cancelButton: document.getElementById('cancel'),
        newChatButton: document.getElementById('new-chat'),
        renameButton: document.getElementById('rename-session'),
        deleteButton: document.getElementById('delete-session'),
        settingsButton: document.getElementById('settings'),
        modePills: Array.from(document.querySelectorAll('.mode-pill')),
        suggestionButtons: Array.from(document.querySelectorAll('[data-suggestion]')),
      };

      if (dom.sessionMeta) {
        dom.sessionMeta.setAttribute('aria-hidden', 'true');
      }

      const state = {
        sessions: [],
        activeSessionId: null,
        activeRequestId: null,
        pendingResponses: new Map(),
        provider: null,
      };

    function getActiveSession() {
      return state.sessions.find((session) => session.id === state.activeSessionId) || null;
    }

    function renderSessions() {
      sessionList.innerHTML = '';
      if (!state.sessions.length) {
        return;
      }
      for (const session of state.sessions) {
        const item = document.createElement('li');
        item.className = 'session-item' + (session.id === state.activeSessionId ? ' active' : '');
        item.dataset.sessionId = session.id;

        const title = document.createElement('div');
        title.className = 'session-title';
        title.textContent = session.title || 'Chat';
        item.appendChild(title);

        const preview = document.createElement('div');
        preview.className = 'session-preview';
        const lastMessage = session.messages[session.messages.length - 1];
        preview.textContent = lastMessage ? summarize(lastMessage.content) : 'Start chatting…';
        item.appendChild(preview);

        item.addEventListener('click', () => {
          vscode.postMessage({ type: 'selectSession', sessionId: session.id });
        });

        sessionList.appendChild(item);
      }
    }

    function renderConversation() {
      conversation.innerHTML = '';
      const session = getActiveSession();
      renderProviderInfo();
      if (!session) {
        sessionTitle.textContent = 'No chat selected';
        setPendingState(true);
        return;
      }

      sessionTitle.textContent = session.title || 'Chat';
      setPendingState(false);

      for (const message of session.messages) {
        appendMessageElement(message.role, message.content, { messageId: message.id });
      }

      for (const [requestId, pending] of state.pendingResponses.entries()) {
        if (pending.sessionId === session.id) {
          appendMessageElement('assistant', pending.content, {
            requestId,
            streaming: true,
          });
        }
      }

      conversation.scrollTop = conversation.scrollHeight;
    }

    function appendMessageElement(role, content, options = {}) {
      const element = document.createElement('div');
      element.className = 'message ' + role + (options.streaming ? ' streaming' : '');
      if (options.messageId) {
        element.dataset.messageId = options.messageId;
      }
      if (options.requestId) {
        element.dataset.requestId = options.requestId;
      }
      element.textContent = content;
      conversation.appendChild(element);
      conversation.scrollTop = conversation.scrollHeight;
      return element;
    }

    function updateStreamingMessage(requestId, content) {
      let node = conversation.querySelector('.message.streaming[data-request-id="' + requestId + '"]');
      if (!node) {
        node = appendMessageElement('assistant', content, { requestId, streaming: true });
      } else {
        node.textContent = content;
        conversation.scrollTop = conversation.scrollHeight;
      }
    }

    function removeStreamingMessage(requestId) {
      const node = conversation.querySelector('.message.streaming[data-request-id="' + requestId + '"]');
      if (node && node.parentElement === conversation) {
        conversation.removeChild(node);
      }
    }

    function setStatus(text) {
      status.textContent = text || '';
    }

    function setPendingState(pending) {
      submitButton.disabled = pending || !state.activeSessionId;
      cancelButton.disabled = !pending;
    }

    function summarize(text) {
      if (!text) {
        return '';
      }
      const trimmed = text.trim().replace(/\\s+/g, ' ');
      return trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed;
    }

    function renderProviderInfo() {
      if (!sessionMeta) {
        return;
      }
      if (!state.provider) {
        sessionMeta.textContent = '';
        sessionMeta.setAttribute('aria-hidden', 'true');
        return;
      }
      const { label, model, source } = state.provider;
      const segments = [label];
      if (model) {
        segments.push(model);
      }
      sessionMeta.textContent = segments.join(' • ');
      let origin = 'provider default';
      if (source === 'workspace') {
        origin = 'workspace override';
      } else if (source === 'config') {
        origin = 'config default';
      }
      const modelLabel = model ?? 'default';
      sessionMeta.title = 'Provider: ' + label + '\\nModel: ' + modelLabel + ' (' + origin + ')';
      sessionMeta.setAttribute('aria-hidden', 'false');
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const session = getActiveSession();
      if (!session) {
        vscode.postMessage({ type: 'newSession' });
        return;
      }

      const prompt = textarea.value.trim();
      if (!prompt || state.activeRequestId) {
        return;
      }

      const requestId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      state.activeRequestId = requestId;
      state.pendingResponses.delete(requestId);

      setStatus('Thinking…');
      setPendingState(true);

      dom.form.addEventListener('submit', (event) => {
        event.preventDefault();
        const session = getActiveSession();
        if (!session) {
          vscode.postMessage({ type: 'newSession' });
          return;
        }

        const prompt = dom.textarea.value.trim();
        if (!prompt || state.activeRequestId) {
          return;
        }

        const requestId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
        state.activeRequestId = requestId;
        state.pendingResponses.delete(requestId);

        setStatus('Thinking…');
        setPendingState(true);

        appendMessageCard('user', prompt, { messageId: requestId + '-user' });

        dom.textarea.value = '';
        dom.textarea.focus();

        vscode.postMessage({
          type: 'ask',
          requestId,
          prompt,
          sessionId: session.id,
        });
      });

      dom.cancelButton.addEventListener('click', () => {
        if (state.activeRequestId) {
          vscode.postMessage({ type: 'cancel', requestId: state.activeRequestId });
        }
      });

      dom.newChatButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'newSession' });
      });

      dom.renameButton.addEventListener('click', () => {
        const session = getActiveSession();
        if (!session) {
          return;
        }
        const title = window.prompt('Rename chat', session.title);
        if (title !== null) {
          vscode.postMessage({ type: 'renameSession', sessionId: session.id, title });
        }
      });

      dom.deleteButton.addEventListener('click', () => {
        const session = getActiveSession();
        if (!session) {
          return;
        }
        const confirmed = window.confirm('Delete this chat? Previous messages will be removed.');
        if (confirmed) {
          vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
        }
      });

      if (dom.settingsButton) {
        dom.settingsButton.addEventListener('click', () => {
          vscode.postMessage({ type: 'openSettings' });
        });
      }

      dom.suggestionButtons.forEach((button) => {
        button.addEventListener('click', () => {
          const text = button.getAttribute('data-suggestion');
          if (text) {
            dom.textarea.value = text;
            dom.textarea.focus();
          }
        });
      });

      dom.modePills.forEach((pill) => {
        pill.addEventListener('click', () => {
          dom.modePills.forEach((p) => p.classList.remove('active'));
          pill.classList.add('active');
          if (dom.sessionMode) {
            dom.sessionMode.textContent = pill.dataset.mode === 'act' ? 'Action Mode' : 'Planning Mode';
          }
        });
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.type) {
          case 'state':
            state.sessions = message.sessions;
            state.activeSessionId = message.activeSessionId || null;
            state.provider = message.provider || null;
            if (message.activeRequestId !== undefined) {
              state.activeRequestId = message.activeRequestId;
            }
            renderSessions();
            renderConversation();
            renderProviderInfo();
            renderEmptyState();
            break;
          case 'stream':
            state.pendingResponses.set(message.requestId, {
              sessionId: message.sessionId,
              content: (state.pendingResponses.get(message.requestId)?.content || '') + message.chunk,
            });
            if (message.sessionId === state.activeSessionId) {
              updateStreamingMessage(message.requestId, state.pendingResponses.get(message.requestId).content);
            }
            break;
          case 'done':
            state.pendingResponses.delete(message.requestId);
            if (state.activeRequestId === message.requestId) {
              state.activeRequestId = null;
              setStatus('');
              setPendingState(false);
            }
            removeStreamingMessage(message.requestId);
            break;
          case 'error':
            state.pendingResponses.delete(message.requestId);
            if (state.activeRequestId === message.requestId) {
              state.activeRequestId = null;
              setStatus(message.message || 'Something went wrong');
              setPendingState(false);
            }
            removeStreamingMessage(message.requestId);
            break;
          default:
            break;
        }
      });

      renderEmptyState();

      function getActiveSession() {
        return state.sessions.find((session) => session.id === state.activeSessionId) || null;
      }

      function renderSessions() {
        dom.sessionList.innerHTML = '';
        if (!state.sessions.length) {
          return;
        }
        for (const session of state.sessions) {
          const item = document.createElement('li');
          item.className = 'session-item' + (session.id === state.activeSessionId ? ' active' : ''); 
          item.dataset.sessionId = session.id;

          const title = document.createElement('div');
          title.className = 'session-title';
          title.textContent = session.title || 'Chat';
          item.appendChild(title);

          const preview = document.createElement('div');
          preview.className = 'session-preview';
          const lastMessage = session.messages[session.messages.length - 1];
          preview.textContent = lastMessage ? summarize(lastMessage.content) : 'Start chatting…';
          item.appendChild(preview);

          item.addEventListener('click', () => {
            vscode.postMessage({ type: 'selectSession', sessionId: session.id });
          });

          dom.sessionList.appendChild(item);
        }
      }

      function renderConversation() {
        dom.conversation.innerHTML = '';
        const session = getActiveSession();
        renderProviderInfo();
        if (!session) {
          dom.sessionTitle.textContent = 'No chat selected';
          setPendingState(true);
          renderEmptyState();
          return;
        }

        dom.sessionTitle.textContent = session.title || 'Chat';
        setPendingState(false);

        for (const message of session.messages) {
          appendMessageCard(message.role, message.content, { messageId: message.id });
        }

        for (const [requestId, pending] of state.pendingResponses.entries()) {
          if (pending.sessionId === session.id) {
            appendMessageCard('assistant', pending.content, { requestId, streaming: true });
          }
        }

        dom.conversation.scrollTop = dom.conversation.scrollHeight;
        renderEmptyState();
      }

      function appendMessageCard(role, text, { messageId, requestId, streaming } = {}) {
        const card = document.createElement('article');
        card.className = 'message-card ' + role + (streaming ? ' streaming' : '');
        if (messageId) {
          card.dataset.messageId = messageId;
        }
        if (requestId) {
          card.dataset.requestId = requestId;
        }

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = role === 'assistant' ? '🌊' : '🙂';

        const body = document.createElement('div');
        body.className = 'message-body';

        const meta = document.createElement('div');
        meta.className = 'message-meta';
        const who = document.createElement('span');
        who.textContent = role === 'assistant' ? 'MeerAI' : 'You';
        const when = document.createElement('time');
        const now = new Date();
        when.dateTime = now.toISOString();
        when.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        meta.append(who, '·', when);

        const content = document.createElement('div');
        content.className = 'message-content';
        content.innerHTML = renderMessageHtml(text);

        body.append(meta, content);
        card.append(avatar, body);
        dom.conversation.appendChild(card);
        dom.conversation.scrollTop = dom.conversation.scrollHeight;
        renderEmptyState();
        return card;
      }

      function updateStreamingMessage(requestId, text) {
        let card = dom.conversation.querySelector('.message-card.streaming[data-request-id="' + requestId + '"]');
        if (!card) {
          card = appendMessageCard('assistant', text, { requestId, streaming: true });
        } else {
          const content = card.querySelector('.message-content');
          if (content) {
            content.innerHTML = renderMessageHtml(text);
          }
          dom.conversation.scrollTop = dom.conversation.scrollHeight;
        }
      }

      function removeStreamingMessage(requestId) {
        const card = dom.conversation.querySelector('.message-card.streaming[data-request-id="' + requestId + '"]');
        if (card && card.parentElement === dom.conversation) {
          dom.conversation.removeChild(card);
        }
        renderEmptyState();
      }

      function setStatus(text) {
        dom.status.textContent = text || '';
      }

      function setPendingState(pending) {
        dom.submitButton.disabled = pending || !state.activeSessionId;
        dom.cancelButton.disabled = !pending;
      }

      function summarize(text) {
        if (!text) {
          return '';
        }
        const trimmed = text.trim().replace(/\s+/g, ' ');
        return trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed;
      }

      function renderMessageHtml(text) {
        const escaped = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        const blocks = escaped.split(/\n{2,}/).map((block) => {
          const trimmed = block.trim();
          if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
            return '<pre><code>' + trimmed.slice(3, -3) + '</code></pre>';
          }
          return trimmed.replace(/\n/g, '<br>');
        });
        return blocks.join('<br><br>');
      }

      function renderProviderInfo() {
        if (!dom.sessionMeta) {
          return;
        }
        if (!state.provider) {
          dom.sessionMeta.textContent = '';
          dom.sessionMeta.setAttribute('aria-hidden', 'true');
          return;
        }
        const { label, model, source } = state.provider;
        const segments = [label];
        if (model) {
          segments.push(model);
        }
        dom.sessionMeta.textContent = segments.join(' • ');
        let origin = 'provider default';
        if (source === 'workspace') {
          origin = 'workspace override';
        } else if (source === 'config') {
          origin = 'config default';
        }
        const modelLabel = model ?? 'default';
        dom.sessionMeta.title = 'Provider: ' + label + '\nModel: ' + modelLabel + ' (' + origin + ')';
        dom.sessionMeta.setAttribute('aria-hidden', 'false');
      }

      function renderEmptyState() {
        if (!dom.emptyState) {
          return;
        }
        const hasMessages = state.sessions.some((session) => session.messages.length > 0);
        const isStreaming = state.pendingResponses.size > 0;
        dom.emptyState.style.display = hasMessages || isStreaming ? 'none' : 'flex';
      }
    })();
  </script>
</body>
</html>`;
  }

  private async renameSession(sessionId: string, title?: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }
    const newTitle = title?.trim();
    if (!newTitle) {
      return;
    }
    session.title = newTitle;
    session.updatedAt = Date.now();
    await saveSessions(this.context.workspaceState, this.sessions);
    await this.postState();
  }

  private async deleteSession(sessionId: string): Promise<void> {
    if (this.sessions.length <= 1) {
      const session = this.sessions[0];
      if (session) {
        session.messages = [];
        session.updatedAt = Date.now();
        await saveSessions(this.context.workspaceState, this.sessions);
        await this.postState();
      }
      return;
    }

    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0]?.id;
    }
    await saveSessions(this.context.workspaceState, this.sessions);
    await this.postState();
  }

  public async ensureReady(): Promise<void> {
    if (!this.view) {
      await this.tryFocusView();
    }
    await this.ready;
  }

  private async tryFocusView(): Promise<void> {
    try {
      await vscode.commands.executeCommand('meerai.chat.focus');
      return;
    } catch {
      // Fall back to focusing the activity bar container
    }
    try {
      await vscode.commands.executeCommand('workbench.view.extension.meerai');
    } catch {
      // Ignore – view might already be visible
    }
  }

  private setActiveSession(sessionId: string): void {
    if (!this.sessions.find((session) => session.id === sessionId)) {
      return;
    }
    this.activeSessionId = sessionId;
    this.view?.show?.(true);
    void this.postState();
  }

  private async handleAsk(requestId: string, prompt: string, sessionId: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      vscode.window.showErrorMessage('MeerAI: unable to locate the selected chat session.');
      return;
    }

    const userMessage = createMessage('user', prompt);
    session.messages.push(userMessage);
    session.updatedAt = Date.now();
    await saveSessions(this.context.workspaceState, this.sessions);
    await this.postState();

    const cancellation = new vscode.CancellationTokenSource();
    this.pendingRequests.set(requestId, {
      dispose: () => cancellation.cancel(),
      sessionId,
      responseBuffer: '',
    });

    try {
      const response = await this.client.ask(prompt, {
        token: cancellation.token,
        onData: (chunk) => {
          const pending = this.pendingRequests.get(requestId);
          if (!pending) {
            return;
          }
          pending.responseBuffer += chunk;
          this.view?.webview.postMessage({
            type: 'stream',
            sessionId,
            requestId,
            chunk,
          });
        },
      });

      const pending = this.pendingRequests.get(requestId);
      const content =
        pending?.responseBuffer.trim() || (response ? response.trim() : '');

      if (content) {
        const assistantMessage: ChatMessage = createMessage('assistant', content);
        session.messages.push(assistantMessage);
        session.updatedAt = Date.now();
        await saveSessions(this.context.workspaceState, this.sessions);
      }

      this.view?.webview.postMessage({
        type: 'done',
        requestId,
      });
      await this.postState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view?.webview.postMessage({
        type: 'error',
        requestId,
        message,
      });
    } finally {
      const pending = this.pendingRequests.get(requestId);
      pending?.dispose?.();
      this.pendingRequests.delete(requestId);
    }
  }

  private cancelRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      pending.dispose?.();
      this.pendingRequests.delete(requestId);
    }
  }

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }

    const provider = await this.buildProviderState();
    const state: WebviewState = {
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
      provider,
    };

    this.view.webview.postMessage({
      type: 'state',
      ...state,
    });
  }

  private async buildProviderState(): Promise<WebviewState['provider']> {
    try {
      const config = await ensureMeerConfig();
      const providerId = ((config.provider ?? 'ollama') as ProviderId) || 'ollama';
      const label = providerLabel(providerId);
      const defaultModel = getDefaultModel(providerId);

      const persisted = getPersistedModel(this.context.workspaceState);
      const configModel =
        typeof config.model === 'string' && config.model.trim().length > 0
          ? config.model.trim()
          : undefined;

      const model = persisted ?? configModel ?? defaultModel;
      const source: 'workspace' | 'config' | 'default' = persisted
        ? 'workspace'
        : configModel
        ? 'config'
        : 'default';

      return { id: providerId, label, model, source };
    } catch (error) {
      console.warn('MeerAI: unable to load provider configuration', error);
      return undefined;
    }
  }

  private async showSettingsMenu(): Promise<void> {
    const items: (vscode.QuickPickItem & { action: SettingsAction })[] = [
      {
        label: '$(settings) Configure Provider / API Keys',
        description: 'Update ~/.meer/config.yaml',
        action: 'configure',
      },
      {
        label: '$(symbol-parameter) Choose Model',
        description: 'Select or enter the default model',
        action: 'model',
      },
      {
        label: '$(refresh) Reload Sessions',
        description: 'Reload chats from disk',
        action: 'reload',
      },
      {
        label: '$(trash) Clear Conversations',
        description: 'Delete stored chats for this workspace',
        action: 'clear',
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'MeerAI actions',
      ignoreFocusOut: true,
    });

    if (!picked) {
      return;
    }

    switch (picked.action) {
      case 'configure':
        await configureProviderInteractively();
        await this.postState();
        break;
      case 'model': {
        const config = await ensureMeerConfig();
        const providerId = ((config.provider ?? 'ollama') as ProviderId) || 'ollama';
        const model = await selectModel(this.context.workspaceState, providerId, config);
        if (model) {
          await updateModelInConfig(model);
          vscode.window.showInformationMessage(
            `MeerAI: using model "${model}" for ${providerLabel(providerId)}.`
          );
          await this.postState();
        }
        break;
      }
      case 'reload': {
        this.sessions = loadSessions(this.context.workspaceState);
        if (!this.sessions.length) {
          const session = createSession('Chat 1');
          this.sessions = [session];
          this.activeSessionId = session.id;
        } else if (
          !this.activeSessionId ||
          !this.sessions.some((session) => session.id === this.activeSessionId)
        ) {
          this.activeSessionId = this.sessions[0]?.id;
        }
        await saveSessions(this.context.workspaceState, this.sessions);
        await this.postState();
        vscode.window.showInformationMessage('MeerAI: conversations reloaded.');
        break;
      }
      case 'clear': {
        const confirmation = await vscode.window.showWarningMessage(
          'Clear all MeerAI chats for this workspace?',
          { modal: true },
          'Clear'
        );
        if (confirmation === 'Clear') {
          const session = createSession('Chat 1');
          this.sessions = [session];
          this.activeSessionId = session.id;
          await saveSessions(this.context.workspaceState, this.sessions);
          await this.postState();
          vscode.window.showInformationMessage('MeerAI: conversations cleared.');
        }
        break;
      }
      default:
        break;
    }
  }

  private createNonce(): string {
    return Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 36).toString(36)
    ).join('');
  }
}

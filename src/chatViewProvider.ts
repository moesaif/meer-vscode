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
    }
    #chat-header h1 {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
    }
    .header-left {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    #session-meta {
      font-size: 0.8rem;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 0.4rem;
      align-items: center;
    }
    #session-meta[aria-hidden=true] {
      display: none;
    }
    .header-actions {
      display: flex;
      gap: 0.4rem;
    }
    .header-actions button {
      border: none;
      background: color-mix(in srgb, var(--vscode-button-background) 60%, transparent);
      color: var(--vscode-button-foreground);
      padding: 0.35rem 0.7rem;
      border-radius: 4px;
      cursor: pointer;
    }
    .header-actions button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    #settings {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent);
    }
    #settings:hover {
      color: var(--vscode-button-foreground);
      border-color: color-mix(in srgb, var(--vscode-button-foreground) 40%, transparent);
    }
    #conversation {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .message {
      padding: 0.75rem 1rem;
      border-radius: 8px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-editorWidget-border) 60%, transparent);
    }
    .message.user {
      align-self: flex-end;
      background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 25%, transparent);
    }
    .message.assistant {
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 80%, transparent);
    }
    .message.streaming {
      border-style: dashed;
    }
    form {
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
    }
    textarea {
      resize: vertical;
      min-height: 3rem;
      max-height: 12rem;
      font-family: inherit;
      font-size: inherit;
      padding: 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: inherit;
    }
    .status {
      font-size: 0.8rem;
      color: var(--vscode-descriptionForeground);
      min-height: 1rem;
    }
    .form-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
    }
    .form-actions button {
      padding: 0.5rem 1.25rem;
      border: none;
      border-radius: 6px;
      cursor: pointer;
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
      color: var(--vscode-button-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-button-foreground) 40%, transparent);
    }
    #cancel[disabled] {
      opacity: 0.4;
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
          <h1 id="session-title">Chat</h1>
          <div id="session-meta"></div>
        </div>
        <div class="header-actions">
          <button id="settings" title="Configure provider and model">Settings</button>
          <button id="rename-session" title="Rename chat">Rename</button>
          <button id="delete-session" title="Delete chat">Delete</button>
        </div>
      </header>
      <main id="conversation" aria-live="polite" aria-label="MeerAI conversation history"></main>
      <form id="meerai-form">
        <textarea id="prompt" placeholder="Ask MeerAI about your workspace…"></textarea>
        <div class="status" id="status"></div>
        <div class="form-actions">
          <button type="button" id="cancel" disabled>Cancel</button>
          <button type="submit" id="submit">Send</button>
        </div>
      </form>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const sessionList = document.getElementById('session-list');
    const conversation = document.getElementById('conversation');
    const sessionTitle = document.getElementById('session-title');
    const sessionMeta = document.getElementById('session-meta');
    const form = document.getElementById('meerai-form');
    const textarea = document.getElementById('prompt');
    const status = document.getElementById('status');
    const submitButton = document.getElementById('submit');
    const cancelButton = document.getElementById('cancel');
    const newChatButton = document.getElementById('new-chat');
    const renameButton = document.getElementById('rename-session');
    const deleteButton = document.getElementById('delete-session');
    const settingsButton = document.getElementById('settings');
    if (sessionMeta) {
      sessionMeta.setAttribute('aria-hidden', 'true');
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

      appendMessageElement('user', prompt, { messageId: requestId + '-user' });

      textarea.value = '';
      textarea.focus();

      vscode.postMessage({
        type: 'ask',
        requestId,
        prompt,
        sessionId: session.id,
      });
    });

    cancelButton.addEventListener('click', () => {
      if (state.activeRequestId) {
        vscode.postMessage({ type: 'cancel', requestId: state.activeRequestId });
      }
    });

    newChatButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'newSession' });
    });

    renameButton.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) {
        return;
      }
      const title = window.prompt('Rename chat', session.title);
      if (title !== null) {
        vscode.postMessage({ type: 'renameSession', sessionId: session.id, title });
      }
    });

    deleteButton.addEventListener('click', () => {
      const session = getActiveSession();
      if (!session) {
        return;
      }
      const confirmed = window.confirm('Delete this chat? Previous messages will be removed.');
      if (confirmed) {
        vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
      }
    });

    if (settingsButton) {
      settingsButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'openSettings' });
      });
    }

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

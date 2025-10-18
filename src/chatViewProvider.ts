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
  controls?: ControlState;
}

interface ControlState {
  mode: 'plan' | 'act';
  autoApprove: boolean;
  collectContext: boolean;
}

const CONTROL_STATE_KEY = 'meerai.chatControls';
const DEFAULT_CONTROLS: ControlState = {
  mode: 'plan',
  autoApprove: false,
  collectContext: false,
};

type SettingsAction = "configure" | "model" | "reload" | "clear";
export class MeerAiChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'meerai.chat';

  private view?: vscode.WebviewView;
  private sessions: ChatSession[] = [];
  private activeSessionId?: string;
  private controls: ControlState = { ...DEFAULT_CONTROLS };
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly ready: Promise<void>;
  private resolveReady?: () => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: MeerAiClient
  ) {
    this.controls = this.loadControlState();
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
        case 'updateControls':
          await this.updateControls(message.patch);
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

    return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MeerAI</title>
  <style>
    :root { color-scheme: light dark; font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 13px; line-height: 1.5; }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); }
    button { font: inherit; }
    #app { display: grid; grid-template-columns: minmax(220px, 260px) 1fr; min-height: 100vh; height: 100vh; }
    @media (max-width: 860px) {
      #app { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
      #sidebar { position: sticky; top: 0; z-index: 1; border-right: none; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
    }
    #sidebar { display: flex; flex-direction: column; background: color-mix(in srgb, var(--vscode-sideBar-background) 85%, var(--vscode-editor-background)); border-right: 1px solid var(--vscode-sideBarSectionHeader-border); }
    .sidebar-header { display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1rem; gap: 0.75rem; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
    .sidebar-title { display: inline-flex; align-items: center; gap: 0.6rem; font-size: 0.95rem; font-weight: 600; }
    .sidebar-title img { width: 22px; height: 22px; }
    .sidebar-button { border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent); background: transparent; color: var(--vscode-descriptionForeground); width: 28px; height: 28px; border-radius: 6px; display: grid; place-items: center; cursor: pointer; transition: background 120ms ease; }
    .sidebar-button:hover { background: color-mix(in srgb, var(--vscode-button-hoverBackground) 70%, transparent); color: var(--vscode-button-foreground); }
    #session-list { list-style: none; margin: 0; padding: 0; flex: 1; overflow-y: auto; }
    .session-item { padding: 0.75rem 1rem; border-bottom: 1px solid color-mix(in srgb, var(--vscode-sideBarSectionHeader-border) 60%, transparent); display: flex; flex-direction: column; gap: 0.35rem; cursor: pointer; transition: background 120ms ease; }
    .session-item:hover, .session-item.active { background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 25%, transparent); }
    .session-title { font-weight: 600; font-size: 0.9rem; color: var(--vscode-foreground); }
    .session-preview { font-size: 0.75rem; color: var(--vscode-descriptionForeground); line-height: 1.3; max-height: 3em; overflow: hidden; }
    #chat { display: flex; flex-direction: column; background: var(--vscode-editor-background); min-height: 0; }
    #chat-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1rem 1.2rem; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
    .header-info { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
    .title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    .title-row h1 { margin: 0; font-size: 1.2rem; font-weight: 600; }
    #session-mode { font-size: 0.75rem; padding: 0.2rem 0.7rem; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 40%, transparent); color: var(--vscode-descriptionForeground); }
    #session-meta { font-size: 0.75rem; color: var(--vscode-descriptionForeground); display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .header-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .header-actions button { border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent); background: transparent; color: var(--vscode-descriptionForeground); padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; transition: background 120ms ease; }
    .header-actions button.danger { border-color: color-mix(in srgb, var(--vscode-errorForeground) 40%, transparent); color: var(--vscode-errorForeground); }
    .header-actions button:hover { background: color-mix(in srgb, var(--vscode-button-hoverBackground) 70%, transparent); color: var(--vscode-button-foreground); }
    .conversation { flex: 1; display: flex; flex-direction: column; position: relative; background: var(--vscode-editor-background); min-height: 0; }
    .conversation.hero-visible .message-list { display: none; }
    .conversation.hero-visible .hero { display: flex; }
    .message-list { flex: 1; overflow-y: auto; padding: 1.2rem; display: flex; flex-direction: column; gap: 1rem; min-height: 0; }
    .hero { display: none; flex: 1; flex-direction: column; justify-content: center; align-items: center; gap: 1rem; text-align: center; padding: 2rem; color: var(--vscode-descriptionForeground); }
    .hero h2 { margin: 0; color: var(--vscode-foreground); font-size: 1.3rem; }
    .hero p { margin: 0; max-width: 440px; }
    .hero-icon { width: 72px; height: 72px; border-radius: 50%; display: grid; place-items: center; font-weight: 600; letter-spacing: 0.08em; background: color-mix(in srgb, var(--vscode-button-background) 35%, transparent); color: var(--vscode-button-foreground); }
    .hero-badges { display: flex; flex-wrap: wrap; gap: 0.4rem; justify-content: center; }
    .badge { padding: 0.2rem 0.6rem; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 40%, transparent); font-size: 0.75rem; background: color-mix(in srgb, var(--vscode-editorWidget-background) 85%, transparent); color: var(--vscode-descriptionForeground); }
    .hero-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; }
    .hero-actions button { border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 40%, transparent); background: transparent; color: var(--vscode-descriptionForeground); padding: 0.45rem 0.9rem; border-radius: 999px; cursor: pointer; transition: background 120ms ease; }
    .hero-actions button:hover { color: var(--vscode-button-foreground); border-color: color-mix(in srgb, var(--vscode-button-background) 40%, transparent); }
    .message-card { display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; padding: 0.9rem 1rem; border-radius: 12px; background: color-mix(in srgb, var(--vscode-editorWidget-background) 85%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-editorWidget-border) 40%, transparent); position: relative; word-break: break-word; }
    .message-card.user { background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 25%, transparent); }
    .message-card.streaming::after { content: ""; position: absolute; inset: 0; border-radius: 12px; border: 1px dashed color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent); pointer-events: none; }
    .avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-size: 0.8rem; font-weight: 600; background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 25%, transparent); color: var(--vscode-foreground); }
    .message-card.user .avatar { background: color-mix(in srgb, var(--vscode-editor-selectionBackground) 45%, transparent); }
    .message-body { display: flex; flex-direction: column; gap: 0.5rem; }
    .message-meta { font-size: 0.75rem; color: var(--vscode-descriptionForeground); display: inline-flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
    .message-content { font-size: 0.95rem; line-height: 1.6; color: var(--vscode-foreground); word-break: break-word; }
    .message-content pre { margin: 0; padding: 0.75rem; border-radius: 8px; background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent); overflow-x: auto; font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace); font-size: 0.9rem; position: relative; }
    .message-content pre[data-language]::before { content: attr(data-language); position: absolute; top: 0.35rem; right: 0.6rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: color-mix(in srgb, var(--vscode-descriptionForeground) 60%, transparent); }
    #composer { padding: 1rem 1.2rem 1.25rem; display: flex; flex-direction: column; gap: 0.9rem; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); background: color-mix(in srgb, var(--vscode-editor-background) 94%, transparent); }
    .control-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem; }
    .toggle-group { display: inline-flex; gap: 0.65rem; align-items: center; flex-wrap: wrap; }
    .toggle { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; color: var(--vscode-descriptionForeground); }
    .toggle input { accent-color: color-mix(in srgb, var(--vscode-button-background) 80%, transparent); }
    .mode-switch { display: inline-flex; gap: 0.4rem; padding: 0.25rem; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 40%, transparent); background: color-mix(in srgb, var(--vscode-editor-background) 95%, transparent); }
    .mode-option { border: none; background: transparent; color: var(--vscode-descriptionForeground); padding: 0.3rem 0.9rem; border-radius: 999px; cursor: pointer; font-size: 0.8rem; }
    .mode-option.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    textarea { resize: vertical; min-height: 4.5rem; max-height: 14rem; font: inherit; padding: 0.85rem; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--vscode-input-border) 75%, transparent); background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent); color: inherit; }
    textarea:focus { outline: 1px solid color-mix(in srgb, var(--vscode-button-background) 60%, transparent); }
    .composer-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem; }
    .status-text { font-size: 0.8rem; min-height: 1rem; color: var(--vscode-descriptionForeground); }
    .composer-actions { display: inline-flex; gap: 0.5rem; }
    .primary-button { display: inline-flex; align-items: center; gap: 0.35rem; border: none; border-radius: 8px; padding: 0.55rem 1.3rem; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
    .primary-button[disabled] { opacity: 0.6; cursor: default; }
    .ghost { border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 30%, transparent); background: transparent; color: var(--vscode-descriptionForeground); border-radius: 8px; padding: 0.55rem 1.1rem; cursor: pointer; }
    .ghost[disabled] { opacity: 0.4; cursor: default; }
    @media (max-width: 640px) {
      .control-bar { flex-direction: column; align-items: stretch; }
      .toggle-group { justify-content: flex-start; }
      .mode-switch { justify-content: space-between; width: 100%; }
      .mode-option { flex: 1 1 auto; text-align: center; }
      #composer { padding: 0.85rem 1rem 1.1rem; }
      #chat-header { flex-direction: column; align-items: stretch; gap: 0.75rem; }
      .header-actions { justify-content: flex-start; }
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
      <ul id="session-list" role="list"></ul>
    </aside>
    <section id="chat">
      <header id="chat-header">
        <div class="header-info">
          <div class="title-row">
            <h1 id="session-title">Chat</h1>
            <span id="session-mode">Planning Mode</span>
          </div>
          <div id="session-meta" aria-hidden="true"></div>
        </div>
        <div class="header-actions">
          <button id="settings" class="ghost-button" title="Configure provider and model">Settings</button>
          <button id="rename-session" class="ghost-button" title="Rename chat">Rename</button>
          <button id="delete-session" class="ghost-button danger" title="Delete chat">Delete</button>
        </div>
      </header>
      <div id="conversation" class="conversation hero-visible" aria-live="polite" aria-label="MeerAI conversation history">
        <div id="hero" class="hero" role="presentation">
          <div class="hero-icon">AI</div>
          <h2>Ask MeerAI about your workspace</h2>
          <p>Plan work, explain code, and review changes without leaving this window.</p>
          <div id="hero-badges" class="hero-badges"></div>
          <div class="hero-actions">
            <button type="button" data-prompt="Draft a plan for the feature I am working on.">Draft a plan</button>
            <button type="button" data-prompt="Review the latest repository changes and highlight risks.">Review latest changes</button>
            <button type="button" data-prompt="Explain how the active file fits into the broader project.">Explain this file</button>
          </div>
        </div>
        <div id="messages" class="message-list" role="log"></div>
      </div>
      <form id="composer">
        <div class="control-bar">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="auto-approve">
              <span>Auto-approve</span>
            </label>
            <label class="toggle">
              <input type="checkbox" id="collect-context">
              <span>Capture context</span>
            </label>
          </div>
          <div class="mode-switch" role="group" aria-label="Assistant mode">
            <button type="button" class="mode-option active" data-mode="plan">Plan</button>
            <button type="button" class="mode-option" data-mode="act">Act</button>
          </div>
        </div>
        <textarea id="prompt" name="prompt" placeholder="Ask MeerAI..." autocomplete="off"></textarea>
        <div class="composer-footer">
          <div id="status" class="status-text"></div>
          <div class="composer-actions">
            <button type="button" id="cancel" class="ghost" disabled>Cancel</button>
            <button type="submit" id="submit" class="primary-button">
              <span class="icon">→</span>
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
      const CONTROL_DEFAULTS = Object.freeze({ autoApprove: false, collectContext: false, mode: "plan" });
      const dom = {
        sessionList: document.getElementById("session-list"),
        newChatButton: document.getElementById("new-chat"),
        conversation: document.getElementById("conversation"),
        messages: document.getElementById("messages"),
        hero: document.getElementById("hero"),
        heroBadges: document.getElementById("hero-badges"),
        heroActions: Array.from(document.querySelectorAll("[data-prompt]")),
        sessionTitle: document.getElementById("session-title"),
        sessionMeta: document.getElementById("session-meta"),
        sessionMode: document.getElementById("session-mode"),
        settingsButton: document.getElementById("settings"),
        renameButton: document.getElementById("rename-session"),
        deleteButton: document.getElementById("delete-session"),
        autoApproveToggle: document.getElementById("auto-approve"),
        collectContextToggle: document.getElementById("collect-context"),
        modeButtons: Array.from(document.querySelectorAll(".mode-option")),
        form: document.getElementById("composer"),
        textarea: document.getElementById("prompt"),
        submitButton: document.getElementById("submit"),
        cancelButton: document.getElementById("cancel"),
        status: document.getElementById("status"),
      };
      const state = {
        sessions: [],
        activeSessionId: null,
        activeRequestId: null,
        pendingResponses: new Map(),
        controls: { ...CONTROL_DEFAULTS },
        provider: null,
      };

      function shouldStickToBottom() {
        if (!dom.messages) {
          return false;
        }
        const distance = dom.messages.scrollHeight - dom.messages.clientHeight - dom.messages.scrollTop;
        return distance <= 56;
      }

      function scrollToBottom() {
        if (!dom.messages) {
          return;
        }
        requestAnimationFrame(() => {
          dom.messages.scrollTop = dom.messages.scrollHeight;
        });
      }
      dom.newChatButton?.addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
      dom.settingsButton?.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));
      dom.renameButton?.addEventListener("click", () => {
        const session = getActiveSession();
        if (!session) { return; }
        const title = window.prompt("Rename chat", session.title);
        if (title !== null) {
          vscode.postMessage({ type: "renameSession", sessionId: session.id, title });
        }
      });
      dom.deleteButton?.addEventListener("click", () => {
        const session = getActiveSession();
        if (!session) { return; }
        const confirmed = window.confirm("Delete this chat? Messages will be removed.");
        if (confirmed) {
          vscode.postMessage({ type: "deleteSession", sessionId: session.id });
        }
      });
      dom.cancelButton?.addEventListener("click", () => {
        if (state.activeRequestId) {
          vscode.postMessage({ type: "cancel", requestId: state.activeRequestId });
        }
      });
      dom.heroActions.forEach((button) => {
        button.addEventListener("click", () => {
          const prompt = button.getAttribute("data-prompt");
          if (prompt && dom.textarea) {
            dom.textarea.value = prompt;
            dom.textarea.focus();
          }
        });
      });
      dom.autoApproveToggle?.addEventListener("change", () => syncControls({ autoApprove: dom.autoApproveToggle.checked }));
      dom.collectContextToggle?.addEventListener("change", () => syncControls({ collectContext: dom.collectContextToggle.checked }));
      dom.modeButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const mode = button.getAttribute("data-mode") === "act" ? "act" : "plan";
          syncControls({ mode });
        });
      });
      dom.sessionList?.addEventListener("click", (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const item = target?.closest("li[data-session-id]");
        if (item) {
          const sessionId = item.getAttribute("data-session-id");
          if (sessionId) {
            vscode.postMessage({ type: "selectSession", sessionId });
          }
        }
      });
      dom.form?.addEventListener("submit", (event) => {
        event.preventDefault();
        const session = getActiveSession();
        if (!session) {
          vscode.postMessage({ type: "newSession" });
          return;
        }
        const prompt = (dom.textarea?.value || "").trim();
        if (!prompt || state.activeRequestId) {
          return;
        }
        const requestId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now());
        state.activeRequestId = requestId;
        state.pendingResponses.delete(requestId);
        setStatus("Thinking...");
        setPendingState(true);
        appendMessageCard("user", prompt, { messageId: requestId + "-user", createdAt: Date.now() });
        if (dom.textarea) {
          dom.textarea.value = "";
          dom.textarea.focus();
        }
        vscode.postMessage({ type: "ask", requestId, prompt, sessionId: session.id });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        switch (message.type) {
          case "state":
            state.sessions = Array.isArray(message.sessions) ? message.sessions : [];
            state.activeSessionId = message.activeSessionId || null;
            state.provider = message.provider || null;
            state.controls = normalizeControls(message.controls);
            renderSessions();
            renderConversation();
            renderControls();
            renderHero();
            break;
          case "stream": {
            const current = state.pendingResponses.get(message.requestId) || { sessionId: message.sessionId, content: "" };
            current.sessionId = message.sessionId;
            current.content = (current.content || "") + (message.chunk || "");
            state.pendingResponses.set(message.requestId, current);
            if (message.sessionId === state.activeSessionId) {
              updateStreamingMessage(message.requestId, current.content);
            }
            break;
          }
          case "done":
            state.pendingResponses.delete(message.requestId);
            if (state.activeRequestId === message.requestId) {
              state.activeRequestId = null;
              setStatus("");
              setPendingState(false);
            }
            removeStreamingMessage(message.requestId);
            renderHero();
            break;
          case "error":
            state.pendingResponses.delete(message.requestId);
            if (state.activeRequestId === message.requestId) {
              state.activeRequestId = null;
              setStatus(message.message || "Something went wrong.");
              setPendingState(false);
            }
            removeStreamingMessage(message.requestId);
            renderHero();
            break;
          default:
            break;
        }
      });

      function getActiveSession() {
        return state.sessions.find((session) => session.id === state.activeSessionId) || null;
      }

      function renderSessions() {
        if (!dom.sessionList) { return; }
        dom.sessionList.innerHTML = "";
        for (const session of state.sessions) {
          const item = document.createElement("li");
          item.className = "session-item" + (session.id === state.activeSessionId ? " active" : "");
          item.dataset.sessionId = session.id;

          const title = document.createElement("div");
          title.className = "session-title";
          title.textContent = session.title || "Chat";
          item.appendChild(title);

          const preview = document.createElement("div");
          preview.className = "session-preview";
          const lastMessage = session.messages[session.messages.length - 1];
          preview.textContent = lastMessage ? summarize(lastMessage.content) : "Start chatting.";
          item.appendChild(preview);

          dom.sessionList.appendChild(item);
        }
      }

      function renderConversation() {
        if (!dom.messages || !dom.conversation) { return; }
        const stick = shouldStickToBottom();
        dom.messages.innerHTML = "";
        const session = getActiveSession();
        renderProviderInfo();
        if (!session) {
          if (dom.sessionTitle) {
            dom.sessionTitle.textContent = "No chat selected";
          }
          setPendingState(true);
          renderHero();
          return;
        }

        if (dom.sessionTitle) {
          dom.sessionTitle.textContent = session.title || "Chat";
        }
        setPendingState(Boolean(state.activeRequestId));

        const fragment = document.createDocumentFragment();
        for (const message of session.messages) {
          fragment.appendChild(
            buildMessageCard(message.role, message.content, {
              messageId: message.id,
              createdAt: message.createdAt,
            })
          );
        }
        dom.messages.appendChild(fragment);

        for (const [requestId, pending] of state.pendingResponses.entries()) {
          if (pending.sessionId === session.id) {
            updateStreamingMessage(requestId, pending.content);
          }
        }

        if (stick) {
          scrollToBottom();
        }
        renderHero();
      }

      function buildMessageCard(role, text, options = {}) {
        const card = document.createElement("article");
        card.className = "message-card " + (role === "assistant" ? "assistant" : "user");
        if (options.streaming) { card.classList.add("streaming"); }
        if (options.messageId) { card.dataset.messageId = options.messageId; }
        if (options.requestId) { card.dataset.requestId = options.requestId; }

        const avatar = document.createElement("div");
        avatar.className = "avatar";
        avatar.textContent = role === "assistant" ? "AI" : "You";

        const body = document.createElement("div");
        body.className = "message-body";

        const meta = document.createElement("div");
        meta.className = "message-meta";
        const who = document.createElement("span");
        who.textContent = role === "assistant" ? "MeerAI" : "You";
        const when = document.createElement("time");
        const timestamp = typeof options.createdAt === "number" ? options.createdAt : Date.now();
        const date = new Date(timestamp);
        when.dateTime = date.toISOString();
        when.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        meta.append(who, document.createTextNode(" · "), when);

        const content = document.createElement("div");
        content.className = "message-content";
        content.innerHTML = renderMessageHtml(text || "");

        body.append(meta, content);
        card.append(avatar, body);
        return card;
      }

      function appendMessageCard(role, text, options) {
        if (!dom.messages) { return null; }
        const stick = shouldStickToBottom();
        const card = buildMessageCard(role, text, options);
        dom.messages.appendChild(card);
        if (stick) {
          scrollToBottom();
        }
        renderHero();
        return card;
      }

      function updateStreamingMessage(requestId, text) {
        if (!dom.messages) { return; }
        const stick = shouldStickToBottom();
        let card = dom.messages.querySelector('.message-card.streaming[data-request-id="' + requestId + '"]');
        if (!card) {
          card = appendMessageCard("assistant", text, { requestId, streaming: true, createdAt: Date.now() });
          return;
        }
        const content = card.querySelector(".message-content");
        if (content) {
          content.innerHTML = renderMessageHtml(text || "");
        }
        if (stick) {
          scrollToBottom();
        }
      }

      function removeStreamingMessage(requestId) {
        if (!dom.messages) { return; }
        const card = dom.messages.querySelector('.message-card.streaming[data-request-id="' + requestId + '"]');
        if (card && card.parentElement === dom.messages) {
          dom.messages.removeChild(card);
        }
        if (shouldStickToBottom()) {
          scrollToBottom();
        }
        renderHero();
      }

      function setStatus(text) {
        if (dom.status) {
          dom.status.textContent = text || "";
        }
      }

      function setPendingState(pending) {
        if (dom.submitButton) {
          dom.submitButton.disabled = pending || !state.activeSessionId;
        }
        if (dom.cancelButton) {
          dom.cancelButton.disabled = !pending;
        }
      }

      function summarize(text) {
        if (!text) { return ""; }
        const trimmed = text.trim().replace(/\s+/g, " ");
        return trimmed.length > 60 ? trimmed.slice(0, 57) + "..." : trimmed;
      }

      function renderControls() {
        if (dom.autoApproveToggle) {
          dom.autoApproveToggle.checked = Boolean(state.controls.autoApprove);
        }
        if (dom.collectContextToggle) {
          dom.collectContextToggle.checked = Boolean(state.controls.collectContext);
        }
        dom.modeButtons.forEach((button) => {
          const mode = button.getAttribute("data-mode") === "act" ? "act" : "plan";
          if (state.controls.mode === mode) {
            button.classList.add("active");
          } else {
            button.classList.remove("active");
          }
        });
        if (dom.sessionMode) {
          dom.sessionMode.textContent = state.controls.mode === "act" ? "Action Mode" : "Planning Mode";
        }
        renderHeroBadges();
      }

      function renderProviderInfo() {
        if (!dom.sessionMeta) { return; }
        if (!state.provider) {
          dom.sessionMeta.textContent = "";
          dom.sessionMeta.setAttribute("aria-hidden", "true");
          dom.sessionMeta.removeAttribute("title");
          return;
        }
        const { label, model, source } = state.provider;
        const segments = [label];
        if (model) { segments.push(model); }
        dom.sessionMeta.textContent = segments.join(" • ");
        let origin = "provider default";
        if (source === "workspace") { origin = "workspace override"; }
        else if (source === "config") { origin = "config default"; }
        const modelLabel = model || "default";
        dom.sessionMeta.title = "Provider: " + label + "\nModel: " + modelLabel + " (" + origin + ")";
        dom.sessionMeta.setAttribute("aria-hidden", "false");
      }

      function renderHero() {
        if (!dom.conversation) { return; }
        const session = getActiveSession();
        let hasMessages = false;
        let hasStreaming = false;
        if (session) {
          hasMessages = Array.isArray(session.messages) && session.messages.length > 0;
          hasStreaming = Array.from(state.pendingResponses.values()).some(
            (pending) => pending.sessionId === session.id && pending.content && pending.content.trim().length > 0
          );
        }
        const showHero = !session || (!hasMessages && !hasStreaming);
        const wasHeroVisible = dom.conversation.classList.contains("hero-visible");
        if (showHero) {
          dom.conversation.classList.add("hero-visible");
        } else {
          dom.conversation.classList.remove("hero-visible");
          if (wasHeroVisible || shouldStickToBottom()) {
            scrollToBottom();
          }
        }
        renderHeroBadges();
      }

      function renderHeroBadges() {
        if (!dom.heroBadges) { return; }
        dom.heroBadges.innerHTML = "";
        const badges = [];
        if (state.provider) {
          badges.push({ label: "Provider", value: state.provider.label });
          if (state.provider.model) {
            badges.push({ label: "Model", value: state.provider.model });
          }
        }
        badges.push({ label: "Mode", value: state.controls.mode === "act" ? "Act" : "Plan" });
        badges.push({ label: "Auto-approve", value: state.controls.autoApprove ? "On" : "Off" });
        badges.push({ label: "Context", value: state.controls.collectContext ? "On" : "Off" });
        for (const badge of badges) {
          const el = document.createElement("span");
          el.className = "badge";
          el.textContent = badge.label + ": " + badge.value;
          dom.heroBadges.appendChild(el);
        }
      }

      function renderMessageHtml(text) {
        if (!text) { return ""; }
        const lines = text.split("\n");
        const pieces = [];
        let paragraph = [];
        let inCode = false;
        let codeLanguage = "";
        let codeLines = [];

        const flushParagraph = () => {
          if (!paragraph.length) { return; }
          const block = paragraph.join("\n").trim();
          if (!block) {
            paragraph = [];
            return;
          }
          const html = escapeHtml(block).replace(/\n/g, "<br>");
          pieces.push("<p>" + html + "</p>");
          paragraph = [];
        };

        const flushCode = () => {
          if (!inCode) { return; }
          const languageAttr = codeLanguage ? ' data-language="' + escapeAttribute(codeLanguage) + '"' : "";
          const body = escapeHtml(codeLines.join("\n"));
          pieces.push("<pre" + languageAttr + "><code>" + body + "</code></pre>");
          codeLines = [];
          inCode = false;
          codeLanguage = "";
        };

        for (const line of lines) {
          if (line.startsWith("\`\`\`")) {
            if (inCode) {
              flushCode();
            } else {
              flushParagraph();
              inCode = true;
              codeLanguage = line.slice(3).trim();
              codeLines = [];
            }
            continue;
          }
          if (inCode) {
            codeLines.push(line);
            continue;
          }
          if (!line.trim()) {
            flushParagraph();
            continue;
          }
          paragraph.push(line);
        }

        if (inCode) {
          flushCode();
        }
        flushParagraph();
        return pieces.join("");
      }

      function escapeHtml(value) {
        return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }

      function escapeAttribute(value) {
        return escapeHtml(value).replace(/"/g, "&quot;");
      }

      function normalizeControls(raw) {
        const merged = { ...CONTROL_DEFAULTS };
        if (raw && typeof raw === "object") {
          if (raw.mode === "act") { merged.mode = "act"; }
          else if (raw.mode === "plan") { merged.mode = "plan"; }
          if (typeof raw.autoApprove === "boolean") { merged.autoApprove = raw.autoApprove; }
          if (typeof raw.collectContext === "boolean") { merged.collectContext = raw.collectContext; }
        }
        return merged;
      }

      function syncControls(patch) {
        if (!patch || typeof patch !== "object") { return; }
        const updated = { ...state.controls };
        const payload = {};
        if (typeof patch.autoApprove === "boolean" && patch.autoApprove !== state.controls.autoApprove) {
          updated.autoApprove = patch.autoApprove;
          payload.autoApprove = patch.autoApprove;
        }
        if (typeof patch.collectContext === "boolean" && patch.collectContext !== state.controls.collectContext) {
          updated.collectContext = patch.collectContext;
          payload.collectContext = patch.collectContext;
        }
        if ((patch.mode === "act" || patch.mode === "plan") && patch.mode !== state.controls.mode) {
          updated.mode = patch.mode;
          payload.mode = patch.mode;
        }
        if (Object.keys(payload).length) {
          state.controls = updated;
          renderControls();
          vscode.postMessage({ type: "updateControls", patch: payload });
        } else {
          renderControls();
        }
      }

      renderHero();
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
      controls: { ...this.controls },
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

  private loadControlState(): ControlState {
    const stored = this.context.workspaceState.get<Partial<ControlState>>(CONTROL_STATE_KEY);
    return {
      mode: stored?.mode === 'act' ? 'act' : 'plan',
      autoApprove: stored?.autoApprove === true,
      collectContext: stored?.collectContext === true,
    };
  }

  private async persistControlState(): Promise<void> {
    await this.context.workspaceState.update(CONTROL_STATE_KEY, { ...this.controls });
  }

  private async updateControls(patch: Partial<ControlState>): Promise<void> {
    if (!patch || typeof patch !== 'object') {
      return;
    }

    const next: ControlState = { ...this.controls };
    let changed = false;

    if (patch.mode === 'act' || patch.mode === 'plan') {
      if (next.mode !== patch.mode) {
        next.mode = patch.mode;
        changed = true;
      }
    }
    if (typeof patch.autoApprove === 'boolean' && patch.autoApprove !== next.autoApprove) {
      next.autoApprove = patch.autoApprove;
      changed = true;
    }
    if (typeof patch.collectContext === 'boolean' && patch.collectContext !== next.collectContext) {
      next.collectContext = patch.collectContext;
      changed = true;
    }

    if (!changed) {
      return;
    }

    this.controls = next;
    await this.persistControlState();
    await this.postState();
  }

  private createNonce(): string {
    return Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 36).toString(36)
    ).join('');
  }
}

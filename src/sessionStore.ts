import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

const STORAGE_KEY = 'meerai.chatSessions';

export function loadSessions(store: vscode.Memento): ChatSession[] {
  const raw = store.get<ChatSession[]>(STORAGE_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((session) => session && typeof session === 'object')
    .map((session) => ({
      id: session.id || generateId(),
      title: session.title || 'Chat',
      createdAt: session.createdAt ?? Date.now(),
      updatedAt: session.updatedAt ?? session.createdAt ?? Date.now(),
      messages: Array.isArray(session.messages)
        ? session.messages.map((message) => ({
            id: message.id || generateId(),
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: message.content ?? '',
            createdAt: message.createdAt ?? Date.now(),
          }))
        : [],
    }));
}

export function saveSessions(store: vscode.Memento, sessions: ChatSession[]): Thenable<void> {
  const sanitized = sessions.map((session) => ({
    ...session,
    messages: session.messages.map((message) => ({
      ...message,
    })),
  }));
  return store.update(STORAGE_KEY, sanitized);
}

export function createSession(title?: string): ChatSession {
  const timestamp = Date.now();
  return {
    id: generateId(),
    title: title?.trim() || 'New Chat',
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
  };
}

export function createMessage(role: ChatRole, content: string): ChatMessage {
  return {
    id: generateId(),
    role,
    content,
    createdAt: Date.now(),
  };
}

function generateId(): string {
  if (typeof randomUUID === 'function') {
    return randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

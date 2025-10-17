import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import fetch, { RequestInit } from 'node-fetch';
import { parse, stringify } from 'yaml';

export type ProviderId = 'ollama' | 'openai' | 'gemini' | 'anthropic' | 'openrouter' | 'meer' | 'zai';

interface ProviderMetadata {
  id: ProviderId;
  label: string;
  description: string;
  requiresApiKey?: boolean;
  requiresHost?: boolean;
  requiresBaseUrl?: boolean;
  requiresSiteMetadata?: boolean;
}

const PROVIDERS: ProviderMetadata[] = [
  {
    id: 'ollama',
    label: 'Ollama (local models)',
    description: 'Run local models via an Ollama daemon.',
    requiresHost: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'Connect with OpenAI APIs (GPT-4o, etc.).',
    requiresApiKey: true,
    requiresBaseUrl: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Use Google Gemini models.',
    requiresApiKey: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models via Anthropic.',
    requiresApiKey: true,
    requiresBaseUrl: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Proxy multiple models with a single API key.',
    requiresApiKey: true,
    requiresBaseUrl: true,
    requiresSiteMetadata: true,
  },
  {
    id: 'meer',
    label: 'Meer Managed',
    description: 'Use MeerAI managed infrastructure.',
    requiresApiKey: true,
    requiresBaseUrl: true,
  },
  {
    id: 'zai',
    label: 'Zilliz Z.AI',
    description: 'Claude-compatible coding assistant.',
    requiresApiKey: true,
    requiresBaseUrl: true,
  },
];

const CONFIG_DIR = path.join(os.homedir(), '.meer');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.yaml');
const WORKSPACE_MODEL_KEY = 'meerai.workspaceModel';

const DEFAULT_CONFIG = {
  provider: 'ollama',
  model: 'mistral:7b-instruct',
  temperature: 0.7,
  maxIterations: 25,
  ollama: {
    host: 'http://127.0.0.1:11434',
    options: {},
  },
  openai: {
    apiKey: '',
    baseURL: 'https://api.openai.com/v1',
    organization: '',
  },
  gemini: {
    apiKey: '',
  },
  anthropic: {
    apiKey: '',
    baseURL: 'https://api.anthropic.com',
    maxTokens: 4096,
  },
  openrouter: {
    apiKey: '',
    baseURL: 'https://openrouter.ai/api',
    siteName: 'MeerAI CLI',
    siteUrl: 'https://github.com/meer-ai/meer',
  },
  meer: {
    apiKey: '',
    apiUrl: 'https://api.meerai.dev',
  },
  zai: {
    apiKey: '',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
  },
  context: {
    autoCollect: false,
    embedding: {
      enabled: false,
      dimensions: 256,
      maxFileSize: 200_000,
    },
  },
} satisfies Record<string, unknown>;

const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  ollama: 'mistral:7b-instruct',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash-exp',
  anthropic: 'claude-3-5-sonnet-20241022',
  openrouter: 'anthropic/claude-3.5-sonnet',
  meer: 'auto',
  zai: 'glm-4',
};

export async function ensureMeerConfig(): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = parse(content) ?? {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('MeerAI config must be a YAML object.');
    }
    return deepMerge(DEFAULT_CONFIG, parsed as Record<string, unknown>);
  } catch (error) {
    if (isEnoent(error)) {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const config = structuredClone(DEFAULT_CONFIG);
      await fs.writeFile(CONFIG_PATH, stringify(config, { indent: 2 }) + '\n', 'utf8');
      return structuredClone(config);
    }
    throw new Error(`Unable to read MeerAI config (${CONFIG_PATH}): ${formatError(error)}`);
  }
}

export async function configureProviderInteractively(): Promise<void> {
  let config: Record<string, any>;
  try {
    config = await ensureMeerConfig();
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return;
  }

  const selected = await vscode.window.showQuickPick(
    PROVIDERS.map((provider) => ({
      label: provider.label,
      description: provider.description,
      id: provider.id,
    })),
    {
      placeHolder: 'Select the MeerAI provider you want to use',
      ignoreFocusOut: true,
    }
  );

  if (!selected) {
    return;
  }

  const providerId = selected.id as ProviderId;
  config.provider = providerId;

  const defaultModel = DEFAULT_MODEL_BY_PROVIDER[providerId];
  const currentModel = typeof config.model === 'string' ? config.model : defaultModel;
  const model = await vscode.window.showInputBox({
    prompt: 'Model identifier to request from the provider',
    placeHolder: defaultModel,
    value: currentModel || defaultModel,
    ignoreFocusOut: true,
  });

  if (model === undefined) {
    return;
  }

  config.model = (model.trim() || defaultModel).trim();

  switch (providerId) {
    case 'ollama': {
      const section = ensureSection(config, 'ollama');
      const host = await vscode.window.showInputBox({
        prompt: 'Ollama host URL',
        value: typeof section.host === 'string' ? section.host : 'http://127.0.0.1:11434',
        ignoreFocusOut: true,
      });
      if (host === undefined) {
        return;
      }
      section.host = host.trim() || 'http://127.0.0.1:11434';
      break;
    }
    case 'openai': {
      const section = ensureSection(config, 'openai');
      const apiKey = await promptForSecret('OpenAI API key', section.apiKey);
      if (apiKey === undefined) {
        return;
      }
      if (apiKey !== '') {
        section.apiKey = apiKey;
      }
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'OpenAI base URL (leave blank for default)',
        value: typeof section.baseURL === 'string' ? section.baseURL : 'https://api.openai.com/v1',
        ignoreFocusOut: true,
      });
      if (baseUrl === undefined) {
        return;
      }
      section.baseURL = baseUrl.trim() || 'https://api.openai.com/v1';

      const org = await vscode.window.showInputBox({
        prompt: 'OpenAI organization (optional)',
        value: typeof section.organization === 'string' ? section.organization : '',
        ignoreFocusOut: true,
      });
      if (org === undefined) {
        return;
      }
      section.organization = org.trim();
      break;
    }
    case 'gemini': {
      const section = ensureSection(config, 'gemini');
      const apiKey = await promptForSecret('Google Gemini API key', section.apiKey);
      if (apiKey === undefined) {
        return;
      }
      if (apiKey !== '') {
        section.apiKey = apiKey;
      }
      break;
    }
    case 'anthropic': {
      const section = ensureSection(config, 'anthropic');
      const apiKey = await promptForSecret('Anthropic API key', section.apiKey);
      if (apiKey === undefined) {
        return;
      }
      if (apiKey !== '') {
        section.apiKey = apiKey;
      }
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Anthropic base URL (leave blank for default)',
        value: typeof section.baseURL === 'string' ? section.baseURL : 'https://api.anthropic.com',
        ignoreFocusOut: true,
      });
      if (baseUrl === undefined) {
        return;
      }
      section.baseURL = baseUrl.trim() || 'https://api.anthropic.com';
      break;
    }
    case 'openrouter': {
      const section = ensureSection(config, 'openrouter');
      const apiKey = await promptForSecret('OpenRouter API key', section.apiKey);
      if (apiKey === undefined) {
        return;
      }
      if (apiKey !== '') {
        section.apiKey = apiKey;
      }
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'OpenRouter base URL (leave blank for default)',
        value: typeof section.baseURL === 'string' ? section.baseURL : 'https://openrouter.ai/api',
        ignoreFocusOut: true,
      });
      if (baseUrl === undefined) {
        return;
      }
      section.baseURL = baseUrl.trim() || 'https://openrouter.ai/api';

      const siteName = await vscode.window.showInputBox({
        prompt: 'Site name (sent to OpenRouter for analytics, optional)',
        value: typeof section.siteName === 'string' ? section.siteName : 'MeerAI CLI',
        ignoreFocusOut: true,
      });
      if (siteName === undefined) {
        return;
      }
      section.siteName = siteName.trim() || 'MeerAI CLI';

      const siteUrl = await vscode.window.showInputBox({
        prompt: 'Site URL (optional)',
        value: typeof section.siteUrl === 'string' ? section.siteUrl : 'https://github.com/meer-ai/meer',
        ignoreFocusOut: true,
      });
      if (siteUrl === undefined) {
        return;
      }
      section.siteUrl = siteUrl.trim() || 'https://github.com/meer-ai/meer';
      break;
    }
    case 'meer': {
      const section = ensureSection(config, 'meer');
      const apiKey = await promptForSecret('Meer Managed API key', section.apiKey);
      if (apiKey === undefined) {
        return;
      }
      if (apiKey !== '') {
        section.apiKey = apiKey;
      }
      const apiUrl = await vscode.window.showInputBox({
        prompt: 'Meer Managed API URL (leave blank for default)',
        value: typeof section.apiUrl === 'string' ? section.apiUrl : 'https://api.meerai.dev',
        ignoreFocusOut: true,
      });
      if (apiUrl === undefined) {
        return;
      }
      section.apiUrl = apiUrl.trim() || 'https://api.meerai.dev';
      break;
    }
    case 'zai': {
      const section = ensureSection(config, 'zai');
      const apiKey = await promptForSecret('Z.AI API key', section.apiKey);
      if (apiKey === undefined) {
        return;
      }
      if (apiKey !== '') {
        section.apiKey = apiKey;
      }
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Z.AI base URL (leave blank for default)',
        value: typeof section.baseURL === 'string' ? section.baseURL : 'https://api.z.ai/api/coding/paas/v4',
        ignoreFocusOut: true,
      });
      if (baseUrl === undefined) {
        return;
      }
      section.baseURL = baseUrl.trim() || 'https://api.z.ai/api/coding/paas/v4';
      break;
    }
    default:
      break;
  }

  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(
      CONFIG_PATH,
      stringify(config, { indent: 2, lineWidth: 0 }) + '\n',
      'utf8'
    );
    vscode.window.showInformationMessage(
      `MeerAI provider updated to ${selected.label}.`,
      'Open config file'
    ).then((choice) => {
      if (choice) {
        const uri = vscode.Uri.file(CONFIG_PATH);
        void vscode.workspace.openTextDocument(uri).then((doc) => vscode.window.showTextDocument(doc));
      }
    });
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to write MeerAI config: ${formatError(error)}`
    );
  }
}

export function getMeerConfigPath(): string {
  return CONFIG_PATH;
}

export async function selectModel(
  store: vscode.Memento,
  providerId: ProviderId,
  config: Record<string, any>
): Promise<string | undefined> {
  const models = await listModels(providerId, config);
  if (models.length === 0) {
    vscode.window.showWarningMessage(
      `MeerAI: no models discovered for ${providerLabel(providerId)}. Falling back to custom entry.`
    );
  }

  const current = getPersistedModel(store) ?? config.model ?? DEFAULT_MODEL_BY_PROVIDER[providerId];
  const quickPickItems = [
    ...models.map((model) => ({
      label: model,
      description: 'Provider model',
      value: model,
    })),
    {
      label: 'Custom model…',
      description: 'Enter a model identifier manually',
      value: '__custom__',
    },
  ];

  const picked = await vscode.window.showQuickPick(quickPickItems, {
    title: `Select a model for ${providerLabel(providerId)}`,
    placeHolder: current,
    ignoreFocusOut: true,
  });

  if (!picked) {
    return undefined;
  }

  if (picked.value === '__custom__') {
    const custom = await vscode.window.showInputBox({
      prompt: 'Enter the model identifier',
      value: current,
      ignoreFocusOut: true,
    });
    if (!custom) {
      return undefined;
    }
    await persistModel(store, custom.trim());
    return custom.trim();
  }

  await persistModel(store, picked.value);
  return picked.value;
}

export function getPersistedModel(store: vscode.Memento): string | undefined {
  return store.get<string>(WORKSPACE_MODEL_KEY);
}

async function persistModel(store: vscode.Memento, model: string): Promise<void> {
  await store.update(WORKSPACE_MODEL_KEY, model);
}

async function listModels(
  providerId: ProviderId,
  config: Record<string, any>
): Promise<string[]> {
  switch (providerId) {
    case 'ollama':
      return queryOllamaModels(config.ollama?.host || 'http://127.0.0.1:11434');
    case 'meer':
      return queryMeerManagedModels(config.meer?.apiUrl || 'https://api.meerai.dev', config.meer?.apiKey);
    default:
      return [];
  }
}

async function queryOllamaModels(host: string): Promise<string[]> {
  try {
    const response = await fetchJson(new URL('/api/tags', host));
    if (!response || typeof response !== 'object' || !Array.isArray(response.models)) {
      return [];
    }
    return response.models
      .map((model: any) => (typeof model === 'object' && typeof model.name === 'string' ? model.name : undefined))
      .filter((value: unknown): value is string => Boolean(value));
  } catch (error) {
    reportFetchError('Ollama', error);
    return [];
  }
}

async function queryMeerManagedModels(apiUrl: string, apiKey?: string): Promise<string[]> {
  if (!apiKey) {
    return [];
  }
  try {
    const url = new URL('/v1/models', apiUrl);
    const response = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response || typeof response !== 'object' || !Array.isArray(response.data)) {
      return [];
    }
    return response.data
      .map((entry: any) => (typeof entry === 'object' && typeof entry.id === 'string' ? entry.id : undefined))
      .filter((value: unknown): value is string => Boolean(value));
  } catch (error) {
    reportFetchError('Meer Managed', error);
    return [];
  }
}

async function fetchJson(url: URL, init: RequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function reportFetchError(provider: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showWarningMessage(`MeerAI: could not fetch models from ${provider} (${message}).`);
}

export function providerLabel(id: ProviderId): string {
  const meta = PROVIDERS.find((provider) => provider.id === id);
  return meta?.label ?? id;
}

export function getDefaultModel(providerId: ProviderId): string {
  return DEFAULT_MODEL_BY_PROVIDER[providerId] ?? 'auto';
}

export async function updateModelInConfig(model: string): Promise<void> {
  const config = await ensureMeerConfig();
  config.model = model;
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(
    CONFIG_PATH,
    stringify(config, { indent: 2, lineWidth: 0 }) + '\n',
    'utf8'
  );
}

function ensureSection(
  config: Record<string, any>,
  key: string
): Record<string, any> {
  const existing = config[key];
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    config[key] = {};
  }
  return config[key];
}

async function promptForSecret(prompt: string, currentValue?: unknown): Promise<string | undefined> {
  const placeholder = currentValue ? 'Leave blank to keep the existing value' : undefined;
  const value = await vscode.window.showInputBox({
    prompt,
    placeHolder: placeholder,
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return undefined;
  }
  return value.trim();
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const baseValue = result[key];
      const baseRecord =
        baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue)
          ? (baseValue as Record<string, unknown>)
          : {};
      result[key] = deepMerge(baseRecord, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as any).code === 'ENOENT');
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

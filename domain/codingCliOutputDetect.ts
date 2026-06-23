import type { CodingCliProviderId } from './codingCliProviders';

/** Strip ANSI/OSC sequences so startup banners remain readable. */
export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(/\x1b\[[0-9:;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_]/g, '');
}

type OutputSignature = {
  id: CodingCliProviderId;
  test: (text: string) => boolean;
};

/**
 * Startup banners and prompts emitted by coding CLIs.
 * Codex does not put its name in OSC titles by default (openai/codex#18740),
 * but always prints an "OpenAI Codex" header when the TUI starts.
 */
const OUTPUT_SIGNATURES: readonly OutputSignature[] = [
  {
    id: 'codex',
    test: (text) => /(?:^|\s)(?:>\s*)?OpenAI Codex(?:\s*\(|$|\s)/i.test(text),
  },
  {
    id: 'claude',
    test: (text) => /Claude Code/i.test(text) || text.includes('✳'),
  },
  {
    id: 'copilot',
    test: (text) => /GitHub Copilot/i.test(text),
  },
  {
    id: 'gemini',
    test: (text) => /Gemini CLI/i.test(text),
  },
  {
    id: 'droid',
    test: (text) => /Factory Droid/i.test(text) || /Factory\.ai/i.test(text),
  },
  {
    id: 'opencode',
    test: (text) => /\bOpenCode\b/i.test(text),
  },
  {
    id: 'kimi',
    test: (text) => /\bMoonshot\b/i.test(text) || /\bKimi\b/i.test(text),
  },
] as const;

const OUTPUT_SCAN_BUFFER_LIMIT = 8192;

export function inferCodingCliProviderFromOutput(text: string): CodingCliProviderId | undefined {
  const normalized = stripTerminalControlSequences(text);
  if (!normalized.trim()) return undefined;

  for (const signature of OUTPUT_SIGNATURES) {
    if (signature.test(normalized)) {
      return signature.id;
    }
  }

  return undefined;
}

export type CodingCliOutputScanner = {
  feed: (chunk: string) => CodingCliProviderId | undefined;
  reset: () => void;
};

/** Rolling buffer scanner for live terminal output chunks. */
export function createCodingCliOutputScanner(): CodingCliOutputScanner {
  let buffer = '';

  const feed = (chunk: string): CodingCliProviderId | undefined => {
    if (!chunk) return undefined;

    buffer = `${buffer}${stripTerminalControlSequences(chunk)}`.slice(-OUTPUT_SCAN_BUFFER_LIMIT);
    return inferCodingCliProviderFromOutput(buffer);
  };

  const reset = () => {
    buffer = '';
  };

  return { feed, reset };
}

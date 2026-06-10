import type { SessionCapabilities } from '../../domain/systemManager/types';

type Listener = () => void;

const capabilitiesBySessionId = new Map<string, SessionCapabilities>();
const listeners = new Set<Listener>();

export const sessionCapabilitiesStore = {
  get(sessionId: string): SessionCapabilities | undefined {
    return capabilitiesBySessionId.get(sessionId);
  },

  set(sessionId: string, capabilities: SessionCapabilities) {
    capabilitiesBySessionId.set(sessionId, capabilities);
    listeners.forEach((l) => l());
  },

  delete(sessionId: string) {
    if (capabilitiesBySessionId.delete(sessionId)) {
      listeners.forEach((l) => l());
    }
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

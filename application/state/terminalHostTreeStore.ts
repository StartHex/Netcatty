import { useCallback, useSyncExternalStore } from 'react';

import { STORAGE_KEY_TERMINAL_HOST_TREE_COLLAPSED } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

type Listener = () => void;

function readIsOpen(): boolean {
  const stored = localStorageAdapter.readString(STORAGE_KEY_TERMINAL_HOST_TREE_COLLAPSED);
  // Legacy key stores "collapsed"; open is the inverse.
  if (stored === 'true') return false;
  if (stored === 'false') return true;
  return false;
}

class TerminalHostTreeStore {
  private isOpen = readIsOpen();
  private listeners = new Set<Listener>();

  getIsOpen = () => this.isOpen;

  setIsOpen = (open: boolean) => {
    if (this.isOpen === open) return;
    this.isOpen = open;
    localStorageAdapter.writeString(
      STORAGE_KEY_TERMINAL_HOST_TREE_COLLAPSED,
      open ? 'false' : 'true',
    );
    this.listeners.forEach((listener) => listener());
  };

  toggle = () => {
    this.setIsOpen(!this.isOpen);
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const terminalHostTreeStore = new TerminalHostTreeStore();

export const useTerminalHostTreeOpen = () => {
  return useSyncExternalStore(
    terminalHostTreeStore.subscribe,
    terminalHostTreeStore.getIsOpen,
  );
};

export const useToggleTerminalHostTree = () => {
  return useCallback(() => terminalHostTreeStore.toggle(), []);
};

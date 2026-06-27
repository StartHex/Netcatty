import { useCallback, useState } from "react";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";

type RememberedBooleanSetter = (nextValue: boolean | ((currentValue: boolean) => boolean)) => void;

const canUseLocalStorage = () => typeof globalThis.localStorage !== "undefined";

export const readRememberedBoolean = (storageKey: string, fallback = false): boolean => {
  if (!canUseLocalStorage()) return fallback;
  return localStorageAdapter.readBoolean(storageKey) ?? fallback;
};

export const resolveRememberedBooleanUpdate = (
  currentValue: boolean,
  nextValue: boolean | ((currentValue: boolean) => boolean),
): boolean => (typeof nextValue === "function" ? nextValue(currentValue) : nextValue);

export const useRememberedBoolean = (storageKey: string, fallback = false) => {
  const [value, setValueRaw] = useState<boolean>(() => readRememberedBoolean(storageKey, fallback));

  const setValue = useCallback<RememberedBooleanSetter>((nextValue) => {
    setValueRaw((currentValue) => {
      const resolvedValue = resolveRememberedBooleanUpdate(currentValue, nextValue);
      if (canUseLocalStorage()) {
        localStorageAdapter.writeBoolean(storageKey, resolvedValue);
      }
      return resolvedValue;
    });
  }, [storageKey]);

  return [value, setValue] as const;
};

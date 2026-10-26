import { toast } from '../ui/toast';

export type ClipboardWriter = (text: string) => Promise<boolean>;

/** Last-resort copy for windows without the async clipboard API. */
const legacyCopy = (text: string): boolean => {
  try {
    const element = document.createElement('textarea');
    element.value = text;
    element.setAttribute('readonly', '');
    element.style.position = 'fixed';
    element.style.opacity = '0';
    document.body.appendChild(element);
    element.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(element);
    return copied;
  } catch {
    return false;
  }
};

/**
 * Copies text with the preload clipboard bridge first (works outside a secure
 * context, which is the case for the packaged `app://` renderer), then the
 * async clipboard API, then the legacy execCommand path.
 */
export async function copyTextWithFeedback(
  write: ClipboardWriter | null,
  text: string,
  okMessage: string,
  failMessage: string,
): Promise<void> {
  try {
    if (write && (await write(text))) {
      toast.success(okMessage);
      return;
    }
  } catch {
    // fall through to the browser clipboard
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMessage);
    return;
  } catch {
    if (legacyCopy(text)) {
      toast.success(okMessage);
      return;
    }
  }
  toast.error(failMessage);
}

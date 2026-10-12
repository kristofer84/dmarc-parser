import { useToast } from './useToast';

/**
 * Clipboard copy with the one piece of feedback that matters: the browser silently refuses
 * when the document is not focused or the API is unavailable, so a rejection has to be shown.
 */
export function useClipboard() {
  const toast = useToast();

  async function copy(value: string, label = 'Value'): Promise<void> {
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  }

  return { copy };
}

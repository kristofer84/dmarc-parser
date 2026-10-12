import { reactive, readonly } from 'vue';

/**
 * Transient notifications for actions whose only feedback used to be an inline "Saved" that
 * scrolled away with the thing that produced it. Field-level validation still belongs next to
 * the input; this is for outcomes of a request or a copy.
 *
 * The queue is module-level so any view can push without threading a provider through, and so
 * the host mounts once in App.vue.
 */

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

/** Errors get longer, because the message is the only place the reason exists. */
const DISMISS_MS: Record<ToastKind, number> = {
  success: 5000,
  info: 5000,
  error: 8000,
};

const toasts = reactive<Toast[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;

function dismiss(id: number): void {
  const index = toasts.findIndex((toast) => toast.id === id);
  if (index !== -1) {
    toasts.splice(index, 1);
  }

  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function push(kind: ToastKind, message: string): number {
  const id = nextId++;
  toasts.push({ id, kind, message });
  timers.set(
    id,
    setTimeout(() => dismiss(id), DISMISS_MS[kind]),
  );
  return id;
}

export function useToast() {
  return {
    toasts: readonly(toasts),
    success: (message: string) => push('success', message),
    error: (message: string) => push('error', message),
    info: (message: string) => push('info', message),
    dismiss,
  };
}

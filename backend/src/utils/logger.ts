const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatTimestamp(date: Date): string {
  const parts = TIMESTAMP_FORMATTER.formatToParts(date);
  const lookup = Object.fromEntries(parts.map(part => [part.type, part.value]));

  return `${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute}:${lookup.second}`;
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

function wrapConsoleMethod(method: ConsoleMethod) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const timestamp = formatTimestamp(new Date());
    original(`${timestamp}`, ...args);
  };
}

let loggingInitialized = false;

export function setupLogging(): void {
  if (loggingInitialized) {
    return;
  }

  (['log', 'info', 'warn', 'error', 'debug'] as ConsoleMethod[]).forEach(wrapConsoleMethod);
  loggingInitialized = true;
}

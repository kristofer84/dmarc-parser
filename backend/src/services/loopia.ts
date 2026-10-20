/**
 * Minimal Loopia XML-RPC client.
 *
 * Loopia's DNS API is XML-RPC at `https://api.loopia.se/RPCSERV` and is authenticated with a
 * username/password pair on **every call** - there is no scoped token and no bearer header.
 * That is why the credentials are resolved per request by the caller and never cached in this
 * module, and why an error message must never echo them.
 *
 * Three properties of the API shape everything above this file:
 *
 *  - **There is no update call.** Replacing a record is `removeZoneRecord` followed by
 *    `addZoneRecord`; the record id changes. The apply layer treats that as a replacement, not
 *    a patch, and never removes anything it cannot identify.
 *  - **Records live under a "subdomain".** The apex is `@`; `_dmarc`, `_smtp._tls` and
 *    `mailjet._domainkey` are subdomains that must exist before a record can be added. Nested
 *    labels are valid (the operator's own setup script uses them).
 *  - **The API is rate limited per minute** (XML-RPC Fault 429), and a burst can get the
 *    caller's IP refused at the edge for a while. Calls retry twice with a short backoff and
 *    then fail with a message that says so instead of hammering.
 *
 * The encoder/parser here is deliberately tiny: only the XML-RPC types Loopia actually uses
 * (string, int, boolean, double, array, struct, nil). No dependency is added for it.
 */

export type XmlRpcValue =
  | string
  | number
  | boolean
  | null
  | XmlRpcValue[]
  | { [key: string]: XmlRpcValue };

export interface LoopiaOptions {
  /** Both are required; the caller resolves environment first, then settings. */
  user?: string;
  password?: string;
  /** Tests point this at a local stub. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Delays between attempts after a Fault 429. The default stays well under an interactive
   * request's patience; tests pass `[]` so they do not sleep.
   */
  retryDelaysMs?: number[];
}

export interface LoopiaRecord {
  record_id: number;
  type: string;
  ttl: number;
  priority: number;
  rdata: string;
}

export class LoopiaError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, options: { statusCode?: number; code?: string } = {}) {
    super(message);
    this.name = 'LoopiaError';
    this.statusCode = options.statusCode ?? 502;
    this.code = options.code ?? 'LOOPIA_ERROR';
  }
}

const DEFAULT_BASE_URL = 'https://api.loopia.se/RPCSERV';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 6_000];

// ---------------------------------------------------------------- XML

interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * A forgiving element parser: Loopia's responses are small and well-formed, so attributes,
 * namespaces and CDATA do not occur. It keeps text separately per element, which is what the
 * value interpreter below needs.
 */
function parseXml(xml: string): XmlNode {
  const document: XmlNode = { name: '#document', children: [], text: '' };
  const stack: XmlNode[] = [document];
  let index = 0;

  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open === -1) {
      stack[stack.length - 1].text += decodeEntities(xml.slice(index));
      break;
    }
    if (open > index) {
      stack[stack.length - 1].text += decodeEntities(xml.slice(index, open));
    }
    const close = xml.indexOf('>', open);
    if (close === -1) {
      break;
    }
    const raw = xml.slice(open + 1, close);
    index = close + 1;

    // Declaration, doctype, comment.
    if (raw.startsWith('?') || raw.startsWith('!')) {
      continue;
    }
    if (raw.startsWith('/')) {
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const name = raw.replace(/\/$/, '').trim().split(/\s/)[0];
    const node: XmlNode = { name, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }

  return document;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function encodeValue(value: XmlRpcValue): string {
  if (value === null) {
    return '<value><nil/></value>';
  }
  if (typeof value === 'string') {
    return `<value><string>${escapeXml(value)}</string></value>`;
  }
  if (typeof value === 'boolean') {
    return `<value><boolean>${value ? '1' : '0'}</boolean></value>`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `<value><int>${value}</int></value>`
      : `<value><double>${value}</double></value>`;
  }
  if (Array.isArray(value)) {
    return `<value><array><data>${value.map(encodeValue).join('')}</data></array></value>`;
  }
  const members = Object.entries(value)
    .map(
      ([name, entry]) =>
        `<member><name>${escapeXml(name)}</name>${encodeValue(entry ?? null)}</member>`,
    )
    .join('');
  return `<value><struct>${members}</struct></value>`;
}

function encodeCall(method: string, params: XmlRpcValue[]): string {
  return (
    '<?xml version="1.0"?>' +
    `<methodCall><methodName>${escapeXml(method)}</methodName><params>` +
    params.map((param) => `<param>${encodeValue(param)}</param>`).join('') +
    '</params></methodCall>'
  );
}

function interpretValue(node: XmlNode): XmlRpcValue {
  const child = node.children[0];
  if (!child) {
    // An implicit string (`<value>text</value>`) is legal XML-RPC and Loopia uses it rarely.
    return node.text;
  }

  switch (child.name) {
    case 'string':
      return child.text;
    case 'int':
    case 'i4':
      return Number.parseInt(child.text.trim(), 10);
    case 'i8':
      return Number.parseInt(child.text.trim(), 10);
    case 'double':
      return Number.parseFloat(child.text.trim());
    case 'boolean':
      return child.text.trim() === '1';
    case 'nil':
      return null;
    case 'array': {
      const data = child.children.find((entry) => entry.name === 'data');
      return data
        ? data.children.filter((entry) => entry.name === 'value').map(interpretValue)
        : [];
    }
    case 'struct': {
      const result: Record<string, XmlRpcValue> = {};
      for (const member of child.children.filter((entry) => entry.name === 'member')) {
        const name = member.children.find((entry) => entry.name === 'name')?.text ?? '';
        const valueNode = member.children.find((entry) => entry.name === 'value');
        result[name] = valueNode ? interpretValue(valueNode) : null;
      }
      return result;
    }
    default:
      return child.text;
  }
}

function methodResponse(xml: string): XmlNode {
  const document = parseXml(xml);
  const response = document.children.find((node) => node.name === 'methodResponse');
  if (!response) {
    throw new LoopiaError('Loopia answered with a body that is not an XML-RPC response', {
      statusCode: 502,
      code: 'LOOPIA_ERROR',
    });
  }
  return response;
}

function asArray(value: XmlRpcValue): XmlRpcValue[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: XmlRpcValue): Record<string, XmlRpcValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, XmlRpcValue>)
    : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- client

export class LoopiaClient {
  private readonly user: string;
  private readonly password: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];

  constructor(options: LoopiaOptions) {
    const user = (options.user ?? '').trim();
    const password = options.password ?? '';
    if (!user || !password) {
      throw new LoopiaError(
        'No Loopia API credentials are configured: set LOOPIA_API_USER/LOOPIA_API_PASS or the dns settings, or publish the records by hand.',
        { statusCode: 409, code: 'LOOPIA_NOT_CONFIGURED' },
      );
    }
    this.user = user;
    this.password = password;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).trim();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  private async once(method: string, params: XmlRpcValue[]): Promise<XmlRpcValue> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            Accept: 'text/xml',
            'User-Agent': 'dmarc-parser-dns/1',
          },
          body: encodeCall(method, params),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new LoopiaError(
            `Loopia did not answer within ${Math.round(this.timeoutMs / 1000)}s`,
            { statusCode: 504, code: 'LOOPIA_TIMEOUT' },
          );
        }
        throw new LoopiaError(
          `Could not reach Loopia: ${error instanceof Error ? error.message : String(error)}`,
          { statusCode: 502, code: 'LOOPIA_UNREACHABLE' },
        );
      }

      const text = await response.text();
      if (!response.ok) {
        throw new LoopiaError(`Loopia answered HTTP ${response.status}`, {
          statusCode: 502,
          code: 'LOOPIA_ERROR',
        });
      }

      const parsed = methodResponse(text);
      const fault = parsed.children.find((node) => node.name === 'fault');
      if (fault) {
        const value = fault.children.find((node) => node.name === 'value');
        const fields = value ? asRecord(interpretValue(value)) : null;
        const faultCode = Number(fields?.faultCode ?? 0);
        const faultString = String(fields?.faultString ?? 'unknown error').trim();

        if (faultCode === 429) {
          throw new LoopiaError(
            'Loopia is rate limiting this instance (Fault 429). Wait a minute and retry; repeated bursts can get the host refused at Loopia\'s edge.',
            { statusCode: 503, code: 'LOOPIA_RATE_LIMITED' },
          );
        }
        throw new LoopiaError(`Loopia: ${faultString}`, {
          statusCode: 502,
          code: 'LOOPIA_ERROR',
        });
      }

      const paramsNode = parsed.children.find((node) => node.name === 'params');
      const firstParam = paramsNode?.children.find((node) => node.name === 'param');
      const value = firstParam?.children.find((node) => node.name === 'value');
      return value ? interpretValue(value) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A Fault 429 is retried here, not at the route: it is an API property, and the delays are
   * deliberately short. Anything else (auth, malformed rdata) is surfaced immediately.
   */
  async call(method: string, ...params: XmlRpcValue[]): Promise<XmlRpcValue> {
    const payload = [this.user, this.password, ...params];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, payload);
      } catch (error) {
        const retryable =
          error instanceof LoopiaError &&
          error.code === 'LOOPIA_RATE_LIMITED' &&
          attempt < this.retryDelaysMs.length;
        if (!retryable) {
          throw error;
        }
        await sleep(this.retryDelaysMs[attempt]);
      }
    }
  }

  async getDomains(): Promise<string[]> {
    const result = await this.call('getDomains');
    return asArray(result)
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        const record = asRecord(entry);
        return typeof record?.domain === 'string' ? record.domain : '';
      })
      .filter((domain) => domain.length > 0)
      .map((domain) => domain.trim().toLowerCase().replace(/\.$/, ''));
  }

  async getSubdomains(zone: string): Promise<string[]> {
    const result = await this.call('getSubdomains', zone);
    return asArray(result)
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ''));
  }

  async addSubdomain(zone: string, subdomain: string): Promise<void> {
    const result = await this.call('addSubdomain', zone, subdomain);
    if (result === false) {
      throw new LoopiaError(`Loopia refused to create the subdomain ${subdomain}.${zone}`, {
        statusCode: 502,
        code: 'LOOPIA_ERROR',
      });
    }
  }

  async getZoneRecords(zone: string, subdomain: string): Promise<LoopiaRecord[]> {
    const result = await this.call('getZoneRecords', zone, subdomain);
    return asArray(result)
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, XmlRpcValue> => entry !== null)
      .map((entry) => ({
        record_id: Number(entry.record_id ?? 0),
        type: String(entry.type ?? '').toUpperCase(),
        ttl: Number(entry.ttl ?? 300),
        priority: Number(entry.priority ?? 0),
        rdata: String(entry.rdata ?? ''),
      }))
      .filter((record) => Number.isFinite(record.record_id) && record.record_id > 0);
  }

  /**
   * Returns the new record id when Loopia supplies one. `false` means the API refused the
   * record (usually malformed rdata); an empty string means "written, id unknown".
   */
  async addZoneRecord(
    zone: string,
    subdomain: string,
    record: Omit<LoopiaRecord, 'record_id'>,
  ): Promise<string> {
    const result = await this.call('addZoneRecord', zone, subdomain, {
      type: record.type,
      ttl: record.ttl,
      priority: record.priority,
      rdata: record.rdata,
      record_id: 0,
    });

    if (result === false) {
      throw new LoopiaError(
        `Loopia refused the ${record.type} record at ${subdomain === '@' ? zone : `${subdomain}.${zone}`}: the API rejected its value.`,
        { statusCode: 502, code: 'LOOPIA_ERROR' },
      );
    }
    if (typeof result === 'number' && Number.isFinite(result)) {
      return String(result);
    }
    if (typeof result === 'string' && result.trim().length > 0) {
      return result.trim();
    }
    return '';
  }

  async removeZoneRecord(zone: string, subdomain: string, recordId: number): Promise<void> {
    const result = await this.call('removeZoneRecord', zone, subdomain, recordId);
    if (result === false) {
      throw new LoopiaError(`Loopia refused to remove record ${recordId}.`, {
        statusCode: 502,
        code: 'LOOPIA_ERROR',
      });
    }
  }
}

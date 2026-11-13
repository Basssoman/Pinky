// Minimal 1Click API client (https://1click.chaindefuser.com, OpenAPI v0).
// Auth: `X-API-Key` header. The key is never logged or echoed in errors.

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number | string;
  priceUpdatedAt?: string;
  contractAddress?: string;
}

export interface QuoteRequest {
  dry: boolean;
  swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
  deadline: string;
  customRecipientMsg?: string;
  confidentiality?: 'public' | 'basic' | 'advanced';
  quoteWaitingTimeMs?: number;
  referral?: string;
  depositMode?: 'SIMPLE' | 'MEMO';
}

export interface QuoteResponse {
  correlationId?: string;
  timestamp?: string;
  signature?: string;
  quoteRequest?: Record<string, unknown>;
  quote: {
    depositAddress?: string;
    depositMemo?: string | null;
    amountIn: string;
    amountInFormatted: string;
    amountInUsd?: string;
    minAmountIn?: string;
    maxAmountIn?: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd?: string;
    minAmountOut?: string;
    deadline?: string;
    timeWhenInactive?: string;
    timeEstimate?: number;
  };
}

export type StatusResponse = Record<string, unknown> & { status?: string };

/** Error from 1Click: `status` is the upstream HTTP status (0 = network). */
export class OneClickError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OneClickError';
    this.status = status;
  }
}

export interface OneClick {
  getTokens(): Promise<OneClickToken[]>;
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  status(depositAddress: string, depositMemo?: string | null): Promise<StatusResponse>;
}

export interface OneClickOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OneClickClient implements OneClick {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OneClickOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? '';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  getTokens(): Promise<OneClickToken[]> {
    return this.request<OneClickToken[]>('GET', '/v0/tokens');
  }

  quote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.request<QuoteResponse>('POST', '/v0/quote', req);
  }

  status(depositAddress: string, depositMemo?: string | null): Promise<StatusResponse> {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo) q.set('depositMemo', depositMemo);
    return this.request<StatusResponse>('GET', `/v0/status?${q.toString()}`);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new OneClickError(0, `1Click unreachable: ${(e as Error).name}`);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const msg =
        json && typeof json === 'object' && 'message' in json
          ? String((json as { message: unknown }).message)
          : `HTTP ${res.status}`;
      throw new OneClickError(res.status, `1Click: ${msg}`.slice(0, 500));
    }
    return json as T;
  }
}

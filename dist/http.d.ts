import type { ButterFetch } from './types.js';
export interface ButterHttpClientOptions {
    routerBaseUrl: string;
    tokenBaseUrl: string;
    appBaseUrl: string;
    fetch: ButterFetch;
    apiKeyId?: string | undefined;
    apiSecret?: string | undefined;
    authMode: 'required' | 'optional';
}
export declare class ButterHttpClient {
    private readonly options;
    constructor(options: ButterHttpClientOptions);
    router<T>(path: string, params?: Record<string, unknown>): Promise<T>;
    token<T>(path: string, params?: Record<string, unknown>): Promise<T>;
    app<T>(path: string, params?: Record<string, unknown>): Promise<T>;
    private requestJson;
    private headers;
}
//# sourceMappingURL=http.d.ts.map
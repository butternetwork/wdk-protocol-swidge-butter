import type { ButterFetch } from './types.js';
export interface ButterHttpClientOptions {
    routerBaseUrl: string;
    tokenBaseUrl: string;
    appBaseUrl: string;
    fetch: ButterFetch;
    requestTimeoutMs: number;
    apiKeyId?: string | undefined;
    apiSecret?: string | undefined;
    authMode: 'required' | 'optional';
}
export declare class ButterHttpClient {
    private readonly options;
    /**
     * Creates a butter http client instance.
     *
     * @param {ButterHttpClientOptions} options - Base URLs, integration metadata, credentials, fetch, and timeout configuration.
     * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
     */
    constructor(options: ButterHttpClientOptions);
    /**
     * Requests and unwraps data from the Butter Router API.
     *
     * @param {string} path - The endpoint path relative to the configured Butter base URL.
     * @param {Record<string, unknown>} [params] - Query parameters appended to the Router request (default: empty object).
     * @returns {Promise<T>} The unwrapped Router response data.
     * @throws {ButterNoRouteError} If Butter provides no liquid route for the request.
     * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
     */
    router<T>(path: string, params?: Record<string, unknown>): Promise<T>;
    /**
     * Requests and unwraps data from the Butter token API.
     *
     * @param {string} path - The endpoint path relative to the configured Butter base URL.
     * @param {Record<string, unknown>} [params] - Query parameters appended to the token request (default: empty object).
     * @returns {Promise<T>} The unwrapped token API response data.
     * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
     */
    token<T>(path: string, params?: Record<string, unknown>): Promise<T>;
    /**
     * Requests and unwraps data from the Butter application API.
     *
     * @param {string} path - The endpoint path relative to the configured Butter base URL.
     * @param {Record<string, unknown>} [params] - Query parameters appended to the application request (default: empty object).
     * @returns {Promise<T>} The unwrapped application API response data.
     * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
     */
    app<T>(path: string, params?: Record<string, unknown>): Promise<T>;
    /** @private */
    private requestJson;
    /** @private */
    private headers;
}
//# sourceMappingURL=http.d.ts.map
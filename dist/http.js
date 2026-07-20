import { ButterApiError, ButterConfigurationError } from './errors.js';
export class ButterHttpClient {
    options;
    constructor(options) {
        this.options = options;
        if (options.apiSecret) {
            assertHttpsBaseUrl(options.routerBaseUrl);
            assertHttpsBaseUrl(options.tokenBaseUrl);
            assertHttpsBaseUrl(options.appBaseUrl);
        }
        if (options.authMode === 'required' && (!options.apiKeyId || !options.apiSecret)) {
            throw new ButterConfigurationError('Butter apiKeyId and apiSecret are required when authMode is required');
        }
    }
    async router(path, params = {}) {
        const body = await this.requestJson(this.options.routerBaseUrl, path, params);
        const envelope = body;
        if (!isRecord(body) || envelope.errno !== 0) {
            throw new ButterApiError(messageOf(body) ?? 'Butter router request failed', body);
        }
        if (!Object.hasOwn(envelope, 'data'))
            throw new ButterApiError('Butter router response is missing data', envelope);
        return envelope.data;
    }
    async token(path, params = {}) {
        const body = await this.requestJson(this.options.tokenBaseUrl, path, params);
        const envelope = body;
        if (!isRecord(body) || envelope.code !== 200) {
            throw new ButterApiError(messageOf(body) ?? 'Butter token request failed', body);
        }
        if (!Object.hasOwn(envelope, 'data'))
            throw new ButterApiError('Butter token response is missing data', envelope);
        return envelope.data;
    }
    async app(path, params = {}) {
        const body = await this.requestJson(this.options.appBaseUrl, path, params);
        const envelope = body;
        if (!isRecord(body) || envelope.code !== 200) {
            throw new ButterApiError(messageOf(body) ?? 'Butter app request failed', body);
        }
        if (!Object.hasOwn(envelope, 'data'))
            throw new ButterApiError('Butter app response is missing data', envelope);
        return envelope.data;
    }
    async requestJson(baseUrl, path, params) {
        const url = new URL(path, ensureTrailingSlash(baseUrl));
        for (const [key, value] of Object.entries(params)) {
            if (value != null)
                url.searchParams.set(key, String(value));
        }
        const response = await this.options.fetch(url.toString(), {
            method: 'GET',
            headers: this.headers()
        });
        const body = await response.json();
        if (!response.ok) {
            throw new ButterApiError(`Butter HTTP request failed with ${response.status}`, body);
        }
        return body;
    }
    headers() {
        const headers = {};
        if (this.options.apiKeyId)
            headers['x-api-key-id'] = this.options.apiKeyId;
        if (this.options.apiSecret)
            headers.Authorization = `Bearer ${this.options.apiSecret}`;
        return headers;
    }
}
function ensureTrailingSlash(url) {
    return url.endsWith('/') ? url : `${url}/`;
}
function assertHttpsBaseUrl(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
        throw new ButterConfigurationError('Butter API credentials require HTTPS base URLs', { url });
    }
}
function isRecord(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}
function messageOf(value) {
    if (!isRecord(value) || typeof value.message !== 'string')
        return undefined;
    return value.message;
}
//# sourceMappingURL=http.js.map
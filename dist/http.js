// Copyright 2026 Butter Network
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import { ButterApiError, ButterConfigurationError, ButterNoRouteError } from './errors.js';
/** Butter's in-band "No Route Found" code, returned with HTTP 200. */
const BUTTER_NO_ROUTE_ERRNO = 2003;
export class ButterHttpClient {
    options;
    constructor(options) {
        this.options = options;
        if (Boolean(options.apiKeyId) !== Boolean(options.apiSecret)) {
            throw new ButterConfigurationError('Butter apiKeyId and apiSecret must be provided together');
        }
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
            // Butter signals "no route" in-band, with HTTP 200 and errno 2003. Typing it
            // separately lets a caller tell an unroutable pair (normal, retryable) from a
            // bad parameter or a rejected key.
            if (envelope.errno === BUTTER_NO_ROUTE_ERRNO) {
                throw new ButterNoRouteError(messageOf(body) ?? 'Butter found no route for this request', body);
            }
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
        const controller = new AbortController();
        let phase = 'fetch';
        let timer;
        const timedOut = () => new ButterApiError('Butter HTTP request timed out', {
            url: url.toString(),
            phase,
            timeoutMs: this.options.requestTimeoutMs
        });
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(timedOut());
            }, this.options.requestTimeoutMs);
        });
        const request = (async () => {
            let response;
            try {
                response = await this.options.fetch(url.toString(), {
                    method: 'GET',
                    headers: this.headers(),
                    signal: controller.signal
                });
            }
            catch (cause) {
                if (controller.signal.aborted)
                    throw timedOut();
                throw cause;
            }
            // Check the status BEFORE parsing. A failing gateway commonly returns HTML, so
            // parsing first threw a raw SyntaxError and lost both the status code and this
            // package's error typing on the most common failure mode there is.
            if (!response.ok) {
                phase = 'error-body';
                const body = await readErrorBody(response);
                if (controller.signal.aborted)
                    throw timedOut();
                throw new ButterApiError(`Butter HTTP request failed with ${response.status}`, {
                    status: response.status,
                    body
                });
            }
            phase = 'json-body';
            try {
                return await response.json();
            }
            catch (cause) {
                if (controller.signal.aborted)
                    throw timedOut();
                throw new ButterApiError('Butter response body is not valid JSON', { status: response.status, cause });
            }
        })();
        try {
            return await Promise.race([request, timeout]);
        }
        finally {
            if (timer != null)
                clearTimeout(timer);
        }
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
/** Caps a captured error body so a whole HTML page never lands in an error object. */
const MAX_ERROR_BODY_CHARS = 512;
/**
 * Reads a failed response's body as text, best effort.
 *
 * Deliberately swallows its own failures: the status code is the valuable part of
 * a non-2xx response and must not be lost to a second error raised while trying
 * to describe the first. Absent when the injected fetch supplies no `text()`.
 */
async function readErrorBody(response) {
    if (typeof response.text !== 'function')
        return undefined;
    try {
        const text = await response.text();
        if (!text)
            return undefined;
        return text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…` : text;
    }
    catch {
        return undefined;
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
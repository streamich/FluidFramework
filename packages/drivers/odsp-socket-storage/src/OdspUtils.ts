/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { isOnline, NetworkError, OnlineStatus } from "@microsoft/fluid-core-utils";
import { default as fetch, RequestInfo as FetchRequestInfo, RequestInit as FetchRequestInit } from "node-fetch";
import * as sha from "sha.js";
import { IOdspSocketError } from "./contracts";
import { debug } from "./debug";

/**
 * Throws network error - an object with a bunch of network related properties
 */
export function throwOdspNetworkError(
        errorMessage: string,
        statusCode: number,
        canRetry: boolean,
        response?: Response,
        online?: string) {
    let message = errorMessage;
    if (response) {
        message = `${message}, msg = ${response.statusText}, type = ${response.type}`;
    }
    throw new OdspNetworkError(
        message,
        statusCode,
        canRetry,
        undefined,
        response && response.headers && response.headers.get("sprequestguid"),
        online,
    );
}

export class OdspNetworkError extends NetworkError {
    constructor(
        errorMessage: string,
        readonly statusCode: number | undefined,
        readonly canRetry: boolean,
        readonly retryAfterSeconds?: number,
        readonly sprequestguid?: string | null,
        readonly online = OnlineStatus[isOnline()]) {
        super(errorMessage, statusCode, canRetry, retryAfterSeconds, online);
    }
}

/**
 * Returns network error based on error object from ODSP socket (IOdspSocketError)
 */
export function errorObjectFromOdspError(socketError: IOdspSocketError) {
    return new OdspNetworkError(
        socketError.message,
        socketError.code,
        socketErrorRetryFilter(socketError.code),
        socketError.retryAfter,
    );
}

/**
 * returns true when the request should/can be retried
 */
export type RetryFilter = (code: number) => boolean;

export function noRetry(): RetryFilter {
    return () => false;
}

/**
 * Creates a filter that will allow retries for the whitelisted status codes
 * @param retriableCodes - Cannot be null/undefined
 */
export function allowList(retriableCodes: number[]): RetryFilter {
    return (code: number) => retriableCodes.includes(code);
}

export function blockList(nonRetriableCodes: number[]): RetryFilter {
    return (code: number) => !nonRetriableCodes.includes(code);
}

// Non-retryable errors on joinSession / getLatest / get ops / storage requests (blobs) / summary paths.
// Basically all SPO communication.
// PUSH (delta oedering service) errors use socketErrorRetryFilter below.
// 401, 403: fatal errors, but driver will retry once with new token (see usage of getWithRetryForTokenRefresh)
export const defaultRetryFilter = blockList([400, 401, 403, 404]);

//
// Socket error filter for socket errors
//
// These errors are retryable in a sense that we rely on fetching new joinSession and it failing if needed
// (see defaultRetryFilter list above), otherwise continuing with new connection (to potentially different server)
//    400:
//       Invalid tenant or document id. The WebSocket is connected to a different document
//       Document is full (with retryAfter)
//    404: Invalid document. The document \"local/w1-645289b2-568e-4097-9ef8-3253a04d6209\" does not exist
// Not-retryable:
//    401, 403: These are fatal, but runtime will retry once with new token (see usage of getWithRetryForTokenRefresh)
//    406: Unsupported client protocol
//
export const socketErrorRetryFilter = blockList([401, 403, 406]);

export interface IOdspResponse<T> {
    content: T;
    headers: Map<string, string>;
}

export function getHashedDocumentId(driveId: string, itemId: string): string {
    return encodeURIComponent(new sha.sha256().update(`${driveId}_${itemId}`).digest("base64"));
}

export async function getWithRetryForTokenRefresh<T>(get: (refresh: boolean) => Promise<T>) {
    return get(false).catch(async (e) => {
        // if the error is 401 or 403 refresh the token and try once more.
        if (e.statusCode === 401 || e.statusCode === 403) {
            return get(true);
        }

        // All code paths (deltas, blobs, trees) already throw exceptions.
        // Throwing is better than returning null as most code paths do not return nullable-objects,
        // and error reporting is better (for example, getDeltas() will log error to telemetry)
        // getTree() path is the only potential exception where returning null might result in
        // document being opened, though there maybe really bad user experience (consuming thousands of ops)
        throw e;
    });
}

/**
 * A utility function to do fetch with support for retries
 * @param url - fetch requestInfo, can be a string
 * @param requestInit - fetch requestInit
 * @param retryPolicy - how to do retries
 */
export function fetchHelper(
    requestInfo: RequestInfo,
    requestInit: RequestInit | undefined,
    retryFilter: RetryFilter = defaultRetryFilter,
): Promise<any> {
    // node-fetch and dom has conflicting typing, force them to work by casting for now
    return fetch(requestInfo as FetchRequestInfo, requestInit as FetchRequestInit).then(async (fetchResponse) => {
        const response = fetchResponse as any as Response;
        // Let's assume we can retry.
        if (!response) {
            throwOdspNetworkError(`No response from the server`, 400, true, response);
        }
        if (!response.ok || response.status < 200 || response.status >= 300) {
            throwOdspNetworkError(`Error ${response.status} from the server`, response.status, retryFilter(response.status), response);
        }

        // .json() can fail and message (that goes into telemetry) would container full request URI, including tokens...
        // It tails for me with "Unexpected end of JSON input" quite often - an attempt to download big file (many ops) almost
        // always ends up with this error - I'd guess 1% of op request end up here...
        // It always succeeds on retry.
        try {
            const res = {
                headers: response.headers,
                content: await response.json() as any,
            };
            return res;
        } catch (e) {
            throwOdspNetworkError(`Error while parsing fetch response`, 400, true, response);
        }
    },
    (error) => {
        // While we do not know for sure whether computer is offline, this error is not actionable and
        // is pretty good indicator we are offline. Treating it as offline scenario will make it
        // easier to see other errors in telemetry.
        let online: string | undefined;
        if (error && typeof error === "object" && error.message === "TypeError: Failed to fetch") {
            online = OnlineStatus[OnlineStatus.Offline];
        }
        throwOdspNetworkError(
            `Fetch error: ${error}`,
            709,
            true, // canRetry
            undefined, // response
            online,
        );
    });
}

/**
 * Tests if localStorage is usable.
 * Should we move this outside to a library?
 */
export function isLocalStorageAvailable(): boolean {
    const localStorageTestKey = "LocalStorageTestKey";
    try {
        localStorage.setItem(localStorageTestKey, "v");
        localStorage.removeItem(localStorageTestKey);
        return true;
    } catch (e) {
        debug(`LocalStorage not available due to ${e}`);
        return false;
    }
}

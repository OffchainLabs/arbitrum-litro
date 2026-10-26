// @ts-check

/**
 * @typedef {import("./types.js").FastFeedMessage} FastFeedMessage
 * @typedef {new (url: string, options: { headers: Record<string, string> }) => WebSocket} HeaderWebSocket
 */

/**
 * Open a WebSocket to a Fast Feed as the public "Use the Fast Feed" guide's client does: the API
 * key as a Bearer header on the upgrade request, frames read as binary. Node's WebSocket accepts
 * request headers through an options object that the DOM typings do not declare, hence the cast.
 *
 * @param {string} url
 * @param {string} [apiKey] omit for a feed that does not check keys
 * @returns {WebSocket}
 */
export function openFastFeed(url, apiKey) {
	const Socket = /** @type {HeaderWebSocket} */ (/** @type {unknown} */ (WebSocket));
	const socket = new Socket(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
	socket.binaryType = "arraybuffer";
	return socket;
}

/**
 * @param {string | ArrayBuffer} data a message event's data
 * @returns {FastFeedMessage}
 */
export function decodeFastFeedMessage(data) {
	return JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
}

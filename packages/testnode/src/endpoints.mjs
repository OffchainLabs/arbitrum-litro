// @ts-check

/**
 * What each port inside the testnode container serves. Host ports vary by variant and feature, so
 * a URL is always built from the container port plus the host port it is published on.
 */
export const CONTAINER_ENDPOINTS = {
	8545: { name: "l1", scheme: "http", path: "" },
	8547: { name: "l2", scheme: "http", path: "" },
	8549: { name: "l3", scheme: "http", path: "" },
	9642: { name: "sequencerFeed", scheme: "ws", path: "/feed" },
	9646: { name: "fastFeed", scheme: "ws", path: "/" },
};

/** @typedef {keyof typeof CONTAINER_ENDPOINTS} ContainerPort */

/**
 * @param {number} port
 * @returns {port is ContainerPort}
 */
export function isContainerEndpoint(port) {
	return Object.hasOwn(CONTAINER_ENDPOINTS, port);
}

/**
 * @param {ContainerPort} containerPort
 * @param {number | string} hostPort
 * @param {string} [host]
 */
export function endpointUrl(containerPort, hostPort, host = "127.0.0.1") {
	const { scheme, path } = CONTAINER_ENDPOINTS[containerPort];
	return `${scheme}://${host}:${hostPort}${path}`;
}

/**
 * @file Declares ambient fetch-related types to support Node.js streaming requests.
 */

declare global {
	interface RequestInit {
		/**
		 * Enables streaming request bodies required by Node.js when piping HTTP payloads.
		 */
		duplex?: "half";
	}
}

export {};

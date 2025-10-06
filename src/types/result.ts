/**
 * @file Defines a small Result algebraic data type to model success and failure branches explicitly.
 */

/**
 * Represents the outcome of an operation without relying on exceptions.
 */
export type Result<TValue, TError> =
	| { ok: true; value: TValue }
	| { ok: false; error: TError };

/**
 * Creates a success result for fluent functional composition.
 */
export const success = <TValue>(value: TValue): Result<TValue, never> => ({
	ok: true,
	value,
});

/**
 * Creates a failure result for explicit error propagation.
 */
export const failure = <TError>(error: TError): Result<never, TError> => ({
	ok: false,
	error,
});

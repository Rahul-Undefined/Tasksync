/** An error whose code and message are safe to return to clients. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'bad_request', message, details);
export const unauthorized = (code = 'unauthorized', message = 'Sign in required') => new ApiError(401, code, message);
export const forbidden = (code = 'forbidden', message = 'You do not have permission to do that') =>
  new ApiError(403, code, message);
/** Used for resources the caller may not see, so their existence is not revealed. */
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);

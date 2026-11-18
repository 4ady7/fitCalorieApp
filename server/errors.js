export class HttpError extends Error {
  constructor(status, message, code = 'BAD_REQUEST', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.productName = extra.productName;
  }
}

export function asHttpError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(400, error.message || 'The request could not be completed.');
}

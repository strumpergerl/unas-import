// backend/src/shared/errors.js
class AppError extends Error {
  constructor(message, code = 'APP_ERROR', extra = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.extra = extra;
  }
}
class NotFoundError extends AppError {
  constructor(message, extra = {}) {
    super(message, 'NOT_FOUND', extra);
    this.name = 'NotFoundError';
  }
}
class BadRequestError extends AppError {
  constructor(message, extra = {}) {
    super(message, 'BAD_REQUEST', extra);
    this.name = 'BadRequestError';
  }
}
module.exports = { AppError, NotFoundError, BadRequestError };

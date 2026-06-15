import { describe, test, expect } from 'bun:test';
import {
  parseApiErrorInfo,
  isContextOverflowError,
  isRateLimitError,
  isBillingError,
  isAuthError,
  isTimeoutError,
  isOverloadedError,
  classifyError,
  isNonRetryableError,
  formatUserFacingError,
} from './errors.js';

// ---------------------------------------------------------------------------
// parseApiErrorInfo
// ---------------------------------------------------------------------------

describe('parseApiErrorInfo', () => {
  test('returns null for empty or missing input', () => {
    expect(parseApiErrorInfo()).toBeNull();
    expect(parseApiErrorInfo('')).toBeNull();
    expect(parseApiErrorInfo('   ')).toBeNull();
  });

  test('returns null for non-JSON payloads', () => {
    expect(parseApiErrorInfo('something went wrong')).toBeNull();
  });

  test('extracts fields from a nested error object', () => {
    const raw = '{"error":{"type":"invalid_request_error","message":"bad input","code":"x1"}}';
    expect(parseApiErrorInfo(raw)).toEqual({
      httpCode: undefined,
      type: 'invalid_request_error',
      code: 'x1',
      message: 'bad input',
      requestId: undefined,
    });
  });

  test('strips an HTTP status prefix into httpCode', () => {
    const info = parseApiErrorInfo('429 {"error":{"message":"slow down"}}');
    expect(info?.httpCode).toBe(429);
    expect(info?.message).toBe('slow down');
  });

  test('strips a bracketed provider prefix before parsing', () => {
    const info = parseApiErrorInfo('[Anthropic] {"message":"hi"}');
    expect(info?.message).toBe('hi');
  });
});

// ---------------------------------------------------------------------------
// individual classifiers
// ---------------------------------------------------------------------------

describe('error classifiers', () => {
  test('isContextOverflowError matches context-length messages', () => {
    expect(isContextOverflowError("this model's maximum context length")).toBe(true);
    expect(isContextOverflowError('all good')).toBe(false);
    expect(isContextOverflowError()).toBe(false);
  });

  test('isContextOverflowError excludes tokens-per-minute (tpm) errors', () => {
    expect(isContextOverflowError('tpm limit reached')).toBe(false);
  });

  test('isRateLimitError matches 429 and rate-limit phrasing', () => {
    expect(isRateLimitError('Error 429: too many requests')).toBe(true);
    expect(isRateLimitError('tpm limit reached')).toBe(true);
    expect(isRateLimitError('nope')).toBe(false);
  });

  test('isBillingError matches payment/credit phrasing', () => {
    expect(isBillingError('Payment Required')).toBe(true);
    expect(isBillingError('insufficient credits')).toBe(true);
    expect(isBillingError('nope')).toBe(false);
  });

  test('isAuthError matches invalid-key and 401 phrasing', () => {
    expect(isAuthError('Invalid API key provided')).toBe(true);
    expect(isAuthError('401 Unauthorized')).toBe(true);
    expect(isAuthError('nope')).toBe(false);
  });

  test('isTimeoutError matches timeout phrasing', () => {
    expect(isTimeoutError('the request timed out')).toBe(true);
    expect(isTimeoutError('nope')).toBe(false);
  });

  test('isOverloadedError matches overloaded phrasing', () => {
    expect(isOverloadedError('overloaded_error')).toBe(true);
    expect(isOverloadedError('service unavailable')).toBe(true);
    expect(isOverloadedError('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyError / isNonRetryableError
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  test('returns "unknown" for missing or unrecognized input', () => {
    expect(classifyError()).toBe('unknown');
    expect(classifyError('')).toBe('unknown');
    expect(classifyError('totally unrecognized error')).toBe('unknown');
  });

  test('classifies by error type', () => {
    expect(classifyError('maximum context length exceeded')).toBe('context_overflow');
    expect(classifyError('rate limit exceeded')).toBe('rate_limit');
    expect(classifyError('payment required')).toBe('billing');
    expect(classifyError('invalid api key')).toBe('auth');
    expect(classifyError('deadline exceeded')).toBe('timeout');
    expect(classifyError('the service is overloaded')).toBe('overloaded');
  });

  test('treats tpm as rate_limit, not context_overflow', () => {
    expect(classifyError('tokens per minute exceeded')).toBe('rate_limit');
  });
});

describe('isNonRetryableError', () => {
  test('context overflow, billing, and auth are non-retryable', () => {
    expect(isNonRetryableError('maximum context length')).toBe(true);
    expect(isNonRetryableError('insufficient credits')).toBe(true);
    expect(isNonRetryableError('invalid api key')).toBe(true);
  });

  test('rate limit and timeout are retryable', () => {
    expect(isNonRetryableError('rate limit exceeded')).toBe(false);
    expect(isNonRetryableError('request timed out')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatUserFacingError
// ---------------------------------------------------------------------------

describe('formatUserFacingError', () => {
  test('returns a generic message for blank input', () => {
    expect(formatUserFacingError('   ')).toBe('LLM request failed with an unknown error.');
  });

  test('returns a typed, human-readable message per category', () => {
    expect(formatUserFacingError('maximum context length')).toContain('Context overflow');
    expect(formatUserFacingError('invalid api key')).toContain('API key is invalid');
    expect(formatUserFacingError('request timed out')).toContain('timed out');
  });

  test('includes the provider label when given', () => {
    expect(formatUserFacingError('rate limit', 'OpenAI')).toBe(
      'OpenAI API rate limit reached. Please wait a moment and try again.'
    );
  });

  test('falls back to parsed error detail for unknown types', () => {
    const out = formatUserFacingError('{"message":"boom","type":"server_error"}');
    expect(out).toBe('LLM error (server_error): boom');
  });

  test('truncates very long unstructured errors to 300 chars + ellipsis', () => {
    const out = formatUserFacingError('z'.repeat(400));
    expect(out).toBe('z'.repeat(300) + '...');
  });
});

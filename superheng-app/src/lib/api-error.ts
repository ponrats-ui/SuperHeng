/**
 * Request failures, in the reader's language.
 *
 * `ApiError.message` is an English sentence written for whoever debugs the client
 * ("The prediction service at http://127.0.0.1:8000 did not answer within 10s.").
 * Rendering it put English inside a Thai screen, which is the one thing this app's
 * locale system exists to prevent. The failure is classified here instead, and the
 * screen translates the key it gets back.
 *
 * The HTTP status travels with the key rather than being folded into the sentence:
 * it is the detail an operator needs and the only detail no dictionary can change.
 * It renders as an em dash when the failure never reached the server at all.
 */

import { isApiError } from '@/lib/api';
import type { TranslationKey } from '@/lib/i18n';

export type ApiErrorText = {
  key: TranslationKey;
  params: { status: string };
};

/**
 * Classifies a caught value. Anything that is not an `ApiError` — a thrown string, a
 * `TypeError` from inside a parser — is reported as an unexpected failure rather than
 * guessed at: the reader cannot act on a stack trace, and inventing a specific cause
 * for an unclassified error is how a UI ends up blaming the network for a bug.
 */
export function apiErrorText(error: unknown): ApiErrorText {
  const status = isApiError(error) && error.status !== undefined ? String(error.status) : '—';

  if (!isApiError(error)) return { key: 'apiError.unexpected', params: { status } };
  if (error.kind === 'network') return { key: 'apiError.network', params: { status } };
  if (error.kind === 'timeout') return { key: 'apiError.timeout', params: { status } };
  if (error.kind === 'malformed') return { key: 'apiError.malformed', params: { status } };

  if (error.status === 401) return { key: 'apiError.unauthorized', params: { status } };
  if (error.status === 402 || error.status === 403) {
    return { key: 'apiError.forbidden', params: { status } };
  }
  if (error.status !== undefined && error.status >= 500) {
    return { key: 'apiError.server', params: { status } };
  }
  return { key: 'apiError.unexpected', params: { status } };
}

// Canonical error discriminant mirrored from `lectorbit_core::LectorError`.
// Keep this in sync with `crates/lectorbit_core/src/error.rs`.

export type LectorErrorKind =
  | 'permission_denied'
  | 'not_found'
  | 'invalid'
  | 'io'
  | 'database'
  | 'sidecar'
  | 'internal';

export interface LectorErrorPayload {
  kind: LectorErrorKind;
  // Rust serializes the inner message via the Display impl through thiserror.
  // We do not parse it structurally; just surface it.
  message?: string;
}

export class LectorError extends Error {
  readonly kind: LectorErrorKind;
  constructor(payload: LectorErrorPayload) {
    super(payload.message ?? payload.kind);
    this.name = 'LectorError';
    this.kind = payload.kind;
  }
}
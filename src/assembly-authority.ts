import type { D1DatabaseLike } from './sqlite-types.js';
import { InvalidAuthorizationError } from './errors.js';
import { canonicalizeTaprootBaseIri } from './migrations.js';

/**
 * Process-local assembly authority. The public shape is intentionally
 * non-authoritative: object identity in the private WeakMap is the capability.
 */
export interface TaprootHostWriteCapability {
  readonly kind: 'taproot-host-write-v1';
}

interface HostWriteCapabilityBinding {
  db: D1DatabaseLike;
  baseIri: string;
}

const hostWriteCapabilities = new WeakMap<object, HostWriteCapabilityBinding>();

export function createTaprootHostWriteCapability(
  db: D1DatabaseLike,
  options: { baseIri: string },
  key: CryptoKey,
): TaprootHostWriteCapability {
  const algorithm = key.algorithm as KeyAlgorithm & {
    hash?: KeyAlgorithm;
  };
  if (
    key.type !== 'secret' ||
    key.extractable ||
    algorithm.name !== 'HMAC' ||
    algorithm.hash?.name !== 'SHA-256' ||
    !key.usages.includes('sign')
  )
    throw new InvalidAuthorizationError(
      'write capability key must be non-extractable HMAC-SHA-256 with sign usage',
    );
  const capability = Object.freeze({ kind: 'taproot-host-write-v1' as const });
  hostWriteCapabilities.set(capability, {
    db,
    baseIri: canonicalizeTaprootBaseIri(options.baseIri),
  });
  return capability;
}

/** @internal */
export function assertTaprootHostWriteCapabilityInternal(
  db: D1DatabaseLike,
  options: { baseIri: string },
  capability: TaprootHostWriteCapability,
): HostWriteCapabilityBinding {
  const binding = hostWriteCapabilities.get(capability);
  if (
    !binding ||
    binding.db !== db ||
    binding.baseIri !== canonicalizeTaprootBaseIri(options.baseIri)
  )
    throw new InvalidAuthorizationError(
      'Taproot host authority is invalid for this connection',
    );
  return binding;
}

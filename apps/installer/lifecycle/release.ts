import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';

import { PinnedR2ReleaseBundleProvider, type R2ReleaseReadBucket, type R2ReleaseReadObject } from '../src/r2-release-provider';
import type { VerifiedReleaseBundle } from '../src/release';
import { buildPublicUpdateChannel } from '../src/update-channel';
import { parseVerifiedReleaseBundle, type ParsedVerifiedReleaseBundle } from '../src/verified-release-bundle';
import { outsideRepository, readReleasePin, type ReleasePin } from '../../../tools/lifecycle-job.mjs';

/**
 * A signed release read from the signer's local publish directory exactly the
 * way the hosted runtime reads R2: the same envelope, the same object set, the
 * same signature verification. No R2 bucket and no hosted control plane are
 * involved; the runner never contacts Ankka-hosted services.
 */
const objectPlanSchema = v.looseObject({
  objects: v.array(v.looseObject({ key: v.string(), contentType: v.string(), byteSize: v.number() })),
});

export interface LoadedRelease {
  readonly pin: ReleasePin;
  readonly publishDirectory: string;
  readonly bundle: VerifiedReleaseBundle;
  readonly parsed: ParsedVerifiedReleaseBundle;
  /** Exact bytes of the final runtime module, for the converger's upload and the in-process payload. */
  readonly finalRuntimeSource: string;
  readonly payloadUrl: string;
}

function localBucket(publishDirectory: string): R2ReleaseReadBucket {
  const plan = v.parse(objectPlanSchema, JSON.parse(readFileSync(join(publishDirectory, 'r2-object-plan.json'), 'utf8')));
  const byKey = new Map(plan.objects.map((object) => [object.key, object]));
  return {
    async get(key: string): Promise<R2ReleaseReadObject | null> {
      const object = byKey.get(key);
      if (!object) return null;
      const bytes = readFileSync(join(publishDirectory, 'objects', key));
      return {
        key,
        size: bytes.byteLength,
        httpMetadata: { contentType: object.contentType },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
    async list({ prefix }) {
      return {
        objects: plan.objects.filter((object) => object.key.startsWith(prefix)).map((object) => ({ key: object.key, size: object.byteSize })),
        truncated: false,
      };
    },
  };
}

export async function loadLocalRelease(reference: { readonly publishDirectory: string; readonly pin: string }): Promise<LoadedRelease> {
  const publishDirectory = await outsideRepository(reference.publishDirectory, 'release_directory_required');
  const pin = await readReleasePin(reference.pin);
  const bundle = await PinnedR2ReleaseBundleProvider.fromCandidate(pin).loadVerifiedReleaseBundle(localBucket(publishDirectory));
  const parsed = parseVerifiedReleaseBundle(bundle);
  const workerKey = `ankka-mcp-gateway/releases/${pin.channel}/${pin.release}/payload/worker/index.js`;
  const finalRuntimeSource = readFileSync(join(publishDirectory, 'objects', workerKey), 'utf8');
  return Object.freeze({
    pin, publishDirectory, bundle, parsed, finalRuntimeSource,
    payloadUrl: pathToFileURL(join(publishDirectory, 'objects', workerKey)).href,
  });
}

const EXACT_RELEASE_ROUTE = /^\/api\/releases\/(canary|stable)\/by-id\/(gateway-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/([a-f0-9]{64})(?:\/files\/(payload\/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}))?$/u;

/**
 * Serves the exact-release routes of the control plane from the loaded
 * releases. The updater verifies the signed envelope and every payload digest
 * itself, so the origin of the bytes changes nothing about what it accepts.
 * Any other request to the control-plane origin is refused.
 */
export function localControlPlane(releases: readonly LoadedRelease[]): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    const served = releases.find((release) => release.bundle.manifest.controlPlaneOrigin === url.origin);
    if (served === undefined) return null;
    const match = EXACT_RELEASE_ROUTE.exec(url.pathname);
    const release = match === null ? undefined : releases.find((candidate) =>
      candidate.bundle.channel === match[1] && candidate.bundle.manifest.release === match[2] &&
      candidate.bundle.manifest.artifact.treeSha256 === match[3] && candidate.bundle.manifest.controlPlaneOrigin === url.origin);
    if (request.method !== 'GET' || match === null || release === undefined) {
      return new Response(JSON.stringify({ schemaVersion: 1, error: 'release_unavailable' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    const path = match[4];
    if (path === undefined) {
      return new Response(JSON.stringify(buildPublicUpdateChannel(release.bundle)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const blob = release.bundle.payload.find((file) => file.path === path);
    if (blob === undefined) {
      return new Response(JSON.stringify({ schemaVersion: 1, error: 'release_unavailable' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(await blob.bytes.arrayBuffer(), { status: 200, headers: { 'content-type': blob.contentType } });
  };
}

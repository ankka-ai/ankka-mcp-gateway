import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/release-manifest';
import { buildPublicUpdateChannel, parsePublicUpdateChannel } from '../src/update-channel';
import { verifiedReleaseBundle } from './fixtures';

function bundleForRelease(release: string) {
  const manifest = { ...verifiedReleaseBundle.manifest, release };
  return Object.freeze({
    ...verifiedReleaseBundle,
    manifest,
    envelope: Object.freeze({
      ...verifiedReleaseBundle.envelope,
      manifest: canonicalJson(manifest),
    }),
  });
}

describe('public update channel', () => {
  it('derives a normal code-only descriptor from the exact signed manifest', () => {
    const channel = buildPublicUpdateChannel(verifiedReleaseBundle);
    expect(channel.channel).toBe('stable');
    expect(channel.release).toEqual({
      id: verifiedReleaseBundle.manifest.release,
      artifactSha256: `sha256:${verifiedReleaseBundle.manifest.artifact.treeSha256}`,
      sourceCommit: verifiedReleaseBundle.manifest.sourceCommit,
    });
    expect(channel.classification.kind).toBe('normal');
    expect(channel.classification.updaterProtocol).toBe(2);
    expect(channel.classification.excludes).toContain('durable_object_migrations');
    expect(channel.verification.manifest).toBe(verifiedReleaseBundle.envelope.manifest);
    expect(channel.verification).toMatchObject({
      schemaVersion: 2,
      channel: 'stable',
      signatureContext: 'ankka-mcp-gateway-release-envelope-v2',
    });
    expect(parsePublicUpdateChannel(channel)).toEqual(channel);
  });

  it.each(['gateway-v0.1.20'])(
    'preserves generic release notes for %s', (release) => {
      expect(buildPublicUpdateChannel(bundleForRelease(release)).notes).toEqual([
        `Signed ${release} gateway runtime and management application.`,
        'Normal update: your configuration, credentials, Access, DNS, MCP sources, and tool allowlists are unchanged.',
      ]);
    },
  );

  it('rejects an unsigned classification expansion', () => {
    const channel = buildPublicUpdateChannel(verifiedReleaseBundle);
    expect(() => parsePublicUpdateChannel({
      ...channel,
      classification: { ...channel.classification, changes: ['customer_worker_code', 'dns'] },
    })).toThrowError(expect.objectContaining({ code: 'release_invalid' }));
    expect(() => parsePublicUpdateChannel({
      ...channel,
      channel: 'canary',
    })).toThrowError(expect.objectContaining({ code: 'release_invalid' }));
    expect(() => parsePublicUpdateChannel({
      ...channel,
      classification: { ...channel.classification, updaterProtocol: 1 },
    })).toThrowError(expect.objectContaining({ code: 'release_invalid' }));
  });
});

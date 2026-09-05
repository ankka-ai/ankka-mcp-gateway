import { describe, expect, it } from 'vitest';
import { compileRelayOrigin, compiledRelayOrigin } from '../scripts/compiled-relay-origin.mjs';
import { isolatedRelayArtifacts } from '../scripts/generate-isolated-relay.mjs';

describe('compiled isolated OAuth relay', () => {
  it('preserves the public relay and derives an isolated relay from the signed installer origin', () => {
    expect(compiledRelayOrigin('https://deploy.ankka.ai')).toBe('https://auth.ankka.ai');
    expect(compiledRelayOrigin('https://installer.canary.example.com')).toBe('https://auth.installer.canary.example.com');
    for (const value of ['http://installer.example.com', 'https://user:secret@installer.example.com', 'https://installer.example.com/path']) {
      expect(() => compiledRelayOrigin(value)).toThrow();
    }
    expect(() => compileRelayOrigin('unreviewed declaration', 'https://installer.example.com')).toThrow('relay_origin_anchor_invalid');
  });
  it('builds the real relay with only the isolated route and disabled request logging', async () => {
    const artifacts = await isolatedRelayArtifacts({ hostname: 'installer.canary.example.com',
      schemaVersion: 1, kind: 'ankka-gateway-deploy-isolated-target', zoneId: 'b'.repeat(32), oauthClientId: 'c'.repeat(32),
      accountId: 'a'.repeat(32), workerName: 'ankka-gateway-deploy-isolated-fixture' });
    expect(artifacts.source).toContain('https://auth.installer.canary.example.com');
    expect(artifacts.source).not.toContain('https://auth.ankka.ai');
    expect(artifacts.config).toContain('pattern = "auth.installer.canary.example.com"');
    expect(artifacts.config).toContain('invocation_logs = false');
    expect(artifacts.config).toContain('workers_dev = false');
    expect(artifacts.workerName).toBe('ankka-auth-isolated-fixture');
  });
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as v from 'valibot';

import { credentialReferenceLabel } from './lifecycle-job.mjs';

/**
 * Reads one operator credential into memory from its store: a macOS keychain
 * item or an environment variable named by reference. The value never enters
 * argv, logs, journals, records or reports.
 */
const execute = promisify(execFile);

export class OperatorCredentialError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}

export async function resolveOperatorCredential(reference) {
  const label = credentialReferenceLabel(reference);
  if ('env' in reference) {
    const value = process.env[reference.env];
    if (!v.is(v.pipe(v.string(), v.minLength(20)), value)) throw new OperatorCredentialError('credential_unavailable', label);
    return value;
  }
  try {
    const { stdout } = await execute('security', ['find-generic-password', '-s', reference.keychain.service, '-a', reference.keychain.account, '-w'],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 65_536 });
    const value = stdout.trim();
    if (value.length < 20) throw new OperatorCredentialError('credential_unavailable', label);
    return value;
  } catch (error) {
    if (error instanceof OperatorCredentialError) throw error;
    throw new OperatorCredentialError('credential_unavailable', label);
  }
}

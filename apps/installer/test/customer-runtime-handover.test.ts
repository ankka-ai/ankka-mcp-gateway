import { describe, expect, it, vi } from 'vitest';
import { finishCustomerRuntimeHandover } from '../src/customer-gateway-entrypoint';
import { sealOperationSecret } from '../src/customer-operation-secrets';

const KEY = 'ankka-mcp-gateway/customer-runtime-handover/v1';
const NOW = 1_800_000_000_000;
const config = {
  ANKKA_GATEWAY_RELEASE: 'gateway-v1.0.1',
  ANKKA_GATEWAY_RELEASE_SHA256: `sha256:${'a'.repeat(64)}`,
  ANKKA_GATEWAY_OWNERSHIP_WRAP_KEY: 'A'.repeat(43),
};

async function fixture() {
  const record = {
    schemaVersion: 1, actionId: `action_${'b'.repeat(32)}`, operation: 'update',
    actionExpiresAt: NOW + 60_000,
    target: { release: config.ANKKA_GATEWAY_RELEASE, artifactSha256: config.ANKKA_GATEWAY_RELEASE_SHA256 },
    fromVersionId: '11111111-1111-4111-8111-111111111111',
    sealedActionKey: await sealOperationSecret(config.ANKKA_GATEWAY_OWNERSHIP_WRAP_KEY, 'C'.repeat(43)),
    armedAt: NOW - 10_000, deadline: NOW + 30_000,
  };
  const entries = new Map<string, unknown>([[KEY, record]]);
  const setAlarm = vi.fn(async (_at: number | Date) => {});
  const storage: Pick<DurableObjectStorage, 'get' | 'delete' | 'setAlarm'> = Object.create(null);
  Object.defineProperties(storage, {
    get: { value: async (key: string) => entries.get(key) },
    delete: { value: async (key: string) => entries.delete(key) },
    setAlarm: { value: setAlarm },
  });
  return { record, entries, storage, setAlarm };
}

describe('runtime handover completion', () => {
  it.each(['refused', 'thrown', 'lost acknowledgement'])('retries a %s finalization without dropping the sealed record', async (failure) => {
    const state = await fixture();
    let committed = false;
    const control = vi.fn(async () => {
      expect(state.setAlarm).toHaveBeenCalled();
      if (control.mock.calls.length === 1) {
        if (failure === 'refused') return false;
        committed = failure === 'lost acknowledgement';
        throw new Error('temporary failure');
      }
      committed = true;
      return true;
    });
    await finishCustomerRuntimeHandover(state.storage, config, control, NOW);
    expect(state.entries.has(KEY)).toBe(true);
    expect(state.setAlarm).toHaveBeenLastCalledWith(NOW + 8_000);
    await finishCustomerRuntimeHandover(state.storage, config, control, NOW + 8_000);
    expect(control).toHaveBeenLastCalledWith(expect.objectContaining({ actionId: state.record.actionId }),
      { command: 'finalize', fromVersionId: state.record.fromVersionId });
    expect(committed).toBe(true);
    expect(state.entries.has(KEY)).toBe(false);
  });

  it('waits for both the running release and digest, then reports an unconfirmed handover at the deadline', async () => {
    const state = await fixture();
    const control = vi.fn(async () => true);
    const wrongDigest = { ...config, ANKKA_GATEWAY_RELEASE_SHA256: `sha256:${'d'.repeat(64)}` };
    await finishCustomerRuntimeHandover(state.storage, wrongDigest, control, NOW);
    expect(control).not.toHaveBeenCalled();
    expect(state.entries.has(KEY)).toBe(true);
    await finishCustomerRuntimeHandover(state.storage, wrongDigest, control, state.record.deadline);
    expect(control).toHaveBeenCalledWith(expect.anything(),
      { command: 'fail', failureCode: 'runtime_update_unconfirmed', recoveryRequired: true });
    expect(state.entries.has(KEY)).toBe(false);
  });

  it('bounds retries and deletes the sealed key when authorization expires', async () => {
    const state = await fixture();
    const control = vi.fn(async () => false);
    await finishCustomerRuntimeHandover(state.storage, config, control, state.record.actionExpiresAt - 1);
    expect(state.setAlarm).toHaveBeenLastCalledWith(state.record.actionExpiresAt);
    await finishCustomerRuntimeHandover(state.storage, config, control, state.record.actionExpiresAt);
    expect(control).toHaveBeenCalledTimes(1);
    expect(state.entries.has(KEY)).toBe(false);
  });
});

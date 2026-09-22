import { z } from 'zod';
import { AUTHORING_GUIDE, commandSchema, connectionSchema, parseDefinition, type Definition } from './contract';
import { executeTool, type Outcome } from './execute';

interface Version { definition: Definition; connection: string }
interface State {
  revision: number;
  draft: Version | null;
  active: Version | null;
  tested: string[];
}
const initial = (): State => ({ revision: 1, draft: null, active: null, tested: [] });
const failure = (error: string, status = 400) => Response.json({ error }, { status });

/** Source state shares the gateway's existing SQLite namespace. */
export class ApiSourceStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: { CONNECTION_JSON: string; PROVIDER_TOKEN: string; LOADER: WorkerLoader },
    private readonly endpoint: string,
    private readonly key = 'api-source/v1',
  ) {}
  async manage(text: string): Promise<Response> {
    try {
      if (text.length > 48_000) return failure('api_source_input_invalid');
      const command = commandSchema.parse(JSON.parse(text));
      const connection = connectionSchema.parse(JSON.parse(this.env.CONNECTION_JSON));
      const identity = JSON.stringify(connection);
      const state = await this.storage.get<State>(this.key) ?? initial();
      if (command.operation === 'read') {
        return Response.json({ ...state, connection, guide: AUTHORING_GUIDE, endpoint: this.endpoint });
      }
      if (command.revision !== state.revision) return failure('api_source_revision_conflict', 409);
      if (command.operation === 'test') {
        const draft = state.draft;
        const tool = draft?.definition.tools.find((entry) => entry.name === command.tool);
        if (!draft || !tool || draft.connection !== identity) return failure('api_source_draft_required', 409);
        const input = z.json().parse(JSON.parse(command.argumentsJson));
        const outcome = await executeTool(tool, input, connection, this.env.PROVIDER_TOKEN, this.env.LOADER);
        return await this.storage.transaction(async (storage) => {
          const current = await storage.get<State>(this.key) ?? initial();
          if (current.revision !== command.revision) return failure('api_source_revision_conflict', 409);
          const tested = current.tested.filter((name) => name !== command.tool);
          if (outcome.ok) tested.push(command.tool);
          await storage.put(this.key, { ...current, tested: tested.sort() });
          return Response.json({ revision: current.revision, tool: command.tool, ...outcome });
        });
      }
      const definition = command.operation === 'save' ? parseDefinition(command.definitionJson) : null;
      if (definition && this.env.PROVIDER_TOKEN && JSON.stringify(definition).includes(this.env.PROVIDER_TOKEN)) {
        return failure('api_source_definition_contains_credential');
      }
      return await this.storage.transaction(async (storage) => {
        const current = await storage.get<State>(this.key) ?? initial();
        if (current.revision !== command.revision) return failure('api_source_revision_conflict', 409);
        if (command.operation === 'save' && definition) {
          current.draft = { definition, connection: identity };
          current.tested = [];
        } else if (command.operation === 'activate') {
          if (!current.draft || current.draft.connection !== identity ||
              !current.draft.definition.tools.every((tool) => current.tested.includes(tool.name))) {
            return failure('api_source_test_required', 409);
          }
          current.active = current.draft;
          current.draft = null;
          current.tested = [];
        } else if (command.operation === 'disable') {
          current.active = null;
        } else if (command.operation === 'discard') {
          current.draft = null;
          current.tested = [];
        }
        current.revision++;
        await storage.put(this.key, current);
        return Response.json({ revision: current.revision, active: current.active !== null,
          tools: current.active?.definition.tools.map((tool) => tool.name) ?? [], endpoint: this.endpoint });
      });
    } catch { return failure('api_source_input_or_configuration_invalid'); }
  }

  private async activeTools(): Promise<Definition['tools']> {
    const state = await this.storage.get<State>(this.key);
    const connection = connectionSchema.safeParse(JSON.parse(this.env.CONNECTION_JSON));
    if (!state?.active || !connection.success || state.active.connection !== JSON.stringify(connection.data)) return [];
    return state.active.definition.tools;
  }

  async catalogue(): Promise<string> { return JSON.stringify(await this.activeTools()); }

  async call(name: string, inputText: string): Promise<string> {
    return JSON.stringify(await this.execute(name, inputText));
  }

  private async execute(name: string, inputText: string): Promise<Outcome> {
    try {
      const input = z.json().parse(JSON.parse(inputText));
      const tools = await this.activeTools();
      const tool = tools.find((item) => item.name === name);
      if (!tool) return { ok: false, error: 'api_source_tool_unavailable', requests: 0 };
      return await executeTool(tool, input, connectionSchema.parse(JSON.parse(this.env.CONNECTION_JSON)), this.env.PROVIDER_TOKEN, this.env.LOADER);
    } catch { return { ok: false, error: 'api_source_unavailable', requests: 0 }; }
  }
}

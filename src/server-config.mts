// The adapter's own settings: the default model, the default reasoning effort,
// and the catch-all bag of everything else the desktop's settings sheet
// writes. This is what `config/read`, `config/value/write` and `model/list`
// answer from, and what survives a restart in `$ANYENGINE_HOME/config.json`.
//
// It was three fields and eight methods on the protocol class, read from
// forty-odd places. As one object the state and the payloads that project it
// sit together, and the protocol layer asks for `this.config.model` instead of
// keeping a copy of it.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grokModelOptions } from './grok-models.mjs'
import { projectProviderLoopConfig } from './provider-loop-config.mjs'
import {
  hasProviderLoopSelectionInput,
  isProviderLoopSelectionConfigKey,
  type ProviderLoopSelectionInput,
  providerLoopSelectionInputFromConfig,
  providerLoopSelectionInputFromEnv,
} from './provider-loop-selection.mjs'
import { normalizeRuntimeType } from './runtime-config.mjs'
import {
  configEdits,
  configLayerMetadata,
  defaultSelectableModelId,
  normalizeSelectableModelId,
  stringOr,
} from './server-helpers.mjs'
import {
  adapterHome,
  claudeModelOptions,
  codexHome,
  codexProxyModelOptions,
  ensureParent,
  normalizeCodexReasoningEffort,
  nowSeconds,
} from './util.mjs'

export class ServerConfig {
  /** Default model for new threads; `model/list` marks it `isDefault`. */
  model = defaultSelectableModelId()
  reasoningEffort = normalizeCodexReasoningEffort(process.env.ANYENGINE_DEFAULT_EFFORT) ?? 'medium'
  // Catch-all for arbitrary keys the App's settings sheet writes (approval
  // policy, sandbox preference, instructions toggles, etc.). We don't apply
  // them to typed runtime state, but we round-trip them through config/read
  // so the user's settings survive a daemon restart instead of resetting on
  // every reconnect.
  overrides: Record<string, unknown> = {}
  private readonly path = join(adapterHome(), 'config.json')

  readPayload(): unknown {
    // Base config = our typed defaults; overrides (whatever the App's
    // settings sheet has written previously via config/value/write) are
    // layered on top so the user sees their last-saved values instead of
    // the defaults bouncing back on every reconnect. Typed fields (model /
    // model_reasoning_effort) take precedence over overrides since they're
    // applied via a stricter validator.
    return {
      config: {
        ...this.publicOverrides(),
        model: this.model,
        review_model: null,
        model_context_window: null,
        model_auto_compact_token_limit: null,
        model_provider: 'claude-code',
        approval_policy: this.overrides.approval_policy ?? 'on-request',
        approvals_reviewer: this.overrides.approvals_reviewer ?? 'user',
        sandbox_mode: this.overrides.sandbox_mode ?? 'workspace-write',
        sandbox_workspace_write: this.overrides.sandbox_workspace_write ?? null,
        forced_chatgpt_workspace_id: null,
        forced_login_method: null,
        web_search: this.overrides.web_search ?? 'disabled',
        tools: this.overrides.tools ?? null,
        profile: this.overrides.profile ?? null,
        profiles: {},
        instructions: this.overrides.instructions ?? null,
        developer_instructions: this.overrides.developer_instructions ?? null,
        compact_prompt: this.overrides.compact_prompt ?? null,
        model_reasoning_effort: this.reasoningEffort,
        model_reasoning_summary: this.overrides.model_reasoning_summary ?? null,
        model_verbosity: this.overrides.model_verbosity ?? null,
        service_tier: this.overrides.service_tier ?? null,
        analytics: this.overrides.analytics ?? null,
        apps: this.overrides.apps ?? null,
        model_providers: this.exposedModelProviders(),
        provider_loop_config: projectProviderLoopConfig(
          undefined,
          this.providerLoopSelectionInput(),
        ),
      },
      origins: {
        model_provider: configLayerMetadata(),
        'model_providers.claude-code': configLayerMetadata(),
        ...(codexProxyModelOptions().length > 0
          ? { 'model_providers.codex': configLayerMetadata() }
          : {}),
      },
      layers: null,
    }
  }

  providerLoopSelectionInput(): ProviderLoopSelectionInput {
    const legacyRuntimeType = normalizeRuntimeType(
      process.env.ANYENGINE_RUNTIME_TYPE ??
        process.env.ANYENGINE_RUNTIME ??
        process.env.ANYENGINE_BACKEND,
    )
    const envInput = providerLoopSelectionInputFromEnv(process.env, legacyRuntimeType)
    if (hasProviderLoopSelectionInput(envInput)) return envInput
    return providerLoopSelectionInputFromConfig(
      this.overrides,
      legacyRuntimeType,
      process.env.ANYENGINE_MOCK === '1',
    )
  }

  publicOverrides(): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.overrides).filter(([key]) => !isProviderLoopSelectionConfigKey(key)),
    )
  }

  // Build the model_providers map served by config/read. Always exposes
  // 'claude-code'; conditionally adds 'codex' when a real Codex CLI is
  // resolvable on the host. Exposing 'codex' as a separate provider entry
  // gives the App's settings panel a way to surface OpenAI-family models
  // (gpt-*) without the App treating them as foreign to the Claude
  // provider's allowlist.
  exposedModelProviders(): Record<string, unknown> {
    const providers: Record<string, unknown> = {
      'claude-code': {
        name: 'Claude Code',
        base_url: null,
        env_key: null,
        env_key_instructions: null,
        experimental_bearer_token: null,
        auth: null,
        aws: null,
        wire_api: 'responses',
        query_params: null,
        http_headers: null,
        env_http_headers: null,
        request_max_retries: null,
        stream_max_retries: null,
        stream_idle_timeout_ms: null,
        websocket_connect_timeout_ms: null,
        requires_openai_auth: false,
        supports_websockets: false,
      },
    }
    if (codexProxyModelOptions().length > 0) {
      // 'codex' = real OpenAI Codex CLI forwarded via `codex exec --json`.
      // Auth is delegated to the real codex binary (its own OAuth login),
      // so we advertise requires_openai_auth: false to keep our own
      // account/read amazonBedrock shim from gating these.
      providers.codex = {
        name: 'Codex (OpenAI · forwarded)',
        base_url: null,
        env_key: null,
        env_key_instructions: null,
        experimental_bearer_token: null,
        auth: null,
        aws: null,
        wire_api: 'responses',
        query_params: null,
        http_headers: null,
        env_http_headers: null,
        request_max_retries: null,
        stream_max_retries: null,
        stream_idle_timeout_ms: null,
        websocket_connect_timeout_ms: null,
        requires_openai_auth: false,
        supports_websockets: false,
      }
    }
    if (grokModelOptions().length > 0) {
      // 'grok' = xAI Grok Build CLI forwarded via `grok agent stdio`; auth is
      // the grok binary's own login, so no OpenAI auth gating either.
      providers.grok = {
        name: 'Grok (xAI · forwarded)',
        base_url: null,
        env_key: null,
        env_key_instructions: null,
        experimental_bearer_token: null,
        auth: null,
        aws: null,
        wire_api: 'responses',
        query_params: null,
        http_headers: null,
        env_http_headers: null,
        request_max_retries: null,
        stream_max_retries: null,
        stream_idle_timeout_ms: null,
        websocket_connect_timeout_ms: null,
        requires_openai_auth: false,
        supports_websockets: false,
      }
    }
    return providers
  }

  modelListPayload(): unknown {
    const defaultModel = this.model
    const claudeOptions = claudeModelOptions()
    // When a real Codex CLI binary is available on the host (CODEX_REAL env
    // or auto-discovered), expose its native models alongside Claude's so
    // the Codex App's per-thread model picker can route between backends
    // without any reconnect or shell flip. Picking gpt-* flips the thread
    // to runtimeBackend='codex' which the runtime router dispatches to
    // CodexProxyRuntime (shells out to `codex exec --json`).
    const codexOptions = codexProxyModelOptions()
    // grok-* ids (xAI Grok Build CLI) route the thread's turns to the grok
    // runtime; see grok-models.mts for discovery / ANYENGINE_GROK_MODELS.
    const grokOptions = grokModelOptions()
    const options = [...claudeOptions, ...codexOptions, ...grokOptions]
    const hasConfiguredDefault = options.some((option) => option.id === defaultModel)
    const reasoningEfforts = [
      { reasoningEffort: 'low', description: 'Fast runtime response' },
      { reasoningEffort: 'medium', description: 'Balanced runtime response' },
      { reasoningEffort: 'high', description: 'Deeper runtime response' },
      { reasoningEffort: 'xhigh', description: 'Maximum reasoning' },
    ]
    return {
      data: options.map((option) => ({
        id: option.id,
        model: option.id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: option.displayName,
        description: option.description,
        hidden: false,
        supportedReasoningEfforts: reasoningEfforts,
        defaultReasoningEffort: this.reasoningEffort,
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        isDefault: hasConfiguredDefault ? option.id === defaultModel : option.isDefault === true,
      })),
      nextCursor: null,
    }
  }

  writeResponse(params: Record<string, unknown>): unknown {
    for (const edit of configEdits(params)) {
      const { keyPath, value } = edit
      if (keyPath === 'model' && typeof value === 'string' && value.length > 0) {
        this.model = normalizeSelectableModelId(value, this.model)
      } else if (keyPath === 'model_reasoning_effort' && typeof value === 'string') {
        this.reasoningEffort = normalizeCodexReasoningEffort(value) ?? this.reasoningEffort
      } else {
        // Unknown key — store in the generic overrides bag so it survives a
        // restart even though we don't apply it to typed runtime state. This
        // captures approvalPolicy, sandboxMode, instruction toggles, anything
        // the App's settings sheet may emit. `null` value clears the entry.
        if (value === null || value === undefined) {
          delete this.overrides[keyPath]
        } else {
          this.overrides[keyPath] = value
        }
      }
    }
    this.persist()
    const filePath = stringOr(params.filePath, `${codexHome()}/config.toml`)
    return {
      status: 'ok',
      version: `anyengine-${nowSeconds()}`,
      filePath,
      overriddenMetadata: null,
    }
  }

  load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
      let shouldRepair = false
      if (typeof parsed.model === 'string' && parsed.model.length > 0) {
        const normalized = normalizeSelectableModelId(parsed.model, this.model)
        shouldRepair = normalized !== parsed.model
        this.model = normalized
      }
      if (typeof parsed.model_reasoning_effort === 'string') {
        this.reasoningEffort =
          normalizeCodexReasoningEffort(parsed.model_reasoning_effort) ?? this.reasoningEffort
      }
      // Restore the overrides bag — any key persisted previously that isn't
      // the strongly-typed model / effort lives here so it survives restarts.
      if (
        parsed.overrides &&
        typeof parsed.overrides === 'object' &&
        !Array.isArray(parsed.overrides)
      ) {
        this.overrides = parsed.overrides as Record<string, unknown>
      }
      if (shouldRepair) this.persist()
    } catch {}
  }

  persist(): void {
    try {
      ensureParent(this.path)
      writeFileSync(
        this.path,
        JSON.stringify(
          {
            model: this.model,
            model_reasoning_effort: this.reasoningEffort,
            overrides: this.overrides,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
    } catch {}
  }
}

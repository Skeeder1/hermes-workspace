import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  ensureGatewayProbed,
  getGatewayCapabilities,
} from '../../server/claude-api'
import { BEARER_TOKEN, CLAUDE_API } from '../../server/gateway-capabilities'
import {
  ensureDiscovery,
  getDiscoveredModels,
  ensureProviderInConfig,
} from '../../server/local-provider-discovery'
import { normalizeProviderId } from '../../lib/provider-catalog'
import { toErrorMessage } from '@/lib/error-utils'

const CLAUDE_HOME = process.env.HERMES_HOME ?? process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.hermes')
const MODELS_PATH = path.join(CLAUDE_HOME, 'models.json')
const CONFIG_PATH = path.join(CLAUDE_HOME, 'config.yaml')

type ModelEntry = {
  provider?: string
  id?: string
  name?: string
  [key: string]: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
  return {}
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeModel(entry: unknown): ModelEntry | null {
  if (typeof entry === 'string') {
    const id = entry.trim()
    if (!id) return null
    return {
      id,
      name: id,
      provider: id.includes('/') ? id.split('/')[0] : 'unknown',
    }
  }
  const record = asRecord(entry)
  const id =
    readString(record.id) || readString(record.name) || readString(record.model)
  if (!id) return null
  const rawProvider =
    readString(record.provider) ||
    readString(record.owned_by) ||
    (id.includes('/') ? id.split('/')[0] : 'unknown')
  return {
    ...record,
    id,
    name:
      readString(record.name) ||
      readString(record.display_name) ||
      readString(record.label) ||
      id,
    provider: normalizeProviderId(rawProvider),
  }
}

export function mergeModelEntries(...sources: Array<Array<ModelEntry>>): Array<ModelEntry> {
  const merged: Array<ModelEntry> = []
  const seen = new Set<string>()

  for (const source of sources) {
    for (const model of source) {
      const normalized = normalizeModel(model)
      if (!normalized || seen.has(normalized.id)) continue
      merged.push(normalized)
      seen.add(normalized.id)
    }
  }

  return merged
}

/**
 * Read user-configured models from active profile's models.json.
 */
function readClaudeModelsJson(): Array<ModelEntry> {
  try {
    if (!fs.existsSync(MODELS_PATH)) return []
    const raw = fs.readFileSync(MODELS_PATH, 'utf-8')
    const entries = JSON.parse(raw)
    if (!Array.isArray(entries)) return []
    return entries
      .map((entry: unknown): ModelEntry | null => {
        const record = asRecord(entry)
        // models.json uses "model" field for the model ID
        const modelId = readString(record.model) || readString(record.id)
        if (!modelId) return null
        return {
          id: modelId,
          name: readString(record.name) || modelId,
          provider: readString(record.provider) || 'unknown',
        }
      })
      .filter((entry): entry is ModelEntry => entry !== null)
  } catch {
    return []
  }
}

const AUTH_JSON_PATH = path.join(CLAUDE_HOME, 'auth.json')
const CATALOG_CACHE_PATH = path.join(CLAUDE_HOME, 'model-catalog-cache.json')
const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000

type NousModelCatalog = {
  providers: Record<string, { models: Array<{ id: string; description?: string }> }>
}

function readCredentialPoolProviders(): Set<string> {
  try {
    if (!fs.existsSync(AUTH_JSON_PATH)) return new Set()
    const raw = fs.readFileSync(AUTH_JSON_PATH, 'utf-8')
    const data = JSON.parse(raw)
    const pool = data?.credential_pool
    if (!pool || typeof pool !== 'object') return new Set()
    return new Set(Object.keys(pool))
  } catch {
    return new Set()
  }
}

function readModelCatalogConfig(): { url: string; ttlMs: number } | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = YAML.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const cfg = parsed as Record<string, unknown>
    const mc = cfg.model_catalog as Record<string, unknown> | undefined
    if (!mc || mc.enabled === false) return null
    const url = typeof mc.url === 'string' ? mc.url.trim() : ''
    if (!url) return null
    const ttlH = typeof mc.ttl_hours === 'number' && mc.ttl_hours > 0 ? mc.ttl_hours : 24
    return { url, ttlMs: ttlH * 60 * 60 * 1000 }
  } catch {
    return null
  }
}

async function fetchNousModelCatalog(
  url: string,
  activeProviders: Set<string>,
  ttlMs: number,
): Promise<Array<ModelEntry>> {
  let raw: string | null = null

  try {
    const stat = fs.statSync(CATALOG_CACHE_PATH)
    if (Date.now() - stat.mtimeMs < ttlMs) {
      raw = fs.readFileSync(CATALOG_CACHE_PATH, 'utf-8')
    }
  } catch {
    // cache miss
  }

  if (!raw) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(7_000) })
      if (!res.ok) return []
      raw = await res.text()
      try {
        fs.writeFileSync(CATALOG_CACHE_PATH, raw, { encoding: 'utf-8', mode: 0o600 })
      } catch {
        // non-critical
      }
    } catch {
      // try stale cache as fallback
      try {
        raw = fs.readFileSync(CATALOG_CACHE_PATH, 'utf-8')
      } catch {
        return []
      }
    }
  }

  try {
    const catalog = JSON.parse(raw) as NousModelCatalog
    const entries: Array<ModelEntry> = []
    for (const [providerId, pdata] of Object.entries(catalog.providers ?? {})) {
      if (!activeProviders.has(providerId)) continue
      for (const m of pdata.models ?? []) {
        if (!m.id) continue
        entries.push({
          id: m.id,
          name: m.id,
          provider: normalizeProviderId(providerId),
        })
      }
    }
    return entries
  } catch {
    return []
  }
}

const DEFAULT_ACCEPTED_TIMEOUT_S = 120
const DEFAULT_HANDOFF_TIMEOUT_S = 300

function readStreamTimeouts(): { streamAcceptedTimeoutMs: number; streamHandoffTimeoutMs: number } {
  let acceptedS = DEFAULT_ACCEPTED_TIMEOUT_S
  let handoffS = DEFAULT_HANDOFF_TIMEOUT_S
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      const ws =
        parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).workspace === 'object'
          ? ((parsed as Record<string, unknown>).workspace as Record<string, unknown>)
          : {}
      if (typeof ws.stream_accepted_timeout === 'number' && ws.stream_accepted_timeout > 0)
        acceptedS = ws.stream_accepted_timeout
      if (typeof ws.stream_handoff_timeout === 'number' && ws.stream_handoff_timeout > 0)
        handoffS = ws.stream_handoff_timeout
    }
  } catch {
    // fall through to defaults
  }
  const envAccepted = parseInt(process.env.STREAM_ACCEPTED_TIMEOUT_MS ?? '', 10)
  const envHandoff = parseInt(process.env.STREAM_HANDOFF_TIMEOUT_MS ?? '', 10)
  return {
    streamAcceptedTimeoutMs: Number.isFinite(envAccepted) && envAccepted > 0 ? envAccepted : acceptedS * 1000,
    streamHandoffTimeoutMs: Number.isFinite(envHandoff) && envHandoff > 0 ? envHandoff : handoffS * 1000,
  }
}

/**
 * Read the default model from active profile's config.yaml using a proper YAML parser.
 */
function readClaudeDefaultModel(): ModelEntry | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = YAML.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const config = parsed as Record<string, unknown>
    let modelId = ''
    let provider = ''
    const modelField = config.model
    if (typeof modelField === 'string') {
      modelId = modelField
      provider = (config.provider as string) || 'unknown'
    } else if (modelField && typeof modelField === 'object') {
      const modelObj = modelField as Record<string, unknown>
      modelId = (modelObj.default as string) || ''
      provider =
        (modelObj.provider as string) ||
        (config.provider as string) ||
        'unknown'
    }
    if (!modelId) return null
    return { id: modelId, name: modelId, provider }
  } catch {
    return null
  }
}

/**
 * Fallback: fetch models from the hermes-agent /v1/models endpoint.
 */
async function fetchClaudeModels(): Promise<Array<ModelEntry>> {
  const headers: Record<string, string> = {}
  if (BEARER_TOKEN) headers['Authorization'] = `Bearer ${BEARER_TOKEN}`
  const response = await fetch(`${CLAUDE_API}/v1/models`, { headers })
  if (!response.ok)
    throw new Error(`Hermes models request failed (${response.status})`)
  const payload = asRecord(await response.json())
  const rawModels = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : []
  return rawModels
    .map(normalizeModel)
    .filter((e): e is ModelEntry => e !== null)
}

export const Route = createFileRoute('/api/models')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        await ensureGatewayProbed()

        try {
          // Primary: read user-configured models from ~/.hermes/models.json
          let models = readClaudeModelsJson()
          let source = 'models.json'

          // Ensure the default model from config.yaml is always first
          const defaultModel = readClaudeDefaultModel()
          if (defaultModel) {
            models = models.filter((m) => m.id !== defaultModel.id)
            models.unshift(defaultModel)
          }

          // Merge the authoritative Hermes model catalog whenever it is
          // available. Previously, a non-empty models.json stopped here, so the
          // Operations picker only showed the local Workspace subset and drifted
          // from the CLI/backend model universe.
          if (getGatewayCapabilities().models) {
            const hermesModels = await fetchClaudeModels()
            models = mergeModelEntries(models, hermesModels)
            source = source === 'models.json' ? 'models.json+hermes-agent' : 'hermes-agent'
          }

          // Merge auto-discovered local models (Ollama, Atomic Chat, etc.)
          await ensureDiscovery()
          const localModels = getDiscoveredModels()
          models = mergeModelEntries(models, localModels)
          for (const m of localModels) {
            ensureProviderInConfig(m.provider)
          }

          // Merge NousResearch model catalog (OpenRouter + Nous), filtered by credential pool
          const catalogConfig = readModelCatalogConfig()
          if (catalogConfig) {
            const activeProviders = readCredentialPoolProviders()
            if (activeProviders.size > 0) {
              const catalogModels = await fetchNousModelCatalog(
                catalogConfig.url,
                activeProviders,
                catalogConfig.ttlMs,
              )
              models = mergeModelEntries(models, catalogModels)
              if (catalogModels.length > 0) {
                source = source.includes('catalog') ? source : `${source}+catalog`
              }
            }
          }

          const configuredProviders = Array.from(
            new Set(
              models
                .map((model) =>
                  typeof model.provider === 'string' ? model.provider : '',
                )
                .filter(Boolean),
            ),
          )

          const streamTimeouts = readStreamTimeouts()

          return json({
            ok: true,
            object: 'list',
            data: models,
            models,
            configuredProviders,
            source,
            ...streamTimeouts,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: toErrorMessage(err),
            },
            { status: 503 },
          )
        }
      },
    },
  },
})

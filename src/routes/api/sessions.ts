import { randomUUID } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import {
  SESSIONS_API_UNAVAILABLE_MESSAGE,
  createSession,
  deleteSession,
  ensureGatewayProbed,
  getGatewayCapabilities,
  listSessions,
  toSessionSummary,
  updateSession,
} from '../../server/claude-api'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import { toErrorMessage } from '@/lib/error-utils'
import {
  deleteLocalSession,
  ensureLocalSession,
  getLocalSession,
  listLocalSessions,
  updateLocalSessionTitle,
} from '../../server/local-session-store'

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } } as const

export const Route = createFileRoute('/api/sessions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Auth check
        if (!isAuthenticated(request)) {
          return json(
            { ok: false, error: 'Unauthorized' },
            { status: 401, ...NO_STORE },
          )
        }
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          return json(
            {
              ok: true,
              sessions: [],
              source: 'unavailable',
              message: SESSIONS_API_UNAVAILABLE_MESSAGE,
            },
            NO_STORE,
          )
        }

        try {
          const sessions = await listSessions(50, 0)
          const gatewaySessions = sessions.map(toSessionSummary)

          // Merge local portable sessions (Ollama, Atomic Chat, etc.)
          const localSessions = listLocalSessions()
          const gatewayIds = new Set(gatewaySessions.map((s) => s.key || s.id))
          for (const ls of localSessions) {
            if (!gatewayIds.has(ls.id)) {
              gatewaySessions.push({
                key: ls.id,
                id: ls.id,
                friendlyId: ls.id,
                title: ls.title || null,
                label: ls.title || null,
                derivedTitle: ls.title || null,
                startedAt: ls.createdAt,
                updatedAt: ls.updatedAt,
                message_count: ls.messageCount,
                model: ls.model,
                source: 'local',
              })
            }
          }

          gatewaySessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          return json({ sessions: gatewaySessions }, NO_STORE)
        } catch (err) {
          return json(
            {
              error: toErrorMessage(err),
            },
            { status: 500, ...NO_STORE },
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheckPost = requireJsonContentType(request)
        if (csrfCheckPost) return csrfCheckPost
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          const friendlyId = randomUUID()
          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey: friendlyId,
            friendlyId,
            persisted: false,
          })
        }
        try {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >

          const requestedLabel =
            typeof body.label === 'string' ? body.label.trim() : ''
          const label = requestedLabel || undefined

          const requestedFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const friendlyId = requestedFriendlyId || randomUUID()

          const requestedModel =
            typeof body.model === 'string' ? body.model.trim() : ''
          const model = requestedModel || undefined

          if (capabilities.dashboard.available && !capabilities.enhancedChat) {
            ensureLocalSession(friendlyId, model)
            return json({
              ok: true,
              sessionKey: friendlyId,
              friendlyId,
              entry: {
                key: friendlyId,
                id: friendlyId,
                title: label || null,
                label: label || null,
                derivedTitle: label || null,
                model: model || '',
                startedAt: Date.now(),
                updatedAt: Date.now(),
                message_count: 0,
                source: 'local',
              },
              modelApplied: Boolean(model),
              persisted: true,
            })
          }

          const session = await createSession({
            id: friendlyId || randomUUID(),
            title: label,
            model,
          })

          return json({
            ok: true,
            sessionKey: session.id,
            friendlyId: session.id,
            entry: toSessionSummary(session),
            modelApplied: true,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: toErrorMessage(err),
            },
            { status: 500 },
          )
        }
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheckPatch = requireJsonContentType(request)
        if (csrfCheckPatch) return csrfCheckPatch
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >
          const rawSessionKey =
            typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
          const rawFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const sessionKey = rawSessionKey || rawFriendlyId || randomUUID()

          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey,
            friendlyId: rawFriendlyId || sessionKey,
            updated: false,
          })
        }
        try {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >

          const rawSessionKey =
            typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
          const rawFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const label =
            typeof body.label === 'string' ? body.label.trim() : undefined
          const sessionKey = rawSessionKey || rawFriendlyId

          if (!sessionKey) {
            return json(
              { ok: false, error: 'sessionKey required' },
              { status: 400 },
            )
          }

          const localSession = getLocalSession(sessionKey)
          if (localSession) {
            if (label) updateLocalSessionTitle(sessionKey, label)
            return json({
              ok: true,
              sessionKey,
              friendlyId: rawFriendlyId || sessionKey,
              entry: {
                key: sessionKey,
                id: sessionKey,
                title: label || sessionKey,
                label: label || sessionKey,
                derivedTitle: label || sessionKey,
                startedAt: localSession.createdAt,
                updatedAt: Date.now(),
                message_count: localSession.messageCount,
                model: localSession.model,
                source: 'local',
              },
              updated: true,
              source: 'local',
            })
          }

          if (capabilities.dashboard.available && !capabilities.enhancedChat) {
            return json({
              ok: true,
              sessionKey,
              entry: {
                key: sessionKey,
                id: sessionKey,
                title: label || sessionKey,
                label: label || sessionKey,
                derivedTitle: label || sessionKey,
                updatedAt: Date.now(),
              },
              updated: false,
            })
          }

          const session = await updateSession(sessionKey, {
            title: label,
          })

          return json({
            ok: true,
            sessionKey,
            entry: toSessionSummary(session),
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: toErrorMessage(err),
            },
            { status: 500 },
          )
        }
      },
      DELETE: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const rawSessionKey = url.searchParams.get('sessionKey') ?? ''
        const rawFriendlyId = url.searchParams.get('friendlyId') ?? ''
        const sessionKey = rawSessionKey.trim() || rawFriendlyId.trim()

        if (!sessionKey) {
          return json(
            { ok: false, error: 'sessionKey required' },
            { status: 400 },
          )
        }

        // Local sessions live in the workspace portable store, not the
        // gateway. Delete them locally without hitting the gateway.
        if (getLocalSession(sessionKey)) {
          deleteLocalSession(sessionKey)
          return json({ ok: true, sessionKey, source: 'local' })
        }

        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey,
            deleted: false,
          })
        }
        try {
          await deleteSession(sessionKey)

          return json({ ok: true, sessionKey })
        } catch (err) {
          return json(
            {
              ok: false,
              error: toErrorMessage(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})

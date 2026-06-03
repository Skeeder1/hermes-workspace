import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  ensureGatewayProbed,
  getGatewayCapabilities,
  listSessions,
  toSessionSummary,
} from '../../../server/claude-api'
import { toErrorMessage } from '@/lib/error-utils'

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } } as const

export const Route = createFileRoute('/api/gateway/sessions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401, ...NO_STORE })
        }
        await ensureGatewayProbed()
        const capabilities = getGatewayCapabilities()
        if (!capabilities.sessions) {
          return json({ ok: true, sessions: [], data: { sessions: [] } }, NO_STORE)
        }
        try {
          const raw = await listSessions(100, 0)
          const sessions = raw.map(toSessionSummary)
          return json({ ok: true, sessions, data: { sessions } }, NO_STORE)
        } catch (err) {
          return json({ ok: false, error: toErrorMessage(err), sessions: [] }, { status: 503, ...NO_STORE })
        }
      },
    },
  },
})

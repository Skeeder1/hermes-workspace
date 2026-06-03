import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } } as const

export const Route = createFileRoute('/api/cli-agents')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        return json({ ok: true, agents: [] }, NO_STORE)
      },
    },
  },
})

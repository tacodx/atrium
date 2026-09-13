import type { Provider } from './contract'

export function createRegistry() {
  const providers = new Map<string, Provider<any, any>>()

  return {
    register(p: Provider<any, any>) {
      if (providers.has(p.id)) throw new Error(`duplicate provider id: ${p.id}`)
      const ids = new Set<string>()
      for (const a of p.actions) {
        if (ids.has(a.id)) throw new Error(`duplicate action id "${a.id}" in provider "${p.id}"`)
        ids.add(a.id)
      }
      providers.set(p.id, p)
    },
    get: (id: string) => providers.get(id),
    all: () => [...providers.values()],
  }
}

export type Registry = ReturnType<typeof createRegistry>

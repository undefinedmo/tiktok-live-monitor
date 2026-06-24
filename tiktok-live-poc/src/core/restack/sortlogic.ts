// Faithful TypeScript port of tiktok-label-restack/app/sortlogic.py.
// Determinism is a hard requirement: same input -> identical sequence.

export interface RestackOrder {
  orderId: string
  buyer: string
  createdMs: number | null
}

export interface RestackBuyer {
  name: string
  orders: RestackOrder[]
  sortKey: number // = min(createdMs) across the buyer's orders (their OLDEST order)
}

const FAR_PAST = -Infinity // missing times sort last (oldest)

export function groupBuyers(orders: RestackOrder[]): RestackBuyer[] {
  const byName = new Map<string, RestackOrder[]>()
  for (const o of orders) {
    const key = o.buyer || `__noname__:${o.orderId}`
    const arr = byName.get(key)
    if (arr) arr.push(o)
    else byName.set(key, [o])
  }
  const buyers: RestackBuyer[] = []
  for (const [name, list] of byName) {
    const times = list.map((o) => o.createdMs).filter((t): t is number => t != null)
    buyers.push({ name, orders: list, sortKey: times.length ? Math.min(...times) : FAR_PAST })
  }
  return buyers
}

export function orderedOrders(orders: RestackOrder[]): RestackOrder[] {
  const buyers = groupBuyers(orders)
  // Buyers newest-first by their oldest-order time; ties: name descending
  // (matches Python's single `sort(key=(sort_key, name), reverse=True)`).
  buyers.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0
  })
  const seq: RestackOrder[] = []
  for (const b of buyers) {
    const within = [...b.orders].sort((x, y) => {
      const xc = x.createdMs ?? FAR_PAST
      const yc = y.createdMs ?? FAR_PAST
      if (xc !== yc) return xc - yc // oldest order first within a buyer's block
      return x.orderId < y.orderId ? -1 : x.orderId > y.orderId ? 1 : 0
    })
    seq.push(...within)
  }
  return seq
}

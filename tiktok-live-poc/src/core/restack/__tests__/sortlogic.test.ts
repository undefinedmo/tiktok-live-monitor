import { describe, it, expect } from 'vitest'
import { orderedOrders, type RestackOrder } from '../sortlogic'

const ids = (os: RestackOrder[]) => os.map((o) => o.orderId)

describe('orderedOrders', () => {
  it('orders newest purchase first when every buyer has one order', () => {
    const seq = orderedOrders([
      { orderId: 'a', buyer: 'amy', createdMs: 100 },
      { orderId: 'b', buyer: 'bob', createdMs: 300 },
      { orderId: 'c', buyer: 'cas', createdMs: 200 },
    ])
    expect(ids(seq)).toEqual(['b', 'c', 'a'])
  })

  it('positions a returning buyer by their OLDEST order and keeps their block contiguous', () => {
    // bob has orders at 50 (oldest) and 400; amy a single order at 300.
    const seq = orderedOrders([
      { orderId: 'bob-old', buyer: 'bob', createdMs: 50 },
      { orderId: 'amy', buyer: 'amy', createdMs: 300 },
      { orderId: 'bob-new', buyer: 'bob', createdMs: 400 },
    ])
    // bob's sortKey = 50 (oldest); amy's = 300. newest-first => amy(300) before bob(50).
    expect(ids(seq)).toEqual(['amy', 'bob-old', 'bob-new'])
    // bob's block is contiguous and oldest-first within the block.
  })

  it('sorts missing times last and is deterministic across runs', () => {
    const input: RestackOrder[] = [
      { orderId: 'x', buyer: 'zoe', createdMs: null },
      { orderId: 'y', buyer: 'ann', createdMs: 100 },
    ]
    expect(ids(orderedOrders(input))).toEqual(['y', 'x'])
    expect(orderedOrders(input)).toEqual(orderedOrders(input))
  })

  it('breaks time ties by buyer name descending', () => {
    const seq = orderedOrders([
      { orderId: 'p', buyer: 'aaa', createdMs: 100 },
      { orderId: 'q', buyer: 'zzz', createdMs: 100 },
    ])
    expect(ids(seq)).toEqual(['q', 'p']) // zzz before aaa
  })
})

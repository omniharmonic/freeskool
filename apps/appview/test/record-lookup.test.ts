import { expect, it, vi } from 'vitest'
import { getRecordByUri, listCollection, eventsInWindow } from '../src/index/queries.js'
import type { Indexer } from '../src/index/indexer.js'

it('finds a record beyond the author’s first page', async () => {
  const uri = 'at://did:plc:author/freeschool.draft.skill/older'
  const query = vi
    .fn()
    .mockResolvedValueOnce({ records: [], cursor: 'page-2' })
    .mockResolvedValueOnce({
      records: [
        {
          uri,
          did: 'did:plc:author',
          rkey: 'older',
          record: { label: 'Older skill' },
        },
      ],
    })
  const indexer = { contrail: { query } } as unknown as Indexer
  expect((await getRecordByUri(indexer, 'skill', uri))?.value.label).toBe(
    'Older skill',
  )
  expect(query.mock.calls[1]?.[1]).toMatchObject({
    did: 'did:plc:author',
    cursor: 'page-2',
  })
})
it('stops on an exhausted or repeated cursor for a missing record', async () => {
  const query = vi.fn().mockResolvedValue({ records: [], cursor: 'repeated' })
  expect(
    await getRecordByUri(
      { contrail: { query } } as unknown as Indexer,
      'skill',
      'at://did:plc:author/freeschool.draft.skill/missing',
    ),
  ).toBeNull()
  expect(query).toHaveBeenCalledTimes(2)
})

const record = (i: number) => ({ uri: `at://did:plc:author/freeschool.draft.skill/${i}`, did: 'did:plc:author', rkey: String(i), record: { label: `Skill ${i}` } })
it('reads a full taxonomy despite the index’s 200-row page cap', async () => {
  const query = vi.fn()
    .mockResolvedValueOnce({ records: Array.from({ length: 200 }, (_, i) => record(i)), cursor: '200' })
    .mockResolvedValueOnce({ records: Array.from({ length: 200 }, (_, i) => record(200 + i)), cursor: '400' })
    .mockResolvedValueOnce({ records: Array.from({ length: 125 }, (_, i) => record(400 + i)) })
  const result = await listCollection({ contrail: { query } } as unknown as Indexer, 'skill', { limit: 1000 })
  expect(result.records).toHaveLength(525)
  expect(query.mock.calls[2]?.[1]).toMatchObject({ cursor: '400', limit: 600 })
  expect(result.cursor).toBeUndefined()
})
it('preserves the next-page cursor at the requested window boundary', async () => {
  const query = vi.fn()
    .mockResolvedValueOnce({ records: Array.from({ length: 200 }, (_, i) => record(i)), cursor: '200' })
    .mockResolvedValueOnce({ records: Array.from({ length: 50 }, (_, i) => record(200 + i)), cursor: '250' })
  const result = await listCollection({ contrail: { query } } as unknown as Indexer, 'skill', { did: 'did:plc:author', limit: 250 })
  expect(result.records).toHaveLength(250)
  expect(result.cursor).toBe('250')
  expect(query.mock.calls[1]?.[1]).toMatchObject({ did: 'did:plc:author', cursor: '200', limit: 50 })
})
it('continues a busy event window with its original range and sorting', async () => {
  const query = vi.fn().mockResolvedValueOnce({ records: [record(1)], cursor: 'next' }).mockResolvedValueOnce({ records: [record(2)] })
  const result = await eventsInWindow({ contrail: { query } } as unknown as Indexer, '2026-09-01', '2026-10-01', 500)
  expect(result).toHaveLength(2)
  expect(query.mock.calls[1]?.[1]).toMatchObject({ rangeFilters: { startsAt: { min: '2026-09-01', max: '2026-10-01' } }, sort: { recordField: 'startsAt', direction: 'asc' }, cursor: 'next' })
})
it('does not loop forever on a repeated collection cursor', async () => {
  const query = vi.fn().mockResolvedValue({ records: [], cursor: 'repeated' })
  await listCollection({ contrail: { query } } as unknown as Indexer, 'skill', { limit: 1000 })
  expect(query).toHaveBeenCalledTimes(2)
})

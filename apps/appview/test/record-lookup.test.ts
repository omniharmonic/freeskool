import { expect, it, vi } from 'vitest'
import { getRecordByUri } from '../src/index/queries.js'
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

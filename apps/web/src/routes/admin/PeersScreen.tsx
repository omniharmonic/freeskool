import { useState } from 'react';
import { AdminLayout } from './AdminLayout';
import { adminErrorSentence } from './adminErrors';
import { Button } from '../../components/bits';
import { usePeers, useSetPeersMutation } from '../../lib/queries';

const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/**
 * `/admin/peers` — the peer registry, which IS contrail's `relays` (see the
 * file header on `apps/appview/src/index/peers.ts`).
 *
 * TWO GAPS AGAINST THE REAL API, both left honest rather than faked:
 *   - "add by handle or DID or host URL" (the brief's words) — `PUT
 *     /api/admin/peers`'s `add` field is `z.array(z.string().url())`
 *     server-side: a bare handle or DID is refused with 400 `InvalidRequest`
 *     (which carries no `message`, just the code — `adminErrorSentence` in
 *     `./adminErrors.ts` maps it to a written sentence). There is no
 *     handle/DID → PDS-endpoint resolution exposed to this route. So this
 *     screen only accepts a host URL and says so, rather than accepting
 *     input that would just 400.
 *   - "show last sync" — there is no last-sync timestamp anywhere in the
 *     peer schema (`fs_peer` has no such column). The closest real signal is
 *     `probePeer()`'s live reachability check (`?probe=1`), shown here as
 *     "Reachable now" / "Not reachable" behind a "Check reachability"
 *     button, which is why it is opt-in rather than on every page load (it
 *     makes a live network request per peer, up to 5s each).
 */
export function PeersScreen() {
  const [probe, setProbe] = useState(false);
  const { data, isPending, isFetching } = usePeers(probe);
  const setPeersMutation = useSetPeersMutation();

  const [hostInput, setHostInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const peers = data?.peers ?? [];
  const probedByHost = new Map((data?.probed ?? []).map((p) => [p.host, p]));

  const onAdd = async () => {
    const value = hostInput.trim();
    if (!looksLikeUrl(value)) {
      setAddError('Peers are added by PDS host URL (e.g. https://pds.example.com) — not yet by handle or DID.');
      return;
    }
    setAddError(null);
    try {
      await setPeersMutation.mutateAsync({ add: [value] });
      setHostInput('');
    } catch (err) {
      setAddError(adminErrorSentence(err, 'Could not add that peer. Try again.'));
    }
  };

  const onRemove = async (host: string) => {
    setAddError(null);
    try {
      await setPeersMutation.mutateAsync({ remove: [host] });
    } catch (err) {
      setAddError(adminErrorSentence(err, 'Could not remove that peer. Try again.'));
    }
  };

  return (
    <AdminLayout title="Peers" current="peers" standfirst="Other PDS hosts this school's index reads from.">
      <div className="space-y-5">
        <div className="plate space-y-3 p-3.5">
          <label className="block">
            <span className="text-caption text-ink-soft">Add a peer by PDS host URL</span>
            <input
              className="mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
              value={hostInput}
              onChange={(e) => setHostInput(e.target.value)}
              placeholder="https://pds.example.com"
            />
          </label>
          {addError ? <p className="text-body text-pink">{addError}</p> : null}
          <Button onClick={() => void onAdd()} disabled={setPeersMutation.isPending || !hostInput.trim()}>
            Add peer
          </Button>
        </div>

        <section aria-labelledby="peers-list-heading">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <h2 id="peers-list-heading" className="text-lede font-bold">
              Registered peers
            </h2>
            <button
              type="button"
              className="text-caption font-bold text-blue disabled:opacity-40"
              disabled={isFetching}
              onClick={() => setProbe(true)}
            >
              {isFetching && probe ? 'Checking…' : 'Check reachability'}
            </button>
          </div>
          {isPending ? <p className="text-body text-ink-soft">Loading…</p> : null}
          {!isPending && peers.length === 0 ? <p className="text-body text-ink-soft">No peers registered yet.</p> : null}
          <ul className="divide-y divide-rule border-[1.5px] border-ink">
            {peers.map((p) => {
              const probed = probedByHost.get(p.host);
              return (
                <li key={p.host} className="flex items-center justify-between gap-3 px-3.5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-body">{p.host}</p>
                    <p className="text-caption text-ink-faint">
                      added via {p.source}
                      {probed ? ` — ${probed.listReposByCollection || probed.listRepos ? 'Reachable now' : 'Not reachable'}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 text-caption text-ink-faint"
                    aria-label={`Remove ${p.host}`}
                    onClick={() => void onRemove(p.host)}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </AdminLayout>
  );
}

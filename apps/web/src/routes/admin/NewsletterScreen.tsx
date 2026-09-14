import { useState } from 'react';
import { AdminLayout } from './AdminLayout';
import { Button } from '../../components/bits';
import { Sheet } from '../../components/Sheet';
import { ApiError } from '../../lib/api';
import { useComposeNewsletterMutation, useLastNewsletterIssue, useSendNewsletterMutation } from '../../lib/queries';
import type { NewsletterDraft } from '../../lib/types';

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** A read-only preview of the exact stored draft that will be sent. */
export function NewsletterScreen() {
  const composeMutation = useComposeNewsletterMutation();
  const sendMutation = useSendNewsletterMutation();
  const lastIssueQuery = useLastNewsletterIssue();
  const lastIssue = lastIssueQuery.data?.issue ?? null;

  const [period, setPeriod] = useState(thisMonth());
  const [draft, setDraft] = useState<NewsletterDraft | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sentCount, setSentCount] = useState<number | null>(null);

  const onCompose = async () => {
    setComposeError(null);
    setSentCount(null);
    setSendError(null);
    try {
      const result = await composeMutation.mutateAsync(period);
      setDraft(result);
    } catch (err) {
      setComposeError(err instanceof ApiError ? err.message : 'Could not compose a draft. Try again.');
    }
  };

  const onConfirmSend = async () => {
    if (!draft) return;
    setSendError(null);
    try {
      const result = await sendMutation.mutateAsync(draft.id);
      setSentCount(result.recipientCount);
      setConfirmOpen(false);
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not send the newsletter. Try again.');
      setConfirmOpen(false);
    }
  };

  return (
    <AdminLayout
      title="Newsletter"
      current="newsletter"
      standfirst="A monthly digest of listed classes — counts and dates only, never a roster."
      help="Free School writes this for you out of the month's listed classes — you are not composing anything by hand. Read the draft, then decide whether it goes out. Subscribers are never shown to you, before or after."
    >
      <div className="space-y-5">
        <div className="plate space-y-3 p-3.5">
          <label className="block">
            <span className="text-caption text-ink-soft">Month</span>
            <input
              type="month"
              className="mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </label>
          {composeError ? <p role="alert" className="text-body text-pink">{composeError}</p> : null}
          <Button onClick={() => void onCompose()} disabled={composeMutation.isPending || !/^\d{4}-\d{2}$/.test(period)}>
            Compose draft
          </Button>
        </div>

        {/* UX audit journey finding 14: Preview used to appear only AFTER "Compose
            draft", so the screen looked like a blank composer and said nothing about
            where the words come from. The section is always here; before there is a
            draft it says so. */}
        <section aria-labelledby="newsletter-preview-heading">
          <h2 id="newsletter-preview-heading" className="mb-2.5 text-lede font-bold">
            Preview
          </h2>
          {draft ? (
            <div className="plate space-y-3 p-3.5">
              <p className="text-body font-bold">{draft.subject}</p>
              <label className="block">
                <span className="text-caption text-ink-soft">
                  Review the digest before sending it to subscribers.
                </span>
                <textarea
                  className="mt-1.5 min-h-[180px] w-full resize-y border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
                  aria-label="Newsletter preview"
                  readOnly
                  value={draft.body}
                />
              </label>
            </div>
          ) : lastIssue ? (
            <div className="plate space-y-3 p-3.5">
              <p className="text-caption text-ink-soft">
                {lastIssue.status === 'sent' ? 'Last sent' : 'Last drafted, not yet sent'} — {lastIssue.month}
              </p>
              <label className="block">
                <span className="text-caption text-ink-soft">
                  The most recent newsletter. Pick a month above and choose “Compose draft” to write a new one.
                </span>
                <textarea
                  className="mt-1.5 min-h-[180px] w-full resize-y border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
                  aria-label="Last newsletter"
                  readOnly
                  value={lastIssue.text}
                />
              </label>
            </div>
          ) : (
            <div className="plate p-3.5">
              <p className="text-body text-ink-soft">Nothing to preview yet.</p>
              <p className="mt-1.5 text-caption text-ink-soft">
                Pick a month and choose “Compose draft”. Free School writes the digest from that month’s
                listed classes; you will read the whole thing here before anything is sent.
              </p>
            </div>
          )}
        </section>

        {draft ? (
          <>
            {sentCount !== null ? (
              <p role="status" className="text-body text-green">Sent — reached {sentCount} subscriber{sentCount === 1 ? '' : 's'}.</p>
            ) : null}
            {sendError ? <p role="alert" className="text-body text-pink">{sendError}</p> : null}

            <Button wide ink="blue" onClick={() => setConfirmOpen(true)} disabled={sendMutation.isPending || sentCount !== null}>
              Send to subscribers
            </Button>
          </>
        ) : null}
      </div>

      <Sheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Send this month's newsletter?"
        footer={
          <div className="flex gap-3 pb-1">
            <Button ink="blue" onClick={() => void onConfirmSend()} disabled={sendMutation.isPending}>
              Send
            </Button>
            <Button ink="ink" variant="quiet" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
          </div>
        }
      >
        <p className="text-body">
          This sends once to every currently-subscribed member. Free School never shows you who they are — only how
          many, after it's sent.
        </p>
      </Sheet>
    </AdminLayout>
  );
}

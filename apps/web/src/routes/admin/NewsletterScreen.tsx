import { useState } from 'react';
import { AdminLayout } from './AdminLayout';
import { Button } from '../../components/bits';
import { Sheet } from '../../components/Sheet';
import { ApiError } from '../../lib/api';
import { useComposeNewsletterMutation, useSendNewsletterMutation } from '../../lib/queries';
import type { NewsletterDraft } from '../../lib/types';

const thisMonth = () => new Date().toISOString().slice(0, 7);

/**
 * `/admin/newsletter` — compose this month's digest, then send it.
 *
 * EDITING IS PREVIEW-ONLY: `POST /api/admin/newsletter/:id/send` sends
 * exactly the row `composeNewsletterIssue` stored (`apps/appview/src/jobs/
 * newsletter.ts`) — there is no `PUT`/`PATCH` to persist an edited body back
 * onto the draft. So the textarea below lets a steward read the composed
 * text closely before deciding whether to send, but changes typed into it
 * are local only and are NOT what gets mailed. The copy under the field says
 * this rather than implying an edit-and-send flow the backend doesn't have.
 */
export function NewsletterScreen() {
  const composeMutation = useComposeNewsletterMutation();
  const sendMutation = useSendNewsletterMutation();

  const [period, setPeriod] = useState(thisMonth());
  const [draft, setDraft] = useState<NewsletterDraft | null>(null);
  const [previewText, setPreviewText] = useState('');
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
      setPreviewText(result.body);
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
    <AdminLayout title="Newsletter" current="newsletter" standfirst="A monthly digest of listed classes — counts and dates only, never a roster.">
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
          {composeError ? <p className="text-body text-pink">{composeError}</p> : null}
          <Button onClick={() => void onCompose()} disabled={composeMutation.isPending}>
            Compose draft
          </Button>
        </div>

        {draft ? (
          <>
            <section aria-labelledby="newsletter-preview-heading">
              <h2 id="newsletter-preview-heading" className="mb-2.5 text-lede font-bold">
                Preview
              </h2>
              <div className="plate space-y-3 p-3.5">
                <p className="text-body font-bold">{draft.subject}</p>
                <label className="block">
                  <span className="text-caption text-ink-soft">
                    Read it closely before sending — editing here does not change what gets mailed (there is no
                    save-edits endpoint yet).
                  </span>
                  <textarea
                    className="mt-1.5 min-h-[180px] w-full resize-y border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
                    value={previewText}
                    onChange={(e) => setPreviewText(e.target.value)}
                  />
                </label>
              </div>
            </section>

            {sentCount !== null ? (
              <p className="text-body text-green">Sent — reached {sentCount} subscriber{sentCount === 1 ? '' : 's'}.</p>
            ) : null}
            {sendError ? <p className="text-body text-pink">{sendError}</p> : null}

            <Button wide ink="blue" onClick={() => setConfirmOpen(true)} disabled={sendMutation.isPending}>
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

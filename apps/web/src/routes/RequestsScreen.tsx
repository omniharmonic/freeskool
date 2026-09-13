import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LoadingState, PageState } from '../components/PageState';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { Button, ThresholdRule } from '../components/bits';
import { SessionGate } from '../components/SessionGate';
import {
  useClaimRequestMutation,
  useCreateRequestMutation,
  useMe,
  useRequestRsvpMutation,
  useRequests,
  useSkillTree,
} from '../lib/queries';
import { ApiError } from '../lib/api';
import type { RequestItem, SkillNode } from '../lib/types';

function flattenSkills(nodes: SkillNode[], trail: string[] = []): Array<{ uri: string; path: string }> {
  const out: Array<{ uri: string; path: string }> = [];
  for (const node of nodes) {
    const path = [...trail, node.label];
    out.push({ uri: node.uri, path: path.join(' › ') });
    out.push(...flattenSkills(node.children, path));
  }
  return out;
}

export function RequestsScreen() {
  const { data: me } = useMe();
  const signedIn = Boolean(me);
  const { data, isPending, isError, refetch } = useRequests();
  const list = data?.requests ?? [];
  const [composing, setComposing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const rsvpMutation = useRequestRsvpMutation();
  const claimMutation = useClaimRequestMutation();
  const navigate = useNavigate();

  const onJoin = (request: RequestItem) => {
    setActionError(null);
    rsvpMutation.mutate(request.uri, {
      onError: (err) => {
        setActionError(err instanceof ApiError ? err.message : 'Could not update that. Try again.');
      },
    });
  };

  const onClaim = async (request: RequestItem) => {
    setActionError(null);
    try {
      await claimMutation.mutateAsync({ requestUri: request.uri, body: {} });
      void navigate({ to: '/events/new', search: { request: request.uri } });
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.code === 'ThresholdNotMet'
          ? err.message
          : 'Could not claim this request. Try again.',
      );
    }
  };

  return (
    <Screen
      title="Requests"
      layout="library"
      standfirst="Things people want to learn. When enough people want the same thing, someone turns up to teach it."
      trailing={
        signedIn ? (
          <button type="button" onClick={() => setComposing(true)} className="display text-caption font-bold text-pink">
            Ask for one
          </button>
        ) : null
      }
    >
      <div className="safe-x request-board">
        {isPending ? <LoadingState label="Opening the requests board…" /> : null}
        {isError ? <PageState title="The requests couldn’t load." error action={<Button onClick={() => void refetch()}>Try again</Button>} /> : null}
        {!isPending && !isError && list.length === 0 ? (
          <div className="request-note">
            <p className="text-body">Post what you'd like to learn. Someone nearby probably knows it.</p>
          </div>
        ) : null}

        {list.map((request) => {
          const mine = request.viewerInterested;
          const count = request.rsvpCount;
          return (
            <article key={request.uri} className="request-note">
              <div className="flex items-start justify-between gap-3">
                <h2 className="flex-1 text-lede leading-snug">{request.title}</h2>
                {request.status !== 'open' ? (
                  <span className="request-status">
                    {request.status === 'scheduled' ? 'On the calendar' : 'Teacher found'}
                  </span>
                ) : null}
              </div>
              {request.description ? (
                <p className="mt-1.5 max-w-[58ch] text-body text-ink-soft">{request.description}</p>
              ) : null}

              {typeof request.threshold === 'number' ? (
                <div className="mt-3.5">
                  <ThresholdRule count={count} threshold={request.threshold} />
                </div>
              ) : null}

              {request.scheduledEventUri ? <a href={`/events/${encodeURIComponent(request.scheduledEventUri)}`} className="primary-action mt-4">See the class</a> : null}
              {signedIn ? (
                <div className="request-note-actions">
                  <Button ink={mine ? 'green' : 'amber'} onClick={() => onJoin(request)}>
                    {mine ? "You're counted in" : 'I want this too'}
                  </Button>
                  {request.status === 'claimed' && request.viewerClaimed ? <a href={`/events/new?request=${encodeURIComponent(request.uri)}`} className="primary-action">Finish posting your class</a> : null}
                  {request.status === 'open' ? (
                    <Button ink="ink" variant="quiet" onClick={() => void onClaim(request)}>
                      I can teach this
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3.5 text-caption text-ink-soft">
                  <a href="/signin" className="font-bold text-blue">
                    Sign in
                  </a>{' '}
                  to join or offer to teach this.
                </p>
              )}
            </article>
          );
        })}
        {actionError ? <p role="alert" className="text-body text-pink">{actionError}</p> : null}
      </div>

      <ComposerSheet open={composing} onClose={() => setComposing(false)} />
    </Screen>
  );
}

function ComposerSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: skillTree } = useSkillTree();
  const flatSkills = flattenSkills(skillTree?.skills ?? []);
  const createMutation = useCreateRequestMutation();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [skillUri, setSkillUri] = useState('');
  const [sent, setSent] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitError(null);
    try {
      await createMutation.mutateAsync({
        title: title.trim(),
        description: description.trim() || undefined,
        skill: skillUri || undefined,
      });
      setSent(true);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Could not post this request. Try again.');
    }
  };

  const close = () => {
    setSent(false);
    setSubmitError(null);
    setTitle('');
    setDescription('');
    setSkillUri('');
    onClose();
  };

  const field =
    'mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none focus-visible:outline-2';

  return (
    <Sheet
      open={open}
      onClose={close}
      title={sent ? 'Asked' : 'Ask for a class'}
      footer={
        sent ? (
          <Button wide ink="green" onClick={close}>
            Done
          </Button>
        ) : (
          <Button wide onClick={() => void submit()} disabled={title.trim().length < 4}>
            Post this request
          </Button>
        )
      }
    >
      {sent ? (
        <p className="text-body">
          It's on the board. You'll see it fill up on the Requests tab, and you'll hear when someone offers to
          teach it.
        </p>
      ) : (
        <SessionGate prompt="Sign in to ask for a class.">
          <p className="text-body text-ink-soft">
            Say what you want to learn in your own words. Other people add themselves, and at five or six
            someone usually volunteers.
          </p>
          <label className="mt-4 block">
            <span className="text-caption text-ink-soft">What do you want to learn?</span>
            <input
              className={field}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Someone teach me to sharpen things properly"
            />
          </label>
          <label className="mt-4 block">
            <span className="text-caption text-ink-soft">Anything that would help a teacher say yes</span>
            <textarea
              className={`${field} min-h-[96px] resize-none`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What you've already tried, what you own, when you're free."
            />
          </label>
          {submitError ? <p className="mt-3 text-body text-pink">{submitError}</p> : null}
          <label className="mt-4 block">
            <span className="text-caption text-ink-soft">Closest skill</span>
            <select className={field} value={skillUri} onChange={(event) => setSkillUri(event.target.value)}>
              <option value="">No specific skill</option>
              {flatSkills.map((skill) => (
                <option key={skill.uri} value={skill.uri}>
                  {skill.path}
                </option>
              ))}
            </select>
          </label>
        </SessionGate>
      )}
    </Sheet>
  );
}

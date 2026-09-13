import { useState } from 'react';
import { requests as mockRequests, skills, USE_MOCK, type LearningRequest } from '../lib/mock';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { Button, SkillChip, ThresholdRule } from '../components/bits';
import { api } from '../lib/api';

// Not wired to `useRequests` yet (Task 6) — real data defaults to empty
// rather than showing the mock board once USE_MOCK is off.
const seed: LearningRequest[] = USE_MOCK ? mockRequests : [];

export function RequestsScreen() {
  const [list, setList] = useState<LearningRequest[]>(seed);
  const [composing, setComposing] = useState(false);
  const [joined, setJoined] = useState<Set<string>>(new Set());

  const onJoin = (request: LearningRequest) => {
    setJoined((previous) => {
      const next = new Set(previous);
      if (next.has(request.uri)) next.delete(request.uri);
      else next.add(request.uri);
      return next;
    });
    void api.requests.rsvp(request.uri).catch(() => undefined);
  };

  const onClaim = async (request: LearningRequest) => {
    setList((previous) =>
      previous.map((candidate) =>
        candidate.uri === request.uri ? { ...candidate, status: 'claimed', claimedBy: 'You' } : candidate,
      ),
    );
    await api.requests.claim(request.uri, {}).catch(() => undefined);
  };

  return (
    <Screen
      title="Requests"
      standfirst="Things people want to learn. When enough people want the same thing, someone turns up to teach it."
      trailing={
        <button type="button" onClick={() => setComposing(true)} className="display text-caption font-bold text-pink">
          Ask for one
        </button>
      }
    >
      <div className="safe-x mt-4 space-y-4">
        {list.map((request) => {
          const mine = joined.has(request.uri);
          const count = request.rsvpCount + (mine ? 1 : 0);
          return (
            <article key={request.uri} className="plate plate-amber p-4">
              <div className="flex items-start justify-between gap-3">
                <h2 className="flex-1 text-lede leading-snug">{request.title}</h2>
                {request.status !== 'open' ? (
                  <SkillChip ink={request.status === 'scheduled' ? 'blue' : 'pink'}>
                    {request.status === 'scheduled' ? 'on the calendar' : 'teacher found'}
                  </SkillChip>
                ) : null}
              </div>
              <p className="mt-1.5 max-w-[58ch] text-body text-ink-soft">{request.description}</p>

              <div className="mt-3.5">
                <ThresholdRule count={count} threshold={request.threshold} />
              </div>

              {request.claimedBy ? (
                <p className="mt-2.5 text-caption">
                  {request.claimedBy} offered to teach this.
                </p>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-3">
                <Button ink={mine ? 'green' : 'amber'} onClick={() => onJoin(request)}>
                  {mine ? "You're counted in" : 'I want this too'}
                </Button>
                {request.status === 'open' ? (
                  <Button ink="ink" variant="quiet" onClick={() => void onClaim(request)}>
                    I can teach this
                  </Button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <ComposerSheet open={composing} onClose={() => setComposing(false)} />
    </Screen>
  );
}

const skillOptions = USE_MOCK ? skills : [];

function ComposerSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [skillId, setSkillId] = useState(skillOptions[0]?.id ?? '');
  const [sent, setSent] = useState(false);

  const submit = async () => {
    await api.requests.create({ title, description, skill: skillId || undefined }).catch(() => undefined);
    setSent(true);
  };

  const close = () => {
    setSent(false);
    setTitle('');
    setDescription('');
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
        <>
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
          <label className="mt-4 block">
            <span className="text-caption text-ink-soft">Closest skill</span>
            <select className={field} value={skillId} onChange={(event) => setSkillId(event.target.value)}>
              {skillOptions.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </Sheet>
  );
}

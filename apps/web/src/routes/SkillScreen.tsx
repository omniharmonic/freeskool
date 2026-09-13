import { Link, useParams } from '@tanstack/react-router';
import { events, requests, resources, skills } from '../lib/mock';
import { Screen } from '../components/Screen';
import { EventCard } from '../components/EventCard';
import { Button, SkillChip, ThresholdRule } from '../components/bits';

export function SkillScreen() {
  const { skillId } = useParams({ from: '/skills/$skillId' });
  const skill = skills.find((candidate) => candidate.id === skillId);

  if (!skill) {
    return (
      <Screen title="Skill not found" back>
        <div className="safe-x">
          <p className="text-body text-ink-soft">Nothing is filed under that name yet.</p>
          <div className="mt-4">
            <Button href="/skills" ink="blue">
              Browse all skills
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  const upcoming = events.filter((event) => event.skill.id === skill.id);
  const open = requests.filter((request) => request.skill.id === skill.id && request.status !== 'scheduled');
  const links = resources[skill.id] ?? [];

  return (
    <Screen title={skill.label} back>
      <div className="safe-x">
        <p className="max-w-[60ch] text-body">{skill.description}</p>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="plate plate-pink px-3.5 py-3">
            <p className="stamp text-[26px] leading-none">{skill.practitionerCount}</p>
            <p className="mt-1 text-caption text-ink-soft">people practise this</p>
          </div>
          <div className="plate plate-green px-3.5 py-3">
            <p className="stamp text-[26px] leading-none">{upcoming.length}</p>
            <p className="mt-1 text-caption text-ink-soft">classes on the calendar</p>
          </div>
        </div>

        {skill.tier === 'B' ? (
          <p className="mt-4 border-l-[3px] border-amber pl-3 text-caption text-ink-soft">
            This skill is kept off the public taxonomy by default. People who claim it choose whether that
            claim is visible.
          </p>
        ) : null}
      </div>

      {upcoming.length > 0 ? (
        <>
          <h2 className="safe-x mt-7 mb-2.5 text-lede font-bold">Coming up</h2>
          <div className="safe-x space-y-4">
            {upcoming.map((event) => (
              <EventCard key={event.uri} event={event} />
            ))}
          </div>
        </>
      ) : (
        <div className="safe-x mt-7">
          <div className="plate plate-amber p-4">
            <p className="text-body">Nobody has put this on the calendar yet.</p>
            <p className="mt-1 text-caption text-ink-soft">
              Ask for it and we'll find a teacher, or offer to teach it yourself.
            </p>
            <div className="mt-3.5">
              <Button href="/requests" ink="amber">
                Ask for this class
              </Button>
            </div>
          </div>
        </div>
      )}

      {open.length > 0 ? (
        <>
          <h2 className="safe-x mt-7 mb-2.5 text-lede font-bold">People waiting</h2>
          <div className="safe-x space-y-3">
            {open.map((request) => (
              <Link key={request.uri} to="/requests" className="plate plate-amber block p-3.5">
                <p className="text-body">{request.title}</p>
                <div className="mt-3">
                  <ThresholdRule count={request.rsvpCount} threshold={request.threshold} />
                </div>
              </Link>
            ))}
          </div>
        </>
      ) : null}

      {links.length > 0 ? (
        <>
          <h2 className="safe-x mt-7 mb-2.5 text-lede font-bold">Things to read and borrow</h2>
          <ul className="safe-x space-y-3">
            {links.map((resource) => (
              <li key={resource.uri} className="plate plate-blue p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-body">{resource.title}</p>
                  <SkillChip ink="blue">{resource.kind.replace('-', ' ')}</SkillChip>
                </div>
                <p className="mt-1 text-caption text-ink-soft">{resource.note}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Screen>
  );
}

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { areas, domains, skills, USE_MOCK } from '../lib/mock';
import { Screen } from '../components/Screen';

// Not wired to `useSkillTree` yet (Task 6) — real data defaults to empty
// rather than showing the mock taxonomy once USE_MOCK is off.
const domainPool = USE_MOCK ? domains : [];
const areaPool = USE_MOCK ? areas : {};
const skillPool = USE_MOCK ? skills : [];

export function SkillsScreen() {
  const [open, setOpen] = useState<string | null>(domainPool[0]?.id ?? null);

  return (
    <Screen
      title="Skills"
      standfirst="Everything anyone here has offered to teach, filed the way people actually talk about it."
    >
      <div className="safe-x mt-4 space-y-4">
        {domainPool.map((domain) => {
          const expanded = open === domain.id;
          return (
            <section key={domain.id} className="plate plate-blue overflow-hidden">
              <button
                type="button"
                className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : domain.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="display block text-lede font-bold">{domain.label}</span>
                  <span className="mt-0.5 block text-caption text-ink-soft">{domain.blurb}</span>
                </span>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                  className="mt-1.5 shrink-0 text-ink-faint"
                  style={{ rotate: expanded ? '90deg' : '0deg', transition: 'rotate 160ms ease-out' }}
                >
                  <path d="M4 1l7 6-7 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>

              {expanded ? (
                <div className="border-t-[1.5px] border-rule">
                  {domain.areas.map((areaId) => {
                    const area = areaPool[areaId];
                    if (!area) return null;
                    return (
                      <div key={areaId} className="border-b-[1.5px] border-rule px-4 py-3 last:border-b-0">
                        <p className="stamp text-[13px] text-ink-soft">{area.label}</p>
                        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                          {[...new Set(area.skills)].map((skillId) => {
                            const skill = skillPool.find((candidate) => candidate.id === skillId);
                            if (!skill) return null;
                            return (
                              <li key={skillId}>
                                <Link
                                  to="/skills/$skillId"
                                  params={{ skillId }}
                                  className="inline-flex items-baseline gap-1.5"
                                >
                                  <span className="text-body underline decoration-[1.5px] decoration-pink underline-offset-[5px]">
                                    {skill.label}
                                  </span>
                                  <span className="text-caption text-ink-faint">{skill.practitionerCount}</span>
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        })}
        <p className="pt-2 text-caption text-ink-soft">
          The number beside a skill is how many people here say they practise it. Some skills are kept off the
          public taxonomy until the people who asked for them say otherwise.
        </p>
      </div>
    </Screen>
  );
}

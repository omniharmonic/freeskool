import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { useSkillTree } from '../lib/queries';
import type { SkillNode } from '../lib/types';

/**
 * The taxonomy is a tree here (one root level, each expandable), but
 * `GET /api/skills` has no notion of "domain"/"area" groupings the way the
 * mock data did — those were presentational buckets invented for the shell.
 * Real skill nodes nest directly (`children`), so roots are rendered as the
 * expandable sections and their children as the flat list beneath.
 *
 * TIER: `GET /api/skills` does not expose a Tier A/B marker at all (the tier
 * table — `apps/appview/src/lib/skill-tiers.ts` — is looked up server-side
 * only, from `PUT /api/me/skill-claims`). There is therefore no sensitive/
 * "kept off the public taxonomy" badge to show here without guessing at a
 * skill's tier client-side, which the brief is explicit about never doing.
 * See the Task 6 report for this gap.
 */
export function SkillsScreen() {
  const { data, isPending } = useSkillTree();
  const roots = data?.skills ?? [];
  const [open, setOpen] = useState<string | null>(null);

  // Open the first domain once the tree loads, rather than landing on an
  // all-collapsed screen — only while nothing has been explicitly chosen yet.
  useEffect(() => {
    if (open === null && roots.length > 0) setOpen(roots[0]!.uri);
  }, [open, roots]);

  return (
    <Screen
      title="Skills"
      standfirst="Everything anyone here has offered to teach, filed the way people actually talk about it."
    >
      <div className="safe-x mt-4 space-y-4">
        {!isPending && roots.length === 0 ? (
          <p className="text-body text-ink-soft">Nothing is filed in the taxonomy yet.</p>
        ) : null}

        {roots.map((domain) => {
          const expanded = open === domain.uri;
          return (
            <section key={domain.uri} className="plate plate-blue overflow-hidden">
              <button
                type="button"
                className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? '' : domain.uri)}
              >
                <span className="min-w-0 flex-1">
                  <span className="display block text-lede font-bold">{domain.label}</span>
                  {domain.description ? (
                    <span className="mt-0.5 block text-caption text-ink-soft">{domain.description}</span>
                  ) : null}
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
                  <SkillChildren node={domain} />
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </Screen>
  );
}

/** One level of a skill's `children`, grouped by that child's own children
 * (so a two-deep taxonomy reads as "area, then skills" the way the mock did). */
function SkillChildren({ node }: { node: SkillNode }) {
  if (node.children.length === 0) {
    return (
      <div className="px-4 py-3">
        <SkillLink skill={node} />
      </div>
    );
  }
  return (
    <>
      {node.children.map((area) => (
        <div key={area.uri} className="border-b-[1.5px] border-rule px-4 py-3 last:border-b-0">
          <p className="stamp text-[13px] text-ink-soft">{area.label}</p>
          {area.children.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
              {area.children.map((skill) => (
                <li key={skill.uri}>
                  <SkillLink skill={skill} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-2">
              <SkillLink skill={area} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function SkillLink({ skill }: { skill: SkillNode }) {
  return (
    <Link to="/skills/$skillId" params={{ skillId: skill.uri }} className="inline-flex items-baseline gap-1.5">
      <span className="text-body underline decoration-[1.5px] decoration-pink underline-offset-[5px]">
        {skill.label}
      </span>
    </Link>
  );
}

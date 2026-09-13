import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { SkillChip } from '../components/bits';
import { FieldGlyph } from '../components/FieldGlyph';
import { LoadingState, PageState } from '../components/PageState';
import { useSkillTree } from '../lib/queries';
import type { SkillNode } from '../lib/types';

function flatten(nodes: SkillNode[], trail: string[] = []): Array<{ skill: SkillNode; path: string }> {
  return nodes.flatMap(skill => [{ skill, path: trail.join(' / ') }, ...flatten(skill.children, [...trail, skill.label])]);
}

export function SkillsScreen() {
  const { data, isPending, isError, refetch } = useSkillTree();
  const roots = data?.skills ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const allSkills = useMemo(() => flatten(roots), [data]);
  const matches = allSkills.filter(({ skill, path }) => `${skill.label} ${path} ${skill.description ?? ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  useEffect(() => { if (open === null && roots.length) setOpen(roots[0]!.uri); }, [open, roots]);

  return <Screen title="Skills" layout="library" standfirst="Useful things to know. Find something you’re curious about, or something you could pass on.">
    <div className="safe-x"><nav className="library-nav"><Link to="/skills" aria-current="page">Skills</Link><Link to="/knowledge">Knowledge</Link></nav>
      <div className="library-toolbar">
        <label className="library-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search skills" placeholder="What would you like to learn?" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <p className="library-count" aria-live="polite">{isPending ? 'Opening the library…' : search ? `${matches.length} matching skills` : `${allSkills.length} skills to explore`}</p>
      </div>
      {isPending ? <LoadingState label="Opening the skill library…" /> : null}
      {isError ? <PageState title="The skill library couldn’t load." error action={<button className="primary-action" onClick={() => void refetch()}>Try again</button>}>Check your connection and try again.</PageState> : null}
      {!isPending && !isError && !roots.length ? <PageState title="A library waiting to grow." action={<Link to="/requests" className="context-link">Ask for something you’d like to learn</Link>}>Nothing is filed in the taxonomy yet.</PageState> : null}
      {search ? <div className="skill-results">{matches.map(({ skill, path }) => <div className="skill-result" key={skill.uri}>{path ? <small>{path}</small> : null}<SkillLink skill={skill} /></div>)}{!matches.length && !isPending && !isError ? <PageState title="No skills match that search.">Try a broader word, or ask for a class on the requests board.</PageState> : null}</div> :
        <div className="skill-directory">{roots.map(domain => <section className="skill-folder" key={domain.uri} data-open={open === domain.uri}>
          <button className="skill-folder-button" type="button" aria-expanded={open === domain.uri} onClick={() => setOpen(open === domain.uri ? '' : domain.uri)}>
            <FieldGlyph seed={domain.id} /><span className="min-w-0"><span className="skill-folder-title">{domain.label}</span>{domain.description ? <span className="skill-folder-description">{domain.description}</span> : null}</span><span className="skill-folder-symbol" aria-hidden="true">{open === domain.uri ? '−' : '+'}</span>
          </button>
          {open === domain.uri ? <div className="skill-children"><SkillChildren node={domain} /></div> : null}
        </section>)}</div>}
      <div className="page-note mt-8">You don’t need to be an expert to share a skill. Being honest about what you know is a good place to start.</div>
    </div>
  </Screen>;
}

function SkillChildren({ node }: { node: SkillNode }) {
  if (!node.children.length) return <div className="skill-area"><SkillLink skill={node} /></div>;
  return <>{node.children.map(area => <div key={area.uri} className="skill-area">
    {area.children.length ? <><p className="skill-area-title"><Link to="/skills/$skillId" params={{ skillId: area.uri }}>{area.label}</Link></p><div className="skill-links">{flatten(area.children).map(({ skill }) => <SkillLink key={skill.uri} skill={skill} />)}</div></> : <SkillLink skill={area} />}
  </div>)}</>;
}

function SkillLink({ skill }: { skill: SkillNode }) {
  return <Link to="/skills/$skillId" params={{ skillId: skill.uri }} className="skill-link"><span>{skill.label}</span>{skill.tier === 'B' ? <SkillChip ink="pink">Sensitive</SkillChip> : null}</Link>;
}

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { api } from '../lib/api';
import { useMe, useSkillTree } from '../lib/queries';
import type { SkillNode } from '../lib/types';
import { Screen } from '../components/Screen';
import { PageState, LoadingState } from '../components/PageState';
import { ResourceCard } from '../components/KnowledgeShelf';
import { SessionGate } from '../components/SessionGate';

export function flattenTaxonomy(nodes: SkillNode[]): SkillNode[] {
  return nodes.flatMap((n) => [n, ...flattenTaxonomy(n.children)]);
}
export function KnowledgeScreen() {
  const [search, setSearch] = useState('');
  const { data: me } = useMe();
  const [mine, setMine] = useState(
    () => ['1','true'].includes(new URLSearchParams(window.location.search).get('mine') ?? ''),
  );
  const own = mine && Boolean(me);
  useEffect(()=>{const query=new URLSearchParams(window.location.search);if(mine)query.set('mine','true');else query.delete('mine');window.history.replaceState(window.history.state,'',`${window.location.pathname}${query.size?'?'+query:''}`);},[mine]);
  const { data: tree } = useSkillTree();
  const skills = flattenTaxonomy(tree?.skills ?? []);
  const query = useQuery({
    queryKey: ['resources', { owner: own ? me?.did : null }],
    queryFn: () => (own ? api.knowledge.mine() : api.knowledge.list()),
  });
  const resources =
    query.data?.resources.filter((r) =>
      `${r.title} ${r.description ?? ''} ${r.skills.map((uri) => skills.find((s) => s.uri === uri)?.label ?? '').join(' ')}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
    ) ?? [];
  return (
    <Screen
      title="The shared notebook"
      layout="library"
      standfirst="What we learn belongs in circulation. Field notes, good reading, and practical guides from people sharing their skills."
    >
      <div className="safe-x">
        <nav className="library-nav">
          <Link to="/skills">Skills</Link>
          <Link to="/knowledge" aria-current="page">
            Knowledge
          </Link>
        </nav>
        {me ? (
          <div
            className="view-switch knowledge-view-switch"
            role="group"
            aria-label="Knowledge view"
          >
            <button aria-pressed={!own} onClick={() => setMine(false)}>
              Community library
            </button>
            <button aria-pressed={own} onClick={() => setMine(true)}>
              My contributions
            </button>
          </div>
        ) : null}
        <div className="section-title-row">
          <label className="library-search">
            Find something useful
            <input
              type="search"
              aria-label="Search knowledge"
              placeholder="Try a skill, a topic, a question…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <Link to="/knowledge/new" className="primary-action">
            Share a resource ＋
          </Link>
        </div>
        {query.isPending ? (
          <LoadingState label="Opening the shared notebook…" />
        ) : query.isError ? (
          <PageState
            title="The notebook couldn’t load."
            error
            action={
              <button onClick={() => void query.refetch()}>Try again</button>
            }
          >
            Your connection may have dropped.
          </PageState>
        ) : resources.length ? (
          <div className="resource-grid">
            {resources.map((r) => (
              <ResourceCard key={r.id} resource={r} />
            ))}
          </div>
        ) : (
          <div className="library-empty">
            <h2>
              {search
                ? 'No matching resources.'
                : own
                  ? 'Your first contribution starts here.'
                  : 'A notebook waiting to be filled.'}
            </h2>
            <p>
              {search
                ? 'Try another topic or a shorter search.'
                : 'Share a small thing that made learning easier. Someone else will be glad you did.'}
            </p>
          </div>
        )}
      </div>
    </Screen>
  );
}
export function ResourceScreen() {
  const { id } = useParams({ from: '/knowledge/$id' });
  const query = useQuery({
    queryKey: ['resource', id],
    queryFn: () => api.knowledge.get(id),
  });
  const { data: me } = useMe();
  const { data: tree } = useSkillTree();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.knowledge.remove(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['resources'] });
      void client.invalidateQueries({ queryKey: ['public-profile'] });
      client.removeQueries({ queryKey: ['resource', id] });
      void navigate({ to: '/knowledge', search: { mine: true } });
    },
  });
  if (query.isPending)
    return (
      <Screen title="Opening resource" back>
        <LoadingState label="Finding the notes…" />
      </Screen>
    );
  if (query.isError || !query.data)
    return (
      <Screen title="Resource unavailable" back>
        <PageState
          title="We couldn’t open this resource."
          action={<Link to="/knowledge">Browse the library</Link>}
        >
          It may have been removed, or your connection may have dropped.{' '}
          <button onClick={() => void query.refetch()}>Try again</button>
        </PageState>
      </Screen>
    );
  const r = query.data,
    skills = flattenTaxonomy(tree?.skills ?? []);
  return (
    <Screen title={r.title} layout="reading" back>
      <div className="safe-x resource-reading">
        <ResourceNotice status={r.libraryStatus} />
        <p className="eyebrow">
          {r.uri ? 'Reading & resources' : 'Community field notes'}
        </p>
        <div className="resource-byline">
          Shared by{' '}
          {r.authorHasProfile ? (
            <Link to="/people/$did" params={{ did: r.authorDid }}>
              {r.authorName}
            </Link>
          ) : (
            r.authorName
          )}
          {r.createdAt ? (
            <span> · {new Date(r.createdAt).toLocaleDateString()}</span>
          ) : null}
        </div>
        {r.description ? (
          <p className="event-description">{r.description}</p>
        ) : null}
        {r.uri ? (
          <a
            href={r.uri}
            target="_blank"
            rel="noopener noreferrer"
            className="primary-action"
          >
            Open resource ↗
          </a>
        ) : null}
        <section className="knowledge-shelf">
          <h2>Filed under</h2>
          <div className="skill-links">
            {r.skills.map((uri) => (
              <Link
                to="/skills/$skillId"
                params={{ skillId: uri }}
                key={uri}
                className="skill-link"
              >
                {skills.find((s) => s.uri === uri)?.label ??
                  'Explore this skill'}
              </Link>
            ))}
          </div>
        </section>
        {r.event ? (
          <Link
            to="/events/$id"
            params={{ id: r.event.uri }}
            className="context-link"
          >
            From this class ↗
          </Link>
        ) : null}
        {r.license ? (
          <p className="text-caption text-ink-soft mt-5">
            License: {r.license}
          </p>
        ) : null}
        {me?.did === r.authorDid ? (
          <section className="resource-management">
            {me.did === r.authorDid ? (
              <Link
                to="/knowledge/$id/edit"
                params={{ id: r.id }}
                className="context-link"
              >
                Edit these notes ↗
              </Link>
            ) : null}
            {confirm ? (
              <>
                <p>Remove this resource from your public records?</p>
                <button
                  className="fs-button fs-button-quiet"
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                >
                  Confirm removal
                </button>
                <button onClick={() => setConfirm(false)}>Keep it</button>
              </>
            ) : (
              <button className="context-link" onClick={() => setConfirm(true)}>
                Remove my resource
              </button>
            )}
            {remove.isError ? (
              <p role="alert">Could not remove the resource. Try again.</p>
            ) : null}
          </section>
        ) : null}
        {me && me.role >= 40 ? (
          <Link
            to="/admin/moderation"
            search={{ action: 'remove-resource', subject: r.id }}
            className="context-link"
          >
            Request moderation review ↗
          </Link>
        ) : null}
      </div>
    </Screen>
  );
}
export function NewResourceScreen() {
  return (
    <SessionGate screen prompt="Sign in to share what you’ve learned.">
      <ResourceForm />
    </SessionGate>
  );
}
export function EditResourceScreen() {
  const { id } = useParams({ from: '/knowledge/$id/edit' });
  return (
    <SessionGate screen prompt="Sign in to edit your resource.">
      <ResourceForm editId={id} />
    </SessionGate>
  );
}
function ResourceForm({ editId }: { editId?: string }) {
  const { data: me } = useMe();
  const { data: tree, isPending, isError, refetch } = useSkillTree();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [uri, setUri] = useState(''),
    [skill, setSkill] = useState(
      () => new URLSearchParams(window.location.search).get('skill') ?? '',
    ),
    [consent, setConsent] = useState(false);
  const hydrated = useRef<string | undefined>(undefined);
  const [additionalSkills, setAdditionalSkills] = useState<string[]>([]);
  const [license, setLicense] = useState('');
  const [eventId, setEventId] = useState(
    () => new URLSearchParams(window.location.search).get('event') ?? '',
  );
  const event = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => api.events.get(eventId),
    enabled: Boolean(eventId),
  });
  const existing = useQuery({
    queryKey: ['resource', editId],
    queryFn: () => api.knowledge.get(editId!),
    enabled: Boolean(editId),
  });
  useEffect(() => {
    const r = existing.data;
    if (r && hydrated.current !== r.id) {
      hydrated.current = r.id;
      setAdditionalSkills(r.skills.slice(1));
      setLicense(r.license ?? '');
      setTitle(r.title);
      setDescription(r.description ?? '');
      setUri(r.uri ?? '');
      setSkill(r.skills[0] ?? '');
      setEventId(r.event?.uri ?? '');
      setConsent(true);
    }
  }, [existing.data]);
  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        description: description.trim(),
        skills: [...new Set([skill, ...additionalSkills])],
        ...(uri.trim() ? { uri: uri.trim() } : {}),
        ...(license.trim() ? { license: license.trim() } : {}),
        ...(eventId ? { event: { uri: eventId, cid: '' } } : {}),
      };
      return editId
        ? api.knowledge.update(editId, body)
        : api.knowledge.create(body);
    },
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['resources'] });
      void client.invalidateQueries({ queryKey: ['public-profile'] });
      void client.invalidateQueries({ queryKey: ['resource', result.id] });
      void navigate({ to: '/knowledge/$id', params: { id: result.id } });
    },
  });
  return (
    <Screen
      title={editId ? 'Edit your resource' : 'Leave something useful'}
      layout="form"
      back
      standfirst="Share a field note, a guide, or a link. Connect it to a skill so the next person can find it."
    >
      <div className="safe-x">
        {editId && existing.isPending ? (
          <LoadingState label="Opening your notes…" />
        ) : editId &&
          (existing.isError || existing.data?.authorDid !== me?.did) ? (
          <PageState title="These notes can’t be edited here.">
            Only their contributor can edit them.
          </PageState>
        ) : me && ((me.role < 20 && !editId) || me.kind === 'oauth') ? (
          <PageState
            title="Resource sharing opens with hosting."
            action={<Link to="/me">Your notebook</Link>}
          >
            This account can browse the library. Publishing becomes available
            when hosting is enabled for your account and sign-in method.
          </PageState>
        ) : (
          <form
            className="resource-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (consent) mutation.mutate();
            }}
          >
            <label>
              Title
              <input
                required
                maxLength={160}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="A small guide to getting started"
              />
            </label>
            <label>
              Skill
              <select
                aria-label="Skill"
                required
                value={skill}
                onChange={(e) => setSkill(e.target.value)}
                disabled={isPending || isError}
              >
                <option value="">Choose a skill</option>
                {flattenTaxonomy(tree?.skills ?? []).map((s) => (
                  <option key={s.uri} value={s.uri}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {additionalSkills.map((selected, index) => (
              <div className="resource-extra-skill" key={index}>
                <label>
                  Additional skill {index + 1}
                  <select
                    aria-label={`Additional skill ${index + 1}`}
                    required
                    value={selected}
                    onChange={(e) =>
                      setAdditionalSkills((items) =>
                        items.map((item, i) =>
                          i === index ? e.target.value : item,
                        ),
                      )
                    }
                  >
                    <option value="">Choose a skill</option>
                    {flattenTaxonomy(tree?.skills ?? []).map((s) => (
                      <option
                        key={s.uri}
                        value={s.uri}
                        disabled={
                          s.uri === skill ||
                          (additionalSkills.includes(s.uri) &&
                            s.uri !== selected)
                        }
                      >
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="context-link"
                  aria-label={`Remove additional skill ${index + 1}`}
                  onClick={() =>
                    setAdditionalSkills((items) =>
                      items.filter((_, i) => i !== index),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            {additionalSkills.length < 7 ? (
              <button
                type="button"
                className="context-link"
                onClick={() => setAdditionalSkills((items) => [...items, ''])}
              >
                Link another skill ＋
              </button>
            ) : null}
            {isError ? (
              <p role="alert">
                Skills couldn’t load.{' '}
                <button type="button" onClick={() => void refetch()}>
                  Try again
                </button>
              </p>
            ) : null}
            <label>
              Field notes
              <textarea
                maxLength={1000}
                required={!uri.trim()}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={7}
                placeholder="What helped? What should someone know before they begin?"
              />
              <span>{description.length}/1000</span>
            </label>
            <label>
              Resource link (optional)
              <input
                type="url"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder="https://…"
              />
            </label>
            <label>
              License (optional)
              <input
                maxLength={40}
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                placeholder="For example, CC-BY-SA-4.0"
              />
            </label>
            {existing.data?.libraryStatus ? (
              <ResourceNotice status={existing.data.libraryStatus} />
            ) : null}
            {eventId ? (
              <div className="resource-context">
                <p>
                  Linked class:{' '}
                  {event.data?.name ??
                    (event.isError ? 'Class unavailable' : 'Loading class…')}
                </p>
                <button
                  type="button"
                  className="context-link"
                  onClick={() => setEventId('')}
                >
                  Detach from this class
                </button>
              </div>
            ) : null}
            <label className="resource-consent">
              <input
                type="checkbox"
                required
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                Publish this resource publicly under my account. I have
                permission to share this content.
              </span>
            </label>
            {mutation.isError ? (
              <p role="alert">{mutation.error.message}</p>
            ) : null}
            <button
              className="primary-action"
              disabled={
                !consent ||
                !skill ||
                additionalSkills.some((s) => !s) ||
                mutation.isPending ||
                isPending ||
                isError
              }
            >
              {' '}
              {mutation.isPending
                ? 'Saving…'
                : editId
                  ? 'Save changes'
                  : 'Share with the community ↗'}
            </button>
          </form>
        )}
      </div>
    </Screen>
  );
}
export function PublicProfileScreen() {
  useEffect(() => {
    const tag = document.createElement('meta');
    tag.name = 'robots';
    tag.content = 'noindex, nofollow';
    document.head.appendChild(tag);
    return () => tag.remove();
  }, []);
  const { did } = useParams({ from: '/people/$did' });
  const query = useQuery({
    queryKey: ['public-profile', did],
    queryFn: () => api.knowledge.profile(did),
  });
  const { data: tree } = useSkillTree();
  const skills = flattenTaxonomy(tree?.skills ?? []);
  if (query.isPending)
    return (
      <Screen title="Community profile" back>
        <LoadingState label="Opening their notebook…" />
      </Screen>
    );
  if (query.isError || !query.data)
    return (
      <Screen title="Profile unavailable" back>
        <PageState
          title="This profile isn’t available."
          action={<Link to="/skills">Explore skills</Link>}
        >
          People choose whether to share a public profile.
        </PageState>
      </Screen>
    );
  const p = query.data;
  return (
    <Screen title={p.displayName} layout="library" back>
      <div className="safe-x">
        <div className="public-profile-intro">
          <div className="public-profile-avatar">
            {p.avatarUrl ? (
              <img src={p.avatarUrl} alt={p.displayName} />
            ) : (
              <span>{p.displayName.slice(0, 2).toUpperCase()}</span>
            )}
          </div>
          <div>
            <p className="eyebrow">A notebook shared with the community</p>
            <p className="event-description">
              {p.bio || 'Here to learn, make, and share.'}
            </p>
          </div>
        </div>
        <section className="knowledge-shelf">
          <h2>Skills in practice</h2>
          <p className="section-caption">
            Self-described skills. Everyone starts somewhere.
          </p>
          {p.claims.length ? (
            <div className="public-skills">
              {p.claims.map((claim, i) => (
                <Link
                  key={`${claim.skill}-${i}`}
                  to="/skills/$skillId"
                  params={{ skillId: claim.skill }}
                  className="public-skill"
                >
                  <span>{claim.level}</span>
                  <h3>
                    {skills.find((s) => s.uri === claim.skill)?.label ??
                      'Explore this skill'}
                  </h3>
                  {claim.note ? <p>{claim.note}</p> : null}
                </Link>
              ))}
            </div>
          ) : (
            <div className="library-empty">No public skills shared yet.</div>
          )}
        </section>
        <section className="knowledge-shelf">
          <h2>Contributions to the notebook</h2>
          {p.resources.length ? (
            <div className="resource-grid">
              {p.resources.map((r) => (
                <ResourceCard key={r.id} resource={r} />
              ))}
            </div>
          ) : (
            <p className="section-caption">
              Their first contribution is still to come.
            </p>
          )}
        </section>
      </div>
    </Screen>
  );
}

function ResourceNotice({
  status,
}: {
  status?: 'moderated' | 'class-unlisted';
}) {
  if (!status) return null;
  return (
    <div className="resource-visibility-note" role="status">
      <strong>
        {status === 'moderated'
          ? 'Hidden from this school’s library'
          : 'Linked class is not publicly listed'}
      </strong>
      <p>
        {status === 'moderated'
          ? 'You can still edit or remove your own record. Editing does not restore it to the school’s library; restoration goes through moderation.'
          : 'You can still manage these notes. They stay out of the public library while attached to an unlisted class. Detach the class to share the notes independently.'}
      </p>
    </div>
  );
}

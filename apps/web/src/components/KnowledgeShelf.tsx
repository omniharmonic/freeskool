import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../lib/api';
import type { KnowledgeResource } from '../lib/types';

export function ResourceCard({ resource }: { resource: KnowledgeResource }) {
  return (
    <article className="resource-card">
      {resource.libraryStatus ? (
        <p className="resource-status">
          {resource.libraryStatus === 'moderated'
            ? 'Hidden by this school'
            : 'Linked class is unlisted'}
        </p>
      ) : null}
      <span className="resource-kind">
        {resource.uri ? 'Reading & resources' : 'Community field notes'}{' '}
        <span aria-hidden="true">↗</span>
      </span>
      <Link to="/knowledge/$id" params={{ id: resource.id }}>
        <h3>{resource.title}</h3>
      </Link>
      {resource.description ? <p>{resource.description}</p> : null}
      <footer>
        {resource.authorHasProfile ? (
          <Link to="/people/$did" params={{ did: resource.authorDid }}>
            {resource.authorName}
          </Link>
        ) : (
          <span>{resource.authorName}</span>
        )}
        <span>
          {resource.skills.length}{' '}
          {resource.skills.length === 1 ? 'skill' : 'skills'}
        </span>
      </footer>
    </article>
  );
}
export function KnowledgeShelf({
  skill,
  event,
  allowContribute = true,
}: {
  skill?: string;
  event?: string;
  allowContribute?: boolean;
}) {
  const query = useQuery({
    queryKey: ['resources', { skill, event }],
    queryFn: () =>
      api.knowledge.list({
        ...(skill ? { skill } : {}),
        ...(event ? { event } : {}),
      }),
    enabled: Boolean(api.knowledge),
  });
  return (
    <section className="knowledge-shelf">
      <div className="section-title-row">
        <div>
          <p className="eyebrow">The shared notebook</p>
          <h2>Knowledge to carry with you</h2>
        </div>
        <Link to="/knowledge" className="context-link">
          Browse the library ↗
        </Link>
      </div>
      {query.isPending ? (
        <p className="text-ink-soft">Opening the notebook…</p>
      ) : query.isError ? (
        <p role="alert">
          The library couldn’t load.{' '}
          <button className="context-link" onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      ) : query.data?.resources.length ? (
        <div className="resource-grid">
          {query.data.resources.map((resource) => (
            <ResourceCard key={resource.id} resource={resource} />
          ))}
        </div>
      ) : (
        <div className="library-empty">
          <p>No resources shared here yet.</p>
          <p>
            A useful note, a reading list, or a guide can give the next person
            somewhere to begin.
          </p>
          {allowContribute ? (
            <a
              href={`/knowledge/new?${new URLSearchParams({ ...(skill ? { skill } : {}), ...(event ? { event } : {}) })}`}
              className="context-link"
            >
              Share a resource ↗
            </a>
          ) : null}
        </div>
      )}
    </section>
  );
}
export function PractitionerShelf({ skill }: { skill: string }) {
  const query = useQuery({
    queryKey: ['practitioners', skill],
    queryFn: () => api.knowledge.practitioners(skill),
    enabled: Boolean(api.knowledge),
  });
  return (
    <section className="knowledge-shelf">
      <div className="section-title-row">
        <div>
          <p className="eyebrow">Learning is a social thing</p>
          <h2>People sharing this skill</h2>
        </div>
      </div>
      {query.isPending ? (
        <p role="status" className="text-ink-soft">
          Finding people sharing this skill…
        </p>
      ) : query.isError ? (
        <p role="alert">
          People couldn’t load.{' '}
          <button onClick={() => void query.refetch()}>Try again</button>
        </p>
      ) : query.data?.profiles.length ? (
        <div className="practitioner-grid">
          {query.data.profiles.map((p) => (
            <Link
              key={p.did}
              to="/people/$did"
              params={{ did: p.did }}
              className="practitioner-card"
            >
              <span className="practitioner-initial">
                {p.displayName.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <h3>{p.displayName}</h3>
                <p>{p.level} · self-described</p>
              </div>
              <span aria-hidden="true">↗</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="library-empty">
          <p>No public practitioner profiles here yet.</p>
          <p>
            People choose whether to share a profile and their skills. You can
            do that in{' '}
            <Link to="/me" className="context-link">
              your notebook
            </Link>
            .
          </p>
        </div>
      )}
    </section>
  );
}

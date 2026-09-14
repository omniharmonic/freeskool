import { Screen } from '../components/Screen';
import { LoadingState, PageState } from '../components/PageState';
import { Button } from '../components/bits';
import { useMe, useNearbySchools, useSchools } from '../lib/queries';
import type { NearbySchool, SchoolListing } from '../lib/types';

/**
 * `/schools` — the public directory of free schools.
 *
 * PUBLIC, and deliberately thin. Name, the city it is in, and a link to its
 * own front door. NO COUNTS ANYWHERE (spec ruling 7): not members, not
 * classes, not "most active". That a city has a free school is a public fact;
 * how many people are in it is that school's business, and a directory that
 * ranks cities by size turns a commons into a league table.
 *
 * Two sections, from two different kinds of source:
 *   - "Schools" is `GET /api/schools`, the schools THIS AppView hosts;
 *   - "Nearby schools" is `GET /api/schools/nearby`, which reads the published
 *     `freeschool.draft.school` records of the peers this school named. It is
 *     served by a newer AppView than some deployments are running, so a 404
 *     there is an empty section with a sentence, never an error banner.
 *
 * Every school is its own origin, so each link is a real `<a href>` to that
 * host and not a router navigation.
 */
export function SchoolsScreen() {
  const { data, isPending, isError, refetch } = useSchools();
  const { data: me } = useMe();
  const here = me?.school?.did;
  const schools = data?.schools ?? [];

  return (
    <Screen
      title="Schools"
      layout="reading"
      back
      standfirst="Every free school is its own place, with its own calendar, its own agreements and its own people."
    >
      <div className="safe-x reading-sections pb-4">
        <section>
          <h2 className="text-lede font-bold">Schools</h2>
          {isPending ? <LoadingState label="Finding the other schools…" /> : null}
          {isError ? (
            <PageState
              title="The list of schools couldn’t load."
              error
              action={<Button onClick={() => void refetch()}>Try again</Button>}
            >
              Check your connection and try again.
            </PageState>
          ) : null}
          {!isPending && !isError && schools.length === 0 ? (
            <p className="mt-1.5 text-body text-ink-soft">
              This is the only school here so far. Starting one is a conversation, not a form — ask the people
              already running one.
            </p>
          ) : null}
          {schools.length > 0 ? (
            <ul className="mt-3 space-y-3">
              {schools.map((school) => (
                <li key={school.did}>
                  <SchoolRow school={school} here={school.did === here} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <NearbySchools />

        <p className="text-caption text-ink-faint">
          Free School never counts one school against another. There are no member numbers on this page, and
          there never will be.
        </p>
      </div>
    </Screen>
  );
}

function SchoolRow({ school, here }: { school: SchoolListing; here: boolean }) {
  return (
    <div className="plate p-3.5">
      <p className="text-body font-bold">
        {school.name}
        {here ? <span className="ml-2 text-caption text-ink-soft">· you’re here</span> : null}
      </p>
      {school.city ? <p className="mt-1 text-caption text-ink-soft">{school.city}</p> : null}
      {school.host ? (
        <p className="mt-1.5">
          {/* Another school is another ORIGIN: a full page load, not a router hop. */}
          <a className="text-caption font-bold text-blue" href={`https://${school.host}`}>
            {school.host} <span aria-hidden="true">↗</span>
          </a>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Peers. Empty, missing and refused all land in the same quiet sentence: a
 * school with no peers yet and an AppView that cannot answer yet look the same
 * to a member, and neither is a problem they can do anything about.
 */
function NearbySchools() {
  const { data, isPending } = useNearbySchools();
  const nearby: NearbySchool[] = data ?? [];

  return (
    <section>
      <h2 className="text-lede font-bold">Nearby schools</h2>
      <p className="mt-1.5 max-w-[60ch] text-caption text-ink-soft">
        Schools this one has connected to. Their listings come from their own records, not from anything kept
        here.
      </p>
      {isPending ? <LoadingState label="Looking for connected schools…" /> : null}
      {!isPending && nearby.length === 0 ? (
        <p className="mt-1.5 text-body text-ink-soft">No connected schools yet.</p>
      ) : null}
      {nearby.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {nearby.map((school) => (
            <li key={school.did} className="plate p-3.5">
              <p className="text-body font-bold">{school.name}</p>
              {school.city ? <p className="mt-1 text-caption text-ink-soft">{school.city}</p> : null}
              {school.host ? (
                <p className="mt-1.5">
                  <a className="text-caption font-bold text-blue" href={`https://${school.host}`}>
                    {school.host} <span aria-hidden="true">↗</span>
                  </a>
                </p>
              ) : null}
              {school.tags?.length ? (
                <p className="mt-1.5 text-caption text-ink-faint">{school.tags.join(' · ')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

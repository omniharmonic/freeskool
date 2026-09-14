import type { AuthMe } from './types';

/**
 * The school name to print above a screen's title, or `undefined` when naming it would
 * be noise.
 *
 * `GET /api/auth/me` always says which school answered, even on a single-school
 * deployment — so the question this answers is not "do we know?" but "does the member
 * have anything to distinguish?". They do in exactly two cases: they belong to more than
 * one school, or they are looking at a school that is not theirs (a Boulder member
 * following a link to Denver, who gets the public projection and should be told whose it
 * is). Otherwise there is one school in their world and the app is simply "here".
 */
export function schoolHeading(me: AuthMe | undefined): string | undefined {
  const here = me?.school;
  if (!here?.name) return undefined;
  const schools = me?.schools ?? [];
  const onlyOwnSchool = schools.length <= 1 && schools.every((s) => s.did === here.did);
  return onlyOwnSchool ? undefined : here.name;
}

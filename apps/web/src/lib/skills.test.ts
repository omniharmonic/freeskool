import { describe, expect, it } from 'vitest';
import { flattenSkills, proposeParentFor, parentOptions, searchSkills } from './skills';
import type { SkillNode } from './types';

function node(id: string, label: string, children: SkillNode[] = [], description?: string): SkillNode {
  return {
    uri: `at://did:plc:school/freeschool.draft.skill/${id}`,
    id,
    label,
    ...(description ? { description } : {}),
    status: 'canonical',
    tier: 'A',
    alsoUnder: [],
    children,
  };
}

const tree: SkillNode[] = [
  node('crafts', 'Crafts', [
    node('textiles', 'Textiles', [node('mending', 'Mending'), node('sewing', 'Sewing machines')]),
  ]),
  node('food', 'Food and growing', [
    node('baking', 'Baking', [node('sourdough', 'Sourdough', [], 'A naturally leavened loaf, mending your starter as you go')]),
  ]),
  node('cafe', 'Café culture'),
];

const flat = flattenSkills(tree);
const uri = (id: string) => `at://did:plc:school/freeschool.draft.skill/${id}`;
const byId = (id: string) => flat.find((s) => s.uri === uri(id))!;

describe('flattenSkills', () => {
  it('walks the whole tree, depth-first, parents before children', () => {
    expect(flat.map((s) => s.label)).toEqual([
      'Crafts',
      'Textiles',
      'Mending',
      'Sewing machines',
      'Food and growing',
      'Baking',
      'Sourdough',
      'Café culture',
    ]);
  });

  it('builds the breadcrumb path with the taxonomy separator', () => {
    expect(byId('mending').path).toBe('Crafts › Textiles › Mending');
    expect(byId('crafts').path).toBe('Crafts');
  });

  it('names the domain (depth 0) and area (depth 1) each node sits under', () => {
    const mending = byId('mending');
    expect(mending.domain).toBe('Crafts');
    expect(mending.area).toBe('Textiles');
    expect(mending.depth).toBe(2);
    expect(mending.domainUri).toBe(uri('crafts'));
    expect(mending.areaUri).toBe(uri('textiles'));

    // A domain sits under nothing.
    expect(byId('crafts').domain).toBe('');
    expect(byId('crafts').area).toBe('');
    expect(byId('crafts').depth).toBe(0);
  });

  it('carries tier, status and description through', () => {
    expect(byId('sourdough').description).toMatch(/naturally leavened/);
    expect(byId('sourdough').tier).toBe('A');
    expect(byId('sourdough').status).toBe('canonical');
  });
});

describe('searchSkills', () => {
  it('returns nothing for an empty query', () => {
    expect(searchSkills(flat, '')).toEqual([]);
    expect(searchSkills(flat, '   ')).toEqual([]);
  });

  it('ranks a label prefix above a label substring above a path/description match', () => {
    const labels = searchSkills(flat, 'mend').map((s) => s.label);
    // 'Mending' starts with it; 'Sourdough' only mentions it in its description.
    expect(labels[0]).toBe('Mending');
    expect(labels).toContain('Sourdough');
    expect(labels.indexOf('Mending')).toBeLessThan(labels.indexOf('Sourdough'));
  });

  it('ranks the label match above children that match only through their path', () => {
    const labels = searchSkills(flat, 'textiles').map((s) => s.label);
    expect(labels[0]).toBe('Textiles');
    // Children match only through their breadcrumb path.
    expect(labels.slice(1)).toEqual(expect.arrayContaining(['Mending', 'Sewing machines']));
  });

  it('matches inside a label, not just at the start', () => {
    expect(searchSkills(flat, 'machines').map((s) => s.label)).toEqual(['Sewing machines']);
  });

  it('is diacritic-insensitive in both directions', () => {
    expect(searchSkills(flat, 'cafe').map((s) => s.label)).toEqual(['Café culture']);
    expect(searchSkills(flat, 'café').map((s) => s.label)).toEqual(['Café culture']);
  });

  it('is case-insensitive', () => {
    expect(searchSkills(flat, 'SOURDOUGH').map((s) => s.label)).toEqual(['Sourdough']);
  });

  it('caps the result list at the limit, defaulting to 12', () => {
    const many = flattenSkills(
      Array.from({ length: 40 }, (_, i) => node(`bread-${i}`, `Bread ${i}`)),
    );
    expect(searchSkills(many, 'bread')).toHaveLength(12);
    expect(searchSkills(many, 'bread', 5)).toHaveLength(5);
  });
});

describe('parentOptions / proposeParentFor', () => {
  it('offers only domains and areas as a parent', () => {
    expect(parentOptions(flat).map((s) => s.label)).toEqual([
      'Crafts',
      'Textiles',
      'Food and growing',
      'Baking',
      'Café culture',
    ]);
  });

  it('defaults a proposal to the area the best match sits in', () => {
    expect(proposeParentFor(byId('mending'))).toBe(uri('textiles'));
  });

  it('defaults to the node itself when the best match is already a domain or an area', () => {
    expect(proposeParentFor(byId('crafts'))).toBe(uri('crafts'));
    expect(proposeParentFor(byId('textiles'))).toBe(uri('textiles'));
  });
});

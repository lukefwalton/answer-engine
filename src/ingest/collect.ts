// Grouping adapter output into the shape the index stores (docs/CONTRACT.md
// §12): entities once, every fragment under its entity. An adapter yields
// `{ entity, fragment }` pairs, one per fragment; a fragmenter yields many
// pairs for one entity, each carrying its own copy of it. This helper is the
// one place those pairs are reconciled, so `npm run index` and any consumer's
// ingest share its two refusals: the same entity id described two ways, and a
// fragment id produced twice. Both are the author's mistake to fix, named by
// id (never by value).

import type { Entity, Fragment } from '../contract.js';

/** JSON with object keys sorted at every level, so two descriptions of one
 *  entity compare by content and not by the order an adapter happened to
 *  assign properties in. Arrays keep their order: two creators listed the
 *  other way round are two descriptions. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const record = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
  });
}

export interface CollectedEntities {
  /** Entities by id, in first-seen order. */
  entities: Map<string, Entity>;
  /** Fragments by entity id, in source order. Every entity has at least one. */
  fragments: Map<string, Fragment[]>;
}

export function collectEntities(sources: readonly { entity: Entity; fragment: Fragment }[]): CollectedEntities {
  const entities = new Map<string, Entity>();
  const fragments = new Map<string, Fragment[]>();
  const fragmentIds = new Set<string>();
  for (const { entity, fragment } of sources) {
    const seen = entities.get(entity.id);
    if (seen === undefined) {
      entities.set(entity.id, entity);
    } else if (canonical(seen) !== canonical(entity)) {
      throw new Error(
        `entity '${entity.id}' is described two ways by its sources; an id names one entity across collections, notes, and fragments.`,
      );
    }
    if (fragment.entityId !== entity.id) {
      throw new Error(`fragment '${fragment.id}' names entity '${fragment.entityId}' but was produced under '${entity.id}'.`);
    }
    if (fragmentIds.has(fragment.id)) {
      throw new Error(`two sources produce the fragment '${fragment.id}'; fragment ids are unique across the corpus.`);
    }
    fragmentIds.add(fragment.id);
    let list = fragments.get(entity.id);
    if (!list) fragments.set(entity.id, (list = []));
    list.push(fragment);
  }
  return { entities, fragments };
}

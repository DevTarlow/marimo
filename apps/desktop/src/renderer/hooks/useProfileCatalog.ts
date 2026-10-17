/**
 * One catalogue read, shared by everything in the window that needs it.
 *
 * The review card is drawn once per `draft_bot` call and Settings reads the same
 * catalogue for its pickers; a call per card would be the same document fetched
 * repeatedly and could show two cards with different ideas of which starter
 * roles exist. The promise is cached for the life of the window, and a failed
 * read is forgotten rather than cached so the next mount can try again.
 */
import {useEffect, useState} from 'react';

import type {ProfileCatalog} from '@marimo/protocol';

let cached: Promise<ProfileCatalog> | undefined;

export function useProfileCatalog(): ProfileCatalog | null {
  const [catalog, setCatalog] = useState<ProfileCatalog | null>(null);

  useEffect(() => {
    let cancelled = false;
    cached ??= window.marimo.call('profiles.catalog', {});
    void cached
      .then((loaded) => {
        if (!cancelled) {
          setCatalog(loaded);
        }
      })
      .catch(() => {
        // A failed read is not remembered: the next caller gets a fresh try.
        cached = undefined;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return catalog;
}

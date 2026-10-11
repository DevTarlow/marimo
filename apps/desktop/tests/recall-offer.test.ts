/**
 * When the recall card is raised, which is the whole of a bug that was invisible
 * from the outside.
 *
 * The card is meant to be asked once, at the moment a download finishes. It was
 * asked on every launch instead, because `modelReady` reads `false` while the
 * settings payload is still in flight — the same `false` a machine that has never
 * downloaded the model reports — so every launch looked like a model that had
 * just become ready.
 *
 * So these drive the reads in order rather than asserting one case in isolation:
 * what the app remembers is as much of the fix as what it decides.
 */
import {describe, expect, it} from 'vitest';

import {recallOfferOnRead} from '../src/renderer/recall-offer.js';
import type {RecallOfferRead} from '../src/renderer/recall-offer.js';

/**
 * One launch, as the window reads it: the payload in flight, then the payload.
 *
 * `loaded: false` is not a hypothetical — it is the render that happens before
 * `settings.get` answers, and `modelReady` is `false` there whatever the machine
 * is like.
 */
function launch(
  payload: {modelReady: boolean; enabled?: boolean; introSeen?: boolean},
  from: boolean | null,
): {offers: boolean[]; wasReady: boolean | null} {
  let wasReady = from;
  const offers: boolean[] = [];
  const reads: RecallOfferRead[] = [
    {
      loaded: false,
      wasReady,
      modelReady: false,
      enabled: false,
      introSeen: false,
    },
    {
      loaded: true,
      wasReady,
      modelReady: payload.modelReady,
      enabled: payload.enabled ?? false,
      introSeen: payload.introSeen ?? false,
    },
  ];
  for (const read of reads) {
    const answer = recallOfferOnRead(read);
    offers.push(answer.offer);
    wasReady = answer.remember;
  }
  return {offers, wasReady};
}

describe('recallOfferOnRead', () => {
  /*
   * The reported bug. Every launch that finds the model already installed read
   * `false` (nothing loaded) and then `true`, which looked exactly like a download
   * finishing, so the card was asked again each time the app opened.
   */
  it('says nothing on a launch where the model was already there', () => {
    const {offers, wasReady} = launch({modelReady: true}, null);

    expect(offers).toEqual([false, false]);
    expect(wasReady).toBe(true);
  });

  it('offers once the download this window watched finishes', () => {
    const first = launch({modelReady: false}, null);
    expect(first.offers).toEqual([false, false]);

    // The download lands, the payload is re-read, and this is the transition.
    const answer = recallOfferOnRead({
      loaded: true,
      wasReady: first.wasReady,
      modelReady: true,
      enabled: false,
      introSeen: false,
    });
    expect(answer.offer).toBe(true);
  });

  /* The second launch after a download: ready then, ready now, so no question. */
  it('does not offer again on the next launch', () => {
    expect(launch({modelReady: true}, true).offers).toEqual([false, false]);
  });

  /* A feature the user already turned on is not a question worth asking. */
  it('says nothing to somebody who already has recall on', () => {
    expect(launch({modelReady: true, enabled: true}, false).offers).toEqual([
      false,
      false,
    ]);
  });

  /* Answered is answered, whether they said yes or "Not now". */
  it('says nothing to somebody who has already answered the card', () => {
    expect(launch({modelReady: true, introSeen: true}, false).offers).toEqual([
      false,
      false,
    ]);
  });
});

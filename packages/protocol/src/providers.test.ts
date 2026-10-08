/**
 * The provider catalogue's two invariants.
 *
 * The first is the order. The Settings picker draws the providers in the order
 * this array states, and that order is meant to be alphabetical so nobody has to
 * hunt for the one they want: a list that drifts out of order as entries are
 * appended is the failure this catches, and it is invisible in a diff because
 * every line is correct on its own.
 *
 * The second is that the catalogue and the settings schema agree. `configs` is an
 * exhaustive record over `providerIdSchema`, so a provider added to the array
 * without a descriptor — or with a descriptor whose defaults the schema refuses —
 * is a settings file that cannot be read back. Both halves are asserted here
 * rather than left to the type checker, because a `Record<ProviderId, …>` that is
 * built by casting past its own keys type-checks fine and fails at run time.
 */
import {describe, expect, it} from 'vitest';

import {
  defaultProviders,
  fallbackModelsFor,
  providerIdSchema,
  PROVIDERS,
  PROVIDER_IDS,
  providersPatchSchema,
  providersSchema,
} from './index.js';

describe('the provider catalogue', () => {
  it('is alphabetical by label, which is the order the picker draws', () => {
    const labels = PROVIDER_IDS.map((id) => PROVIDERS[id].label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it('describes every id it names, and names every descriptor it has', () => {
    expect(Object.keys(PROVIDERS)).toEqual([...PROVIDER_IDS]);
    expect(providerIdSchema.options).toEqual([...PROVIDER_IDS]);
  });

  it('defaults to a complete, valid provider block', () => {
    const defaults = defaultProviders();
    expect(Object.keys(defaults.configs)).toEqual([...PROVIDER_IDS]);
    expect(providersSchema.safeParse(defaults).success).toBe(true);
    expect(defaults.active).toBe(PROVIDER_IDS[0]);
  });

  /*
   * The record is exhaustive in both directions, which is what makes the
   * catalogue authoritative rather than advisory: a missing provider would load
   * as no provider at all, and an unknown one would be carried around as a block
   * nothing can reach.
   */
  it('refuses a block that is missing a provider or inventing one', () => {
    const defaults = defaultProviders();
    const incomplete: Record<string, unknown> = {...defaults.configs};
    delete incomplete['opencode_go'];
    expect(
      providersSchema.safeParse({...defaults, configs: incomplete}).success,
    ).toBe(false);
    expect(
      providersSchema.safeParse({
        ...defaults,
        configs: {
          ...defaults.configs,
          someone_else: {baseUrl: 'u', model: 'm'},
        },
      }).success,
    ).toBe(false);
  });

  it('takes a patch that names one provider and leaves the rest alone', () => {
    expect(
      providersPatchSchema.safeParse({
        active: 'llamacpp',
        configs: {llamacpp: {baseUrl: 'http://192.168.1.20:8080/v1'}},
      }).success,
    ).toBe(true);
    expect(
      providersPatchSchema.safeParse({configs: {someone_else: {model: 'm'}}})
        .success,
    ).toBe(false);
  });

  /*
   * Every provider has to be askable: a request needs an address and a model id,
   * and the picker is drawn from these two before anything has called `/models`.
   * A provider that arrived with neither would be an entry the user can select
   * and then not use, with nothing on screen saying why.
   */
  it('gives every provider an address and a model to start from', () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDERS[id].id).toBe(id);
      expect(PROVIDERS[id].label.length).toBeGreaterThan(0);
      expect(PROVIDERS[id].defaultBaseUrl).toMatch(/^https?:\/\//u);
      expect(fallbackModelsFor(id).length).toBeGreaterThan(0);
      // A copy, so a caller cannot reorder the catalogue's own array.
      expect(fallbackModelsFor(id)).not.toBe(PROVIDERS[id].fallbackModels);
    }
  });
});

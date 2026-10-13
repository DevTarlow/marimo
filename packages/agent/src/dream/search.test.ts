import {describe, expect, it} from 'vitest';

import {
  actionStats,
  SearchPolicy,
  type ActionStat,
  type SearchPolicySettings,
} from './search.js';

function stat(
  action: string,
  visits: number,
  meanReward: number,
  attempts = visits,
): ActionStat {
  return {action, visits, meanReward, attempts};
}

const balanced: SearchPolicySettings = {
  explorationWeight: 1,
  pruningThreshold: -1,
};

describe('SearchPolicy scoring', () => {
  it('scores an untried action at exactly the exploration weight', () => {
    const policy = new SearchPolicy(balanced);
    // The whole reason the unseen case is special-cased: UCB1's bonus is
    // sqrt(ln N / 0), which is infinite, and an infinite score would mean the
    // controller can never exploit anything it has learned.
    expect(policy.score(stat('never', 0, 0), 10)).toBe(1);
    expect(policy.score(stat('never', 0, 0), 0)).toBe(1);
  });

  it('gives an untried action no bonus at all when the weight is zero', () => {
    const policy = new SearchPolicy({...balanced, explorationWeight: 0});
    expect(policy.score(stat('never', 0, 0), 10)).toBe(0);
  });

  it('rewards a proven action above an equal one that has been tried more', () => {
    const policy = new SearchPolicy(balanced);
    // Same mean, fewer visits: the less-explored of two equally good actions is
    // the one worth another go. This is the entire point of the bonus.
    const few = policy.score(stat('few', 1, 1), 10);
    const many = policy.score(stat('many', 9, 1), 10);
    expect(few).toBeGreaterThan(many);
  });

  it('never lets the bonus turn negative when the total is smaller than a count', () => {
    const policy = new SearchPolicy(balanced);
    // A replay legitimately asks this: a step where one action's count exceeds
    // the step's total because the tree was recorded before another was tried.
    // ln of a fraction is negative, which would make the exploration term a
    // penalty for having been tried.
    const score = policy.score(stat('busy', 5, 0.2), 1);
    expect(score).toBeGreaterThanOrEqual(0.2);
  });

  it('reduces to the mean reward when the exploration weight is zero', () => {
    const policy = new SearchPolicy({...balanced, explorationWeight: 0});
    expect(policy.score(stat('known', 3, 0.5), 9)).toBeCloseTo(0.5, 10);
  });
});

describe('SearchPolicy pruning', () => {
  it('never prunes an action nobody has tried, at any threshold', () => {
    // Threshold 1 prunes everything that is not a certain success — and an
    // untried action must still survive, or the first step of every turn would
    // offer nothing at all.
    const policy = new SearchPolicy({explorationWeight: 1, pruningThreshold: 1});
    expect(policy.survives(stat('never', 0, 0))).toBe(true);
    expect(policy.survives(stat('bad', 2, -1))).toBe(false);
  });

  it('keeps an action whose mean exactly equals the threshold', () => {
    const policy = new SearchPolicy({explorationWeight: 1, pruningThreshold: 0});
    // >=, not >. A tool that returns nothing every time scores -0.5 and goes;
    // one that has averaged exactly zero has not been shown to be bad.
    expect(policy.survives(stat('zero', 2, 0))).toBe(true);
    expect(policy.survives(stat('negative', 2, -0.1))).toBe(false);
  });

  it('prunes nothing at the default threshold', () => {
    const policy = new SearchPolicy(balanced);
    for (const value of [-1, -0.5, 0, 0.5, 1]) {
      expect(policy.survives(stat('any', 3, value))).toBe(true);
    }
  });

  it('ranks best first and breaks ties by name', () => {
    const policy = new SearchPolicy(balanced);
    const ranked = policy.rank([
      stat('bravo', 0, 0),
      stat('alpha', 0, 0),
      stat('winner', 4, 1),
    ]);
    // Two untried actions score identically at the default weight, so the order
    // between them has to be decided rather than left to the sort — a replay
    // whose output depends on array order is a replay nobody can diff.
    expect(ranked.map((entry) => entry.action)).toEqual([
      'winner',
      'alpha',
      'bravo',
    ]);
  });

  it('keeps every candidate when nothing has any history', () => {
    const policy = new SearchPolicy({explorationWeight: 1, pruningThreshold: 1});
    const ranked = policy.rank([stat('a', 0, 0), stat('b', 0, 0)]);
    expect(ranked).toHaveLength(2);
  });
});

describe('SearchPolicy repeat rule', () => {
  it('allows the first two identical calls and refuses the third', () => {
    const policy = new SearchPolicy(balanced);
    expect(policy.decide(stat('read_file', 0, 0, 1), {repeats: 1})).toBeUndefined();
    expect(policy.decide(stat('read_file', 1, 1, 2), {repeats: 2})).toBeUndefined();
    const refused = policy.decide(stat('read_file', 2, 1, 3), {repeats: 3});
    expect(refused?.kind).toBe('repeat');
  });

  it('reports a repeat rather than a withheld call when both apply', () => {
    const policy = new SearchPolicy({explorationWeight: 1, pruningThreshold: 0});
    // Both rules fire. The repeat message is the one the model can act on —
    // "stop doing that" rather than "you are not allowed" — so it is the one
    // that has to win.
    const refused = policy.decide(stat('bad', 2, -1, 3), {repeats: 3});
    expect(refused?.kind).toBe('repeat');
    expect(refused?.message).toContain('has now been called 3 times');
  });

  it('refuses below the threshold when the call is not a repeat', () => {
    const policy = new SearchPolicy({explorationWeight: 1, pruningThreshold: 0});
    // Three attempts at one *action* with different arguments is not a loop:
    // `read_file` on three different files. It is still pruned, because its
    // mean reward is below the threshold — and the count in the message is the
    // action's visits, not the repeats.
    const refused = policy.decide(stat('read_file', 3, -1, 3), {repeats: 1});
    expect(refused?.kind).toBe('below-threshold');
    expect(refused?.message).toContain('tried 3 time(s)');
  });
});

describe('actionStats', () => {
  it('counts a withheld proposal as an attempt and not a visit', () => {
    const stats = actionStats([
      {action: 'web_search', reward: 1, ran: true},
      {action: 'web_search', ran: false},
      {action: 'web_search', ran: false},
    ]);
    expect(stats).toEqual([
      {action: 'web_search', visits: 1, meanReward: 1, attempts: 3},
    ]);
    // The rule this protects: counting refusals as zero-reward visits would make
    // pruning self-reinforcing, since the evidence for pruning an action would
    // be the pruning itself.
  });

  it('answers a never-run action with a zero mean rather than NaN', () => {
    const stats = actionStats([{action: 'ghost', ran: false}]);
    expect(stats[0]?.meanReward).toBe(0);
    expect(Number.isNaN(stats[0]?.meanReward)).toBe(false);
    // A NaN here would make every `>=` threshold comparison false, which reads
    // as "never prune" for entirely the wrong reason.
  });

  it('folds several observations into a mean', () => {
    const stats = actionStats([
      {action: 'shell', reward: 1, ran: true},
      {action: 'shell', reward: -1, ran: true},
    ]);
    expect(stats[0]?.meanReward).toBeCloseTo(0, 10);
    expect(stats[0]?.visits).toBe(2);
  });

  it('treats a missing reward on a run call as zero', () => {
    const stats = actionStats([{action: 'shell', ran: true}]);
    expect(stats[0]?.meanReward).toBe(0);
    expect(stats[0]?.visits).toBe(1);
  });
});

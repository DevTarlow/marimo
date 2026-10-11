/**
 * The join between what is installed, what the machine has and what to start.
 *
 * Both processes need the same answer to the same question — the window to answer
 * a question, the headless runner to run a scheduled job — and the failure when
 * they disagree is the one this whole feature is shaped around: the window answers
 * while a scheduled job reports the model as not installed. So the sequence lives
 * here once, and each caller supplies only what it has.
 *
 * The sequence is: probe the engine that is installed, decide the tier from what
 * it reported, and describe the start. Nothing here downloads anything — that is
 * the caller's decision, because it is a decision about a user's time.
 */
import type {LocalModelManifest, ModelTierName} from './manifest.js';
import {backendNameFor} from './manifest.js';
import {engineBinaryName, engineDir, installedTiers, localModelSpec} from './files.js';
import type {LocalModelSpec} from './files.js';
import {probeDevices} from './probe.js';
import type {DeviceProbe} from './probe.js';
import {planTier} from './plan.js';
import type {TierChoice, TierPlan} from './plan.js';

export interface ResolveTierOptions {
  dir: string;
  manifest: LocalModelManifest;
  /** `auto` unless the user has said otherwise. */
  choice: TierChoice;
  /**
   * A probe the caller has already run.
   *
   * Injected because probing launches a process, and the Settings card asks for
   * the status every time it is drawn: a caller that has an answer should not pay
   * for it again. A caller without one gets a fresh probe.
   */
  probe?: DeviceProbe;
}

/**
 * Which tier this install should run.
 *
 * The probe runs against the engine *as installed*, which is why a machine that
 * has not downloaded anything yet gets "no usable GPU" rather than "not
 * installed" — the engine is not there to ask. That distinction belongs to the
 * caller, which knows whether an install is in progress; this function answers
 * only what it can see.
 */
export async function resolveTier(
  options: ResolveTierOptions,
): Promise<TierPlan> {
  const probe =
    options.probe ??
    (await probeDevices(
      options.dir.length > 0
        ? `${engineDir(options.dir)}/${engineBinaryName()}`
        : '',
    ));

  return planTier({
    manifest: options.manifest,
    ...(probe.maxFreeBytes === undefined
      ? {}
      : {gpuFreeBytes: probe.maxFreeBytes}),
    choice: options.choice,
    installed: installedTiers({dir: options.dir, manifest: options.manifest}),
    ...(backendNameFor(options.manifest) === undefined
      ? {}
      : {backendName: backendNameFor(options.manifest)!}),
  });
}

/**
 * The spec to start, for whatever the plan decided.
 *
 * A plan that refused still produces a spec, and deliberately: the service has to
 * be able to *describe* the model it would run so the status card can show the
 * command line and the missing file, and a refusal is a fact about readiness
 * rather than a reason to have nothing to say. The tier falls back to the small
 * one, which is the file a user is most likely to have.
 */
export async function localModelSpecFor(
  options: ResolveTierOptions,
): Promise<{spec: LocalModelSpec; plan: TierPlan}> {
  const plan = await resolveTier(options);
  const tier: ModelTierName = plan.runnable
    ? plan.tier
    : 'low';
  const contextSize = plan.runnable
    ? plan.contextSize
    : options.manifest.weights.tiers.low.contextSize;

  return {
    plan,
    spec: localModelSpec({
      dir: options.dir,
      manifest: options.manifest,
      tier,
      contextSize,
    }),
  };
}

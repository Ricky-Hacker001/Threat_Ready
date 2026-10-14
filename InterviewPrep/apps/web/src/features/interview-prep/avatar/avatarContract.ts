/**
 * The asset contract between the interviewer GLB and the runtime.
 *
 * `scripts/build-avatar-rocketbox.ts` converts the Microsoft Rocketbox avatar into a model that
 * satisfies this contract (`scripts/build-avatar.ts` builds the original stylised fallback), and
 * the runtime (`useInterviewerAnimation.ts`) only relies on these names. Any replacement GLB that
 * follows the same contract can be dropped into `public/models/` without code changes. See
 * ASSET_LICENSE.md for the full description (units, orientation, rig).
 */

/** Served by the API to signed-in users, encrypted per response (see loadModel.ts); never a public file. */
export const MODEL_URL = '/v1/assets/interviewer-model';

export const BONE_NAMES = [
  'Hips',
  'Spine',
  'Chest',
  'Neck',
  'Head',
  'LeftShoulder',
  'LeftUpperArm',
  'LeftLowerArm',
  'LeftHand',
  'RightShoulder',
  'RightUpperArm',
  'RightLowerArm',
  'RightHand',
] as const;
export type BoneName = (typeof BONE_NAMES)[number];

export const CLIP_NAMES = ['Idle', 'Talk', 'Listen', 'Think'] as const;
export type ClipName = (typeof CLIP_NAMES)[number];

export const MORPH_NAMES = ['blink', 'mouthOpen', 'smile', 'browRaise'] as const;
export type MorphName = (typeof MORPH_NAMES)[number];

/** Optional Oculus-style visemes on the face mesh; when present they drive lip sync. */
export const VISEME_MORPH_NAMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'].map((v) => `viseme_${v}`);

/** Eye objects (bones or meshes) under the Head bone; identity rotation looks down +Z. */
export const EYE_MESH_NAMES = ['LeftEye', 'RightEye'] as const;
export type EyeMeshName = (typeof EYE_MESH_NAMES)[number];

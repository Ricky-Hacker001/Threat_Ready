# Interviewer avatar: asset licence, protection and swap-in contract

## Current model: Renderpeople "Eric Rigged 001" (scanned human)

`apps/api/assets/interviewer.glb` is converted from **Eric Rigged 001**, a free photogrammetry scan
of a real person from Renderpeople (https://renderpeople.com/free-3d-people/, "Rigged People", FBX).
Free Renderpeople models carry the same **Extended Use Licence** as paid ones. The relevant terms,
from Renderpeople's General Terms & Conditions:

- **Allowed (§4.1b):** real-time rendering for commercial or private use, including AR/VR/XR
  applications and computer games.
- **Not allowed (§4.2b):** transferring the 3D data to third parties (renting, reselling, lending,
  sublicensing), in original, partial or modified form.
- **Required (§4.3b):** the model must not be made *easily* accessible; third parties must not be
  able to *easily* download, extract, distribute or otherwise access it, and it must be stored and
  integrated "according to the current state of technology".
- **Free = paid (§2.5):** the same provisions apply to free models.

### How the app meets §4.3b

- The GLB is **never a public file**: it is not in `apps/web/public` or the web bundle.
- `GET /v1/assets/interviewer-model` serves it **only to signed-in users** (route permission
  `interview:read`). Signed-out requests get 401.
- Each response is **encrypted with a fresh AES-256-GCM key** (`X-Asset-Key` / `X-Asset-Iv`
  headers) and sent with `Cache-Control: private, no-store`. The web app decrypts it in memory
  with WebCrypto (`loadModel.ts`) and never writes it to storage.
- The repository holds the converted GLB for deployment; the source pack stays outside the repo.

This prevents casual downloading, hot-linking and copying from the HTTP cache. It is a reasonable
technical measure, not DRM: a determined signed-in user with developer tools can still capture what
the browser renders, as with any web or game asset. If the business needs stronger guarantees, or
wants certainty about whether this meets §4.3b, confirm with Renderpeople or counsel. The Rocketbox
alternative below is MIT-licensed and carries no such obligation.

### Rebuilding

1. Download the free rigged FBX pack (`renderpeople_free_rigged_people_FBX.zip`, about 395 MB; no
   registration) and unzip `rp_eric_rigged_001_FBX.zip` from it.
2. `RENDERPEOPLE_DIR=/path/to/unzipped/eric npm run avatar:build -w @threatready/web`

`scripts/build-avatar-renderpeople.ts` (with the shared `scripts/avatar-lib.ts`):

- normalises the 88-bone rig: metres, world-aligned axes, contract names
- splits the scan by its texture masks into `SkinMesh`, `ClothesMesh` and `EyeMesh`
- bakes the face bones (eyelids, jaw, mouth corners, brows) into the contract's `blink`,
  `mouthOpen`, `smile` and `browRaise` morph targets by posing and skinning them
- solves the seated pose with two-bone IK and keyframes the clips
- downsizes the 8K textures: 4K colour, 2K normal, 1K roughness from gloss

The result is about 4.6 MB.

What this model does not have: blendshape visemes. The mouth opens with the jaw while Alex speaks,
but phoneme lip sync needs a model with visemes; Rocketbox has them.

## Alternatives

- **Microsoft Rocketbox Business_Male_01** (MIT): less photoreal, but with 15 visemes for lip sync
  and no extraction obligation.
  1. Download `Export/Business_Male_01_facial.fbx` and the seven `Textures/m005_*.tga` from
     `Assets/Avatars/Professions/Business_Male_01/` of https://github.com/microsoft/Microsoft-Rocketbox.
  2. Run `ROCKETBOX_DIR=… npm run avatar:build:rocketbox -w @threatready/web`.

  If shipped, keep the MIT notice ("Copyright (c) 2020 Microsoft", full text in the repository's
  LICENSE.md) with the asset.
- **Stylised original** (no third-party assets): `npm run avatar:build:stylised -w @threatready/web`.

## Swap-in contract (replacing the GLB without code changes)

Any model that meets these requirements can replace `apps/api/assets/interviewer.glb`. The names
are exported from `avatarContract.ts`.

| Requirement | Value |
| --- | --- |
| Format | glTF 2.0 binary (`.glb`), textures embedded. No Draco or Meshopt compression, and no external files. |
| Units / axes | Metres, **Y-up**, character **faces +Z**. Character's left = +X. |
| Placement | Seated, origin on the floor under the hips. Desk top in the scene is at **y = 0.72 m**, with the desk edge nearest the character at z ≈ 0.17 m. Forearms and hands should rest on it. |
| Skeleton | One skeleton containing bones named exactly: `Hips`, `Spine`, `Chest`, `Neck`, `Head`, `LeftShoulder`, `LeftUpperArm`, `LeftLowerArm`, `LeftHand`, `RightShoulder`, `RightUpperArm`, `RightLowerArm`, `RightHand`. Extra bones are fine. |
| Clips | `Idle`, `Talk`, `Listen`, `Think`, all seamlessly loopable. The runtime crossfades between them. |
| Morph targets | On one mesh: `blink`, `mouthOpen`, `smile`, `browRaise` (0 to 1). Optional, all-or-nothing: the 15 visemes `viseme_sil` … `viseme_U`; when present they drive lip sync. |
| Eyes | Objects (bones or meshes) named `LeftEye` and `RightEye` under `Head`. With an identity local rotation the eye looks down **+Z**. The runtime aims them at the camera. |
| Materials | Standard PBR. `Skin` gets a subsurface approximation and sheen; `Eye` a stronger reflection and no received shadow; `Hair` (alpha-tested) alpha-to-coverage edges. Other names are left alone. |
| Budget | Less than 6 MB and fewer than ~40k triangles. |

`test/avatar-asset.test.ts` checks every requirement except the visual ones.

## Rendering

The look comes as much from rendering as from the model (`InterviewerScene.tsx`, `Effects.tsx`):

- **Skin and eyes:** a subsurface-scattering approximation on skin, and wet, glossy eyes.
- **Post-processing:** ground-truth ambient occlusion, a shallow depth of field focused on the face,
  AgX tone mapping with a contrast grade, fine film grain and a vignette.
- **Shadows:** 2K soft shadows.
- **Fallback:** the effects switch off automatically if the frame rate drops, on devices with four
  or fewer CPU cores, or with `?fx=0`. In development, `?cam=face` frames the face for checking a
  new asset.

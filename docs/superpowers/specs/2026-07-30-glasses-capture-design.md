# Glasses capture for TrockCam — design

**Date:** 2026-07-30
**Status:** approved, not yet implemented
**Branch:** `feat/mobile-wearables-dat`

An estimator wearing Ray-Ban Meta glasses walks a job site talking about what they see.
TrockCam records it, drops the walk into the project folder, and feeds the TROCK Scope
ingestion engine, which returns evidence-linked scope line items into CRM estimating.

---

## What is already true

**Measured on hardware 2026-07-30** (device `RB Meta 014K`, real Developer Center
credentials, `developerMode: false` — not MockDeviceKit). Full detail in
`trock-scope/docs/HANDOFF.md`.

| Capability | Measured |
| --- | --- |
| `capturePhoto` | 1080×1440 display (1440×1080 stored + EXIF rotate), 1.56 MP, ~320 KB JPEG |
| Stream `.high` | 720×1280 (0.92 MP) |
| Stream `.medium` | 504×896 (0.45 MP) — the `StreamConfiguration()` default |
| Stream `.low` | 360×640 (0.23 MP) |
| HFP audio | 16 kHz wideband, `inputPortType: BluetoothHFP` |
| Audio size | ~122 KB per 10 s (~0.7 MB/min) |

Stills carry **1.7× the pixels of the highest stream resolution**. No stream setting closes
that gap, so evidence frames come from `capturePhoto`, never from harvested video frames.

**Already built, do not rebuild:**

- `WearablesBridge` (Swift, in the app target via `withWearablesDat`) — configure, register,
  permissions, session/stream lifecycle, `capturePhoto`, HFP recording, and the `4b` diagnostic
- `upload-queue.ts` / `upload-background-core.ts` / `upload-background-task.ts` — resumable
  background upload with an OS-invoked drain registered at startup
- `CameraCapture.tsx` — phone camera capture
- TROCK Scope ingest: `POST /walkthroughs` → `/clips` → `/clips/:id/parts` → `/complete`
  (presigned R2 multipart). **`video`, `audio`, and `photo` are all accepted `ClipKind`s**
  (`server/src/ingest/media-types.ts`) — no engine change is needed
- TROCK Scope → CRM export: `WalkthroughIngressPayload` (`shared/src/types/walkthrough-ingress.ts`)

---

## Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | **Video + stills**, not either alone | The crew gets a rewatchable walk; the engine gets 1.56 MP evidence frames instead of 0.92 MP |
| 2 | **Phone CAPTURE button + auto-interval** | The glasses cannot signal the app at all (see below). The interval guarantees evidence exists even if nobody taps |
| 3 | **Phone → trockcrm → trock-scope** | One upload over jobsite cellular; reuses the trockcrm session and upload queue the app already has; no second login on a field device |
| 4 | **Auto-upload, no review gate** | The estimator is free the moment the walk ends. Culling would be guessing — the engine decides which frames are evidence by grounding them against the transcript |
| 5 | **Phone stills remain available during a walk** | Where the estimator deliberately stops to document something, the iPhone camera is far sharper than 1.6 MP |

**The glasses cannot trigger anything.** `tap()` and `captouchTap()` exist only in
`MWDATMockDevice` and `MWDATMockDeviceTestClient` — they drive a *simulated* device in tests.
`MWDATDisplay`'s button/`onTap` is UI for display glasses, and this hardware reports
`supportsDisplay: false`. The temple button belongs to Meta AI and is unreachable. Do not
design around it.

---

## Start-of-walk sequence — order is mandatory

Meta's DAT audio guidance (`wearables.developer.meta.com`, *microphones and speakers*) states
that with HFP and a DAT camera stream, the HFP microphone must be fully configured **before the
stream starts**, and that starting the camera stream prematurely "can cause the audio route to
fail silently."

```
1. createSession(AutoDeviceSelector) → session.start() → wait for .started
2. addStream()                       ← stream object created, NOT started
3. AVAudioSession .playAndRecord + [.allowBluetoothHFP] → setActive(true)
4. poll currentRoute.inputs for .bluetoothHFP   ← stabilization, up to 3s
5. stream.start()                    ← only now
6. AVAssetWriter begins: video track + audio track
```

Steps 2 and 5 are deliberately separate. The existing `startStream` calls `addStream()` and
`stream.start()` back to back, leaving no window for HFP to settle between them.

**Every wait in this sequence is load-bearing.** Four separate defects in `startStream` were
"asked too early" races (commit `ea10156c9`), and the HFP route read was a fifth (`e39a83fbb`).
Assume any SDK state that arrives via a publisher or stream is not ready on the next line.

**HFP and A2DP are mutually exclusive.** Activating HFP switches the glasses away from A2DP and
their audio *output* drops to 8 kHz mono. The session must therefore be deactivated at
end-of-walk, or the glasses stay degraded for every other app on the phone.

---

## Components

### Native — `WalkthroughRecorder` (Swift, alongside `WearablesBridge`)

| Method | Responsibility |
| --- | --- |
| `startWalk()` | The six-step sequence above. Rejects with a named reason at whichever step fails |
| `captureStill()` | `stream.capturePhoto(.jpeg)`; bytes arrive on `photoDataPublisher` and are written to disk |
| `endWalk()` | Finalize the `AVAssetWriter`, stop the stream and session, **deactivate the audio session** |

Emits `walkthrough:still`, `walkthrough:state`, `walkthrough:error`.

Because video and audio are muxed, a walk produces **one `.mp4` carrying both tracks**, plus N
`.jpg` stills — not three parallel media streams to reconcile downstream. The DAT stream config
reports `audioCodec: nil`, so the audio track comes entirely from the HFP recorder and the two
clocks must be reconciled against a single session start time.

Artifacts are written to the **documents directory** (`doc-dir-uri.ts`), never `tmp`. iOS purges
`tmp` and would delete a walk out from under a pending upload.

### JS

- `src/wearables/walkthrough.ts` — typed bridge wrapper and session state machine:
  `idle → starting → recording → finalizing → queued`
- Artifacts are handed to the existing `upload-queue` under a new artifact kind, inheriting
  resume and background drain

### UI

- **Profile → "Meta glasses"** — link state, device name, Pair button. Reuses
  `configure` / `status` / `startRegistration`. Registration persists across app relaunches
  (verified), so this is normally a status display, not an action
- **Capture, after project number** — mode selector: `Phone` or `Glasses (AI walk)`
- **Walk screen** — elapsed timer, large CAPTURE button, still counter, auto-still indicator,
  End walk. The CAPTURE button fires the **glasses** camera (first-person, hands-free); the
  phone camera is a separate action reachable without ending the walk

### Server — trockcrm

New endpoint accepting walk artifacts against a deal/project:

1. Write `files` rows so the walk appears in the project folder
2. Server-to-server: `POST /walkthroughs` on TROCK Scope, then push each artifact through its
   existing multipart clip ingest

TROCK Scope needs **no ingest changes**. Its export path back into CRM estimating already
exists.

---

## Data flow

```
GLASSES ──video frames──┐
        ──HFP audio─────┤→ AVAssetWriter → walkthrough.mp4 ─┐
        ──capturePhoto──┴────────────────→ still-NN.jpg ─────┤
PHONE   ──CameraCapture ─────────────────→ phone-NN.jpg ─────┤
                                                             ▼
                                        upload-queue (background, resumable)
                                                             ▼
                                    TROCKCRM  ── files rows → project folder
                                                             ▼
                                    TROCK SCOPE (server-to-server)
                                      frames · ASR · moments · grounding
                                                             ▼
                                    WalkthroughIngressPayload → CRM estimating
```

---

## Failure handling

| Failure | Behaviour |
| --- | --- |
| HFP route never stabilizes | Fail `startWalk()` **before** recording, naming the route actually selected. A walk with no audio is a wasted site visit — never start one silently |
| Glasses disconnect mid-walk | Finalize what exists, mark the walk partial, keep it queued. Never discard captured media |
| Phone camera kills the HFP route | Must be prevented, not recovered: the phone's `AVCaptureSession` is configured **photo-output only, no audio input**, so it never touches the shared session |
| Upload interrupted | Existing queue resumes; multipart survives dead zones. This is why ingest is file-based rather than a live socket |
| App killed mid-walk | Artifacts are already on disk in the documents directory; the queue drains on next launch |
| trock-scope unreachable | trockcrm has already written the project-folder rows. Forwarding retries independently — the crew's copy never depends on the engine being up |

---

## Step 0 — PROVISIONAL. Both checks PASS, but both checks are weaker than they look

> ⚠️ **Read this before relying on the results below.** Code review (PR #1020, 2026-07-30)
> found that neither rung verifies the thing it claims to measure. Both need re-running after
> the fixes land. The PASS results are recorded as-is, with what each does and does not
> establish stated plainly.
>
> **Rung 9 never confirms a frame arrived.** It waits 4s after `stream.start()` and reads the
> route. If the DAT stream had stalled and delivered nothing, the HFP route would be trivially
> undisturbed and the rung would still report PASS — for a stream that never ran. Our PASS is
> *probably* genuine, because rung 6b showed frames flowing (504×896, first frame at 2.2–2.5s)
> earlier in the same session, but rung 9 itself does not establish it.
> **Fix:** require at least one delivered frame, with a failure timeout, before computing the
> verdict.
>
> **Rung 10 never takes a photo.** It builds an `AVCapturePhotoOutput`, calls `startRunning()`,
> and reads the route — but never calls `capturePhoto`. The shutter is precisely where a route
> disturbance would most plausibly occur, and it is what the real feature does. So this
> establishes *opening the camera is safe*, **not** *taking a still is safe*.
> **Fix:** perform a real capture and measure the route through its completion.
>
> Until both are re-run: treat "video + audio simultaneously" as well-supported, and "phone
> stills during a walk are safe" as **untested**.
>
> ### Both fixes have LANDED. Only the re-run remains.
>
> `e42f20f7b` (Swift) + `f676b09c0` (verdicts). Rung 9 now counts delivered frames and reports
> `framesDelivered` / `firstFrameSeconds`; a zero-frame run returns **inconclusive**, because an
> undisturbed route is ambiguous between "a stream ran and did not disturb it" and "nothing ran
> to disturb it with". Rung 10 now fires a real shutter, samples the route **during the capture**,
> and reports `capturePhotoSucceeded` / `capturePhotoTimedOut` / `capturePhotoError`; a failed or
> timed-out shutter is inconclusive, and `duringCapture` is evaluated with the same rigour as
> `during` on both port and rate.
>
> Note the Swift fix alone was inert — native measured the new facts for one commit before the
> verdicts read them, during which rung 9 would still have passed a zero-frame run. Both commits
> are required.
>
> The zero-frames gate sits **last**, after route-loss and rate-degradation. A route that actually
> dropped is real evidence something touched the microphone whether or not a frame decoded, so
> gating earlier would downgrade genuine failures to inconclusive and discard evidence. Two
> regression tests pin that ordering.
>
> 180 input combinations were enumerated across both verdict functions; none returns `pass` while
> claiming more than its inputs support. `step0-verdicts.ts` now carries 209 tests.
>
> **What is left is purely the hardware re-run.** Rebuild, run rung 1 then 9 then 10, and record
> the verdicts here, replacing this block.

The two silent-failure modes that gated this design were measured on device via rungs 9 and 10.
**Both passed. The design proceeds as written — no fallback, no spec change.**

**Rung 9 — does HFP survive a DAT camera stream?** PASS.

```
beforeStreamStart   BluetoothHFP · RB Meta 014K · 16000 Hz
afterStreamStart    BluetoothHFP · RB Meta 014K · 16000 Hz
```

The route survived, and the *rate* held at 16 kHz — the check fails a narrowband downgrade even
when the port stays HFP, so this is wideband confirmed on both sides, not merely "still
Bluetooth". Video + glasses audio can be captured simultaneously.

**Rung 10 — does the phone camera tear down the HFP route?** PASS.

```
before   BluetoothHFP · RB Meta 014K · 16000 Hz
during   BluetoothHFP · RB Meta 014K · 16000 Hz
after    BluetoothHFP · RB Meta 014K · 16000 Hz
```

The `during` reading is the load-bearing one: the route was intact *while the capture session was
running*, not merely restored afterwards. Phone stills during a glasses walk are safe — provided
the capture session stays **photo-output only with no audio input**, which is the configuration
this check exercised. Adding an audio input would invalidate this result.

**Method, so the result can be trusted.** Rung 9 runs Meta's documented order exactly:
`addStream()` → configure HFP → poll for route stabilization → `stream.start()` → wait 4s (past
the measured 2.2–2.5s first-frame latency) → read. Rung 10 polls up to 3s for route recovery
after `stopRunning()` rather than reading at a fixed offset, because a fixed read can catch a
Bluetooth renegotiation mid-transition and report a recovery failure that never happened.

Native reports raw route snapshots and decides nothing; the verdicts are computed by pure
TypeScript in `mobile/src/wearables/step0-verdicts.ts` (19 tests). `describePhoneCameraCheck`
returns `pass` for exactly one of 27 `(before, during, after)` combinations — an `INCONCLUSIVE`
outcome exists specifically so a run that measured nothing cannot be mistaken for a run that
measured success.

---

## Testing

**What tests can reach:** the state machine, artifact bookkeeping, queue integration, and the
server receive-and-forward path — all ordinary unit and runtime tests.

**What they cannot reach, and this matters:** every defect found on 2026-07-30 was a race or an
ordering violation inside the native bridge, invisible to all 624 mobile tests. The project's own
history records 1,227 passing tests missing two bugs that only appeared against real services.

Therefore: **no part of this ships on green tests alone.** The ordering sequence, the HFP route,
and the muxed output each require a hardware pass, and the diagnostic rungs exist so those passes
produce measurements rather than impressions.

---

## Owner decisions — 2026-07-30, Adnaan

**1. A permanently-failed forward sends an email.** When a walk reaches the project folder but
forwarding to TROCK Scope exhausts its retries (or dies on a config error), someone gets told.
Without this the failure is invisible: the estimator's phone said "uploaded" and was telling the
truth, the walk is filed, and no scope ever comes back. A site visit is not repeatable — by the
time anyone notices, the estimator has left the site.

**2. A walk is attributed to the estimator who captured it, not to a robot account.** TROCK Scope
records `capturedBy` from whoever is logged in, but the CRM forwards machine-to-machine with
nobody logged in. The decision is that TROCK Scope **trusts the CRM's `capturedByUserId`** rather
than stamping every forwarded walk with one shared service identity. Framing: it is Dave's walk,
captured with AI assistance — not the robot's walk.

*This is a TROCK Scope change and is NOT built* — `routes/walkthroughs.ts` reads `req.user!.id`
directly, so it needs a machine-auth path that accepts a trusted `capturedByUserId`. Deferred
with decision 3.

**3. TROCK Scope is not deployed yet, deliberately.** The scope pipeline is already proven
end-to-end (6/6 stages, real line items — see `trock-scope/docs/HANDOFF.md`); what is unproven is
the *capture* half. The crew-facing outcome — a walk landing in the project folder — works with
TROCK Scope switched off entirely, which is exactly why the two destinations were built
independent of each other.

So: prove video ingestion on hardware first, then deploy and turn forwarding on. Decisions 1 and 2
only bite once media is actually flowing, and both are better made against a real walk than in the
abstract.

**Consequence for sequencing:** the next hardware session is about the `.mp4`, not the server.
Record a walk, pull the file, play it. If the audio track is empty or drifts from the video,
that is a bigger correction than anything downstream, and everything above it is moot until it
holds.

---

## Out of scope

- Voice-triggered capture (needs on-device keyword spotting off the same mic feed)
- Reviewing or pruning stills — decision 4
- Live streaming to the server — the engine ingests files; multipart survives dead zones
- Display-glasses features — this hardware reports `supportsDisplay: false`
- Removing the dead `handleUrl` wrapper (cleanup, tracked in the handoff, not part of this work)

---

## Known constraints carried in

- App deployment target is 15.1 while `MWDATCore` requires 15.2. Harmless on modern hardware,
  but the app would fail to launch on a genuine 15.1 device. Bump before shipping to crews.
- `MetaAppID`/`ClientToken` live in `Info.plist` via `withWearablesDat`, so credential changes
  need `expo prebuild` — they cannot be hot-reloaded.
- Consumers of glasses stills **must honour EXIF orientation**; stored pixels are 1440×1080.
- A recorded `.m4a` is 48 kHz AAC regardless of the negotiated rate. The session rate is the
  real number; the file is upsampled and is not evidence of anything.

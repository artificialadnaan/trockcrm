# Glasses Capture Phase 2 — UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An estimator can see whether their glasses are paired, start an AI walk from a project, capture stills during it, and end it — driving the Phase 1 recorder through the Phase 1 state machine.

**Architecture:** A new route owns the walk. `capture.tsx` is 1,361 lines already and owns phone burst capture; the walk gets its own screen and is reached by a single navigation button, so neither screen grows a mode branch. All lifecycle logic stays in `src/walkthrough/session.ts`; the screen only dispatches events and renders state.

**Tech Stack:** expo-router, React Native, `@tanstack/react-query` (present but not needed here), the project theme in `src/theme/theme.ts`.

**Depends on Phase 1:** `src/walkthrough/session.ts` (`initialWalk`, `reduceWalk`, `canCapture`, `artifactCount`, `Walk`, `WalkEvent`, `StillSource`) and `src/walkthrough/native.ts` (`Recorder.startWalk/captureStill/endWalk`, `onStill`, `onRecorderError`, `isAvailable`).

---

## Constraints carried in from Step 0

- **Phone stills during a walk are safe ONLY with a photo-output-only capture session that has no audio input.** That is the exact configuration rung 10 measured. Any phone-camera code added here that attaches an audio input invalidates the result and will silently kill glasses audio mid-walk.
- **The walk records glasses VIDEO and PHONE audio, and refuses to run audio over Bluetooth HFP.** This inverts what this plan originally assumed. Measured on hardware 2026-08-01 across four real walks and three diagnostic rungs: requesting HFP forces the glasses radio into hands-free mode and starves the DAT video transport — video dies after 3-8 seconds, every time, while the writer was accepting every frame it was handed (239 received, 239 appended, 0 dropped). The glasses simply stop sending. So native rejects with `walk_route_is_glasses` when the audio route resolves to Bluetooth HFP, and records the phone microphone at 48 kHz instead — better fidelity than the 16 kHz HFP path this plan was written around. The UI must surface that rejection as a clear, actionable message, never as a generic failure.
- Registration **persists** across app relaunches (verified 2026-07-30), so the Profile row is normally a status display, not an action.

---

## File structure

| File | Responsibility |
| --- | --- |
| `mobile/src/walkthrough/useWalk.ts` | **Create.** Hook binding the reducer to the native recorder. No JSX |
| `mobile/src/walkthrough/__tests__/useWalk.test.ts` | **Create.** Tests for the binding logic |
| `mobile/src/walkthrough/pairing.ts` | **Create.** Pure helper turning SDK status into a display state |
| `mobile/src/walkthrough/__tests__/pairing.test.ts` | **Create.** Tests |
| `mobile/app/(app)/walk.tsx` | **Create.** The walk screen |
| `mobile/app/(app)/profile.tsx` | **Modify.** Add the glasses pairing row |
| `mobile/app/(app)/capture.tsx` | **Modify.** One button that routes to the walk |
| `mobile/app/(app)/_layout.tsx` | **Modify.** Register the `walk` route if the layout enumerates screens |

---

## Task 1: Pairing display state

**Files:**
- Create: `mobile/src/walkthrough/pairing.ts`
- Test: `mobile/src/walkthrough/__tests__/pairing.test.ts`

The Profile row must distinguish four situations that look identical if collapsed: no bridge in this build, SDK not configured, configured but no device registered, and ready. Each needs a different action from the user, so each needs its own state.

- [ ] **Step 1: Write the failing tests**

```ts
import { describePairing, type PairingInput } from "../pairing";

const ready: PairingInput = {
  bridgeAvailable: true,
  configured: true,
  registrationState: "registered",
  deviceCount: 1,
  deviceName: "RB Meta 014K",
  linkState: "connected",
};

describe("describePairing", () => {
  it("is ready when a device is registered and linked", () => {
    const p = describePairing(ready);
    expect(p.status).toBe("ready");
    expect(p.canStartWalk).toBe(true);
    expect(p.detail).toContain("RB Meta 014K");
  });

  // A build without the native module cannot be fixed by pairing — it needs a rebuild, which is
  // a completely different instruction from "connect your glasses".
  it("reports a missing bridge as needing a rebuild, not a pairing problem", () => {
    const p = describePairing({ ...ready, bridgeAvailable: false });
    expect(p.status).toBe("unavailable");
    expect(p.canStartWalk).toBe(false);
    expect(p.detail).toMatch(/rebuild/i);
  });

  it("asks the user to pair when nothing is registered", () => {
    const p = describePairing({ ...ready, registrationState: "available", deviceCount: 0, deviceName: null, linkState: null });
    expect(p.status).toBe("unpaired");
    expect(p.canStartWalk).toBe(false);
  });

  // Registered but not linked is the confusing one: the glasses are known to the SDK but not
  // reachable right now. Telling the user to "pair" would be wrong — they already did.
  it("distinguishes registered-but-disconnected from unpaired", () => {
    const p = describePairing({ ...ready, linkState: "disconnected" });
    expect(p.status).toBe("disconnected");
    expect(p.canStartWalk).toBe(false);
    expect(p.detail).not.toMatch(/pair/i);
  });

  it("blocks a walk when the SDK was never configured", () => {
    const p = describePairing({ ...ready, configured: false });
    expect(p.status).toBe("unconfigured");
    expect(p.canStartWalk).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd mobile && npx jest src/walkthrough/__tests__/pairing.test.ts
```
Expected: FAIL, `Cannot find module '../pairing'`.

- [ ] **Step 3: Implement**

```ts
/**
 * Turns raw SDK status into something a Profile row can render.
 *
 * Four failures look identical if collapsed into "not working", and each needs a different
 * action from the user: rebuild the app, configure the SDK, pair the glasses, or reconnect
 * glasses that are already paired. Telling someone to "pair" glasses they paired last week is
 * how a two-minute fix becomes an evening.
 */

export type PairingStatus =
  | "unavailable"
  | "unconfigured"
  | "unpaired"
  | "disconnected"
  | "ready";

export type PairingInput = {
  bridgeAvailable: boolean;
  configured: boolean;
  registrationState: string;
  deviceCount: number;
  deviceName: string | null;
  linkState: string | null;
};

export type Pairing = {
  status: PairingStatus;
  label: string;
  detail: string;
  canStartWalk: boolean;
};

export function describePairing(input: PairingInput): Pairing {
  if (!input.bridgeAvailable) {
    return {
      status: "unavailable",
      label: "Not in this build",
      detail:
        "The glasses module is compiled into the app, so this build predates it. Rebuild the dev client — pairing cannot fix this.",
      canStartWalk: false,
    };
  }

  if (!input.configured) {
    return {
      status: "unconfigured",
      label: "Not ready",
      detail: "The wearables SDK has not been configured yet this session.",
      canStartWalk: false,
    };
  }

  if (input.registrationState !== "registered" || input.deviceCount === 0) {
    return {
      status: "unpaired",
      label: "Not paired",
      detail: "Pair your Meta glasses to record an AI walk.",
      canStartWalk: false,
    };
  }

  const name = input.deviceName ?? "Meta glasses";

  if (input.linkState !== "connected") {
    return {
      status: "disconnected",
      label: "Paired, not connected",
      // Deliberately avoids the word "pair" — they already did, and repeating it sends them
      // back through a flow that will tell them it is already done.
      detail: `${name} is registered but not reachable. Put them on and check Bluetooth.`,
      canStartWalk: false,
    };
  }

  return {
    status: "ready",
    label: "Ready",
    detail: `${name} connected.`,
    canStartWalk: true,
  };
}
```

- [ ] **Step 4: Run to verify pass** — 5 tests.
- [ ] **Step 5: Commit**

```bash
git add mobile/src/walkthrough/pairing.ts mobile/src/walkthrough/__tests__/pairing.test.ts
git commit -m "feat(mobile): pairing display state for the glasses row"
```

---

## Task 2: `useWalk` hook

**Files:**
- Create: `mobile/src/walkthrough/useWalk.ts`

Binds the pure reducer to the native recorder. Kept out of the screen so the screen is only layout.

- [ ] **Step 1: Implement**

```ts
/**
 * Drives a walk: reducer in, native recorder out.
 *
 * The screen renders `walk` and calls these three functions; it holds no lifecycle rules of its
 * own. Stills arrive asynchronously on a native event rather than as a return value, so they are
 * dispatched into the reducer, which drops any that land after the walk ended.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  initialWalk,
  reduceWalk,
  canCapture,
  type Walk,
  type StillSource,
} from "./session";
import { Recorder, onStill, onRecorderError, isAvailable } from "./native";

/** A walk id that is stable for this walk and usable as a directory name. */
function newWalkId(): string {
  return `walk-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function useWalk(dealId: string, projectId: string | null) {
  const [walk, dispatch] = useReducer(reduceWalk, undefined, () =>
    initialWalk(dealId, projectId)
  );
  const [error, setError] = useState<string | null>(null);
  const walkIdRef = useRef<string | null>(null);

  useEffect(() => {
    const offStill = onStill((still) => {
      dispatch({
        type: "still",
        uri: still.uri,
        at: Date.now(),
        source: still.source as StillSource,
      });
    });
    const offError = onRecorderError((e) => setError(e.message));
    return () => {
      offStill();
      offError();
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    dispatch({ type: "starting" });
    const id = newWalkId();
    walkIdRef.current = id;
    try {
      const started = await Recorder.startWalk(id);
      dispatch({ type: "started", at: Date.now(), videoUri: null });
      return started;
    } catch (e) {
      // Surfaced verbatim. Native's `walk_route_is_glasses` message names the input it would have
      // recorded from, which is the difference between "fix your Bluetooth" and "who knows".
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      dispatch({ type: "failed", reason: message });
      return null;
    }
  }, []);

  const capture = useCallback(async () => {
    if (!canCapture(walk)) return;
    try {
      await Recorder.captureStill();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [walk]);

  const end = useCallback(async () => {
    dispatch({ type: "ended", at: Date.now() });
    try {
      const result = await Recorder.endWalk();
      // `endWalk` resolves `videoUri` — audio is MUXED INTO walk.mp4, not written separately (see the
      // constraint above). An earlier draft of this plan destructured `audioUri` here, which typechecked
      // only because the Jest mocks are not checked against the real bridge, and would have silently
      // dropped both tracks from every walk.
      dispatch({ type: "finalized", audioUri: null, videoUri: result.videoUri, videoCensus: result.census });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // Still a failure, but the reducer keeps every artifact captured so far — a walk that
      // failed to finalise cleanly is not a walk that did not happen.
      dispatch({ type: "failed", reason: message });
      return null;
    }
  }, []);

  const stillCount = useMemo(() => walk.stills.length, [walk.stills]);

  return { walk, error, start, capture, end, stillCount, bridgeAvailable: isAvailable };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd mobile && npx tsc -p tsconfig.json --noEmit 2>&1 | grep walkthrough || echo "walkthrough: CLEAN"
```

- [ ] **Step 3: Commit**

```bash
git add mobile/src/walkthrough/useWalk.ts
git commit -m "feat(mobile): useWalk binds the recorder to the state machine"
```

---

## Task 3: The walk screen

**Files:**
- Create: `mobile/app/(app)/walk.tsx`

Read `app/(app)/dev-wearables.tsx` first for the project's screen conventions (theme import, `StyleSheet.create` at the bottom, `theme.color.*` / `theme.space.*` tokens).

Requirements — implement with your own judgement on layout, but all of these must hold:

- Reads `dealId`, `targetName`, `projectId` from route params via `useLocalSearchParams`
- Uses `useWalk(dealId, projectId)`
- **Before starting:** shows what will be recorded and a single large Start button
- **While recording:** an elapsed timer counting up from `walk.startedAt`, a large CAPTURE button (glasses still), a still counter, and End walk
- **CAPTURE is disabled unless `canCapture(walk)`** — never let a tap silently do nothing
- **Errors render prominently and verbatim.** A `walk_route_is_glasses` rejection carries the input it would otherwise have recorded from; that text is the whole value of the message and must not be replaced with "Could not start walk"
- **On complete:** shows a summary — duration, still count — and a Done button that navigates back
- The screen holds no lifecycle rules; it renders `walk.state` and calls `start`/`capture`/`end`

Do NOT add phone-camera capture in this task. It requires a photo-output-only `AVCaptureSession` with no audio input (the exact configuration Step 0 validated) and is its own task.

- [ ] **Step 1: Implement the screen**
- [ ] **Step 2: Typecheck clean, full suite still green**
- [ ] **Step 3: Commit** — `feat(mobile): the AI walk screen`

---

## Task 4: Profile pairing row

**Files:**
- Modify: `mobile/app/(app)/profile.tsx`

The existing `__DEV__`-gated "Wearables diagnostic" button stays. This adds a row visible in **release** builds, because a crew needs to see whether their glasses are ready without a developer.

- [ ] **Step 1:** Add a row that calls `Wearables.configure()` then `Wearables.status()` and `Wearables.diagnose()` on mount, feeds the results through `describePairing`, and renders `label` + `detail`. When `status === "unpaired"`, show a **Pair** button calling `Wearables.startRegistration()`.
- [ ] **Step 2:** Typecheck, tests, commit — `feat(mobile): glasses pairing row in Profile`

---

## Task 5: Entry point from capture

**Files:**
- Modify: `mobile/app/(app)/capture.tsx`
- Modify: `mobile/app/(app)/_layout.tsx` if it enumerates screens

`capture.tsx` is 1,361 lines. Add **one** button, nothing more. It routes to the walk screen carrying the same target params the capture screen already resolved, so the walk attaches to the same deal/project the crew already chose.

- [ ] **Step 1:** Add the button, visible only when a target is selected
- [ ] **Step 2:** Register the `walk` route if `_layout.tsx` enumerates screens
- [ ] **Step 3:** Typecheck, tests, commit — `feat(mobile): start an AI walk from capture`

---

## Definition of done

- [ ] All new unit tests pass; full suite green
- [ ] Typecheck clean for every touched file
- [ ] A walk can be started, capture stills, and be ended entirely from the UI
- [ ] `walk_route_is_glasses` renders its native message verbatim

## Hardware verification (Adnaan, with glasses)

1. Profile shows **Ready** with the glasses connected, and **Paired, not connected** with them off
2. Start a walk with glasses off → refuses, naming the input it would have recorded from
3. Start with glasses on → timer runs, CAPTURE increments the still counter
4. End → summary shows duration and count; glasses return to A2DP (audible)

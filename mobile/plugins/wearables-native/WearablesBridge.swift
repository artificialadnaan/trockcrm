/*
 * Bridge between React Native and the Meta Wearables Device Access Toolkit.
 *
 * This file lives in the APP target rather than in an Expo module, because the DAT SDK is a
 * Swift Package attached to the app target and a CocoaPods-built Expo module cannot import
 * it. `withWearablesDat` copies this file in and registers it in Sources on every prebuild.
 *
 * Every method here exists to answer one question on the diagnostic screen, in order, so a
 * failure names its own rung. The two that matter are `capturePhotoAndMeasure` and
 * `recordGlassesAudio`: those return measurements, not booleans, and between them they
 * decide whether capture moves into this app at all.
 */
import AVFoundation
import Foundation
import MWDATCamera
import MWDATCore
import React
import UIKit

@objc(WearablesBridge)
final class WearablesBridge: RCTEventEmitter {
  private var session: DeviceSession?
  // Fully qualified: bare `Stream` is ambiguous once Foundation is imported, because
  // Foundation.Stream is the base class behind InputStream/OutputStream.
  private var stream: MWDATCamera.Stream?
  private var photoToken: AnyListenerToken?
  private var frameToken: AnyListenerToken?
  private var hasListeners = false

  /// First frame seen since the stream started, used to report real delivered dimensions
  /// rather than the ones we asked for.
  private var firstFrameSize: CGSize?
  private var firstFrameAt: Date?
  private var streamStartedAt: Date?

  /// Frames arrive on the SDK's delivery thread at video rate while `streamInfo()` reads from
  /// the RN bridge queue and `teardown()` writes from a Task. Three threads, unsynchronised
  /// stored properties: a data race by construction.
  ///
  /// KNOWN GAP, deliberately not closed here: `session`, `stream`, `frameToken` and `photoToken`
  /// are still WRITTEN outside this lock (each rung publishes them from its own Task). `sweep()`
  /// now reads and clears them under it, which is what makes teardown atomic, but a publish
  /// racing a sweep is still unsynchronised. Closing it properly means routing every access to
  /// those four through the lock, which is a wider change than the races this file was opened to
  /// fix. See the PR description.
  private let stateLock = NSLock()

  /// Bumped by every sweep — `teardown()` unconditionally, `teardownIfCurrent(_:)` only when it
  /// wins its claim. Each rung's `Task` captures the value as of when it began and rechecks it at
  /// every significant step; a mismatch means a `stopStream()` (or a newer rung) ran while this
  /// Task was waiting on the selector, the session, or `addStream()` — and continuing would
  /// create and start a stream after the UI was already told everything stopped.
  ///
  /// The bump happens BEFORE the objects are stopped, so "generation unchanged" genuinely implies
  /// "not swept yet". The converse does not hold: "generation changed" does NOT imply the sweeper
  /// saw this run's objects, because a rung can publish after a sweep has already passed. That is
  /// why the superseded branches stop their own local references instead of assuming.
  private var teardownGeneration = 0

  /// How many rungs currently hold the shared `AVAudioSession` active. A COUNT, not a flag: rungs
  /// overlap (the dev screen disables its buttons per-rung, so a second one is a tap away), and one
  /// boolean cannot say "two owners". As a flag, a sweep from a stream rung consumed the single bit
  /// and deactivated HFP out from under `checkPhoneCameraDuringHfp` — which has no generation of its
  /// own — in the middle of the very route measurements that rung exists to take.
  ///
  /// Guarded by `stateLock`. Only reaches zero, and only then deactivates, when the last owner
  /// releases; the app's OTHER owner of that singleton (`WalkthroughRecorder`) is never counted
  /// here and so is never reached into.
  private var audioSessionOwners = 0

  /// Bumped on every publish to `session`/`stream` AND by every sweep. A rung captures the value its
  /// own publish produced, so it can retract its publication ONLY while it is still the live one.
  ///
  /// An Int rather than an `===` identity check on purpose: the SDK types cannot be compiled against
  /// locally, so whether they are classes or structs is not something this file can verify, and a
  /// reference-identity comparison that fails to build is a compile error nothing here would catch.
  private var publicationId = 0

  /// Serialises the STOPPING half of a sweep, which happens outside `stateLock`.
  ///
  /// Detaching under `stateLock` and stopping after it is what makes the sweep atomic, but it also
  /// means `teardown()` could RETURN while the previous session was still being stopped. The next
  /// rung's precondition teardown would then find both fields already nil, return immediately, and
  /// call `createSession()` — and only one session may run on a device at a time, so it failed with
  /// `sessionAlreadyExists`: our own litter again, one level down from where it was fixed.
  ///
  /// A separate lock, never taken by the frame listener, so serialising the stops cannot deadlock
  /// against it the way holding `stateLock` across `stop()` would.
  private let teardownLock = NSLock()

  /// Serialises audio-session ACTIVATION against last-owner DEACTIVATION. Ordering rule: take this
  /// before `stateLock`, never after.
  private let audioLock = NSLock()

  /// Bumped every time `forceReleaseAllAudioOwnership()` wipes the count. A rung captures the epoch
  /// it acquired under and releases against it, so a release invalidated by a reset cannot consume an
  /// acquisition that came AFTER it.
  ///
  /// An anonymous count alone was not enough, and the previous revision's commit message asserted the
  /// opposite as fact: it said a superseded rung's late release "finds no owners and no-ops". That is
  /// only true while nobody else has acquired. If a newer HFP or phone-audio rung takes ownership
  /// before the old task reaches its `defer`, the stale release decrements the NEWER count to zero and
  /// deactivates the session that rung is mid-measurement on. Guarded by `stateLock`.
  private var audioEpoch = 0

  /// A deactivation that was attempted and FAILED, still owed. Distinct from an owner count on
  /// purpose — see `deactivateHoldingAudioLock()`. Guarded by `stateLock`.
  private var audioDeactivationOwed = false

  /// `Wearables.configure()` is not idempotent in 0.8.0, so the guard lives here rather
  /// than trusting every JS caller to remember. Internal (not `private`), deliberately: this is
  /// the single source of truth for "has configure() actually succeeded", and
  /// `WalkthroughRecorder.startWalk` reads it directly for its own configured guard — a second,
  /// separately-tracked flag over there could drift out of sync with what this class actually did.
  static var configured = false

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String] { ["wearables:photo", "wearables:frame"] }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }


  /// SDK errors conform to `DatError: LocalizedError` and carry a real `.description`
  /// naming the case. `String(describing:)` on these @objc Int-backed enums prints a
  /// bridged pointer instead ("rawValue: 4513667408"), which is worse than useless when
  /// the whole point of a diagnostic is to name what failed.
  private static func describe(_ error: Error) -> String {
    if let dat = error as? DatError {
      return "\(dat.description) [\(String(reflecting: type(of: dat)))]"
    }
    return error.localizedDescription
  }

  /// One audio-route reading, reported raw. Whether a reading is good or bad is decided in JS
  /// (`step0-verdicts.ts`), because that is the part that can be unit-tested.
  private static func routeSnapshot(_ session: AVAudioSession) -> [String: Any] {
    let input = session.currentRoute.inputs.first
    return [
      "portType": input?.portType.rawValue ?? "none",
      "portName": input?.portName ?? "none",
      "sampleRate": session.sampleRate,
      "isBluetoothHFP": input?.portType == .bluetoothHFP,
    ]
  }

  /// Bring up the HFP microphone route and wait for it to stabilize. Meta's guidance is explicit
  /// that the route "needs time to stabilize"; reading it immediately reports the built-in mic.
  private func activateHfpAndSettle() async throws -> (session: AVAudioSession, audioEpoch: Int) {
    let session = AVAudioSession.sharedInstance()
    // Activation and acquisition are ONE transition — see `withAudioSessionActivation`. Registered
    // here, not after the settle below: the session is active from this point onward, and the
    // caller's `defer { releaseAudioSession(epoch:) }` is what hands it back on every path.
    let epoch = try withAudioSessionActivation {
      try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP])
      try session.setActive(true)
    }
    let deadline = Date().addingTimeInterval(3)
    while !session.currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }),
          Date() < deadline {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return (session, epoch)
  }

  // MARK: - 1. Configure

  @objc(configure:rejecter:)
  func configure(_ resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    if Self.configured {
      resolve(["configured": true, "alreadyConfigured": true])
      return
    }
    do {
      try Wearables.configure()
      Self.configured = true
      resolve(["configured": true, "alreadyConfigured": false])
    } catch {
      // Surfaced, never swallowed: a failed configure is indistinguishable from "no glasses
      // paired" once you are looking at JS, and that ambiguity costs hours.
      reject("wearables_configure_failed", "Wearables.configure() failed: \(Self.describe(error))", error)
    }
  }

  // MARK: - 2. Developer mode / build capabilities

  @objc(capabilities:rejecter:)
  func capabilities(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    var mockAvailable = false
    #if DEBUG
    mockAvailable = true
    #endif
    let info = Bundle.main.object(forInfoDictionaryKey: "MWDAT") as? [String: Any] ?? [:]
    let appId = info["MetaAppID"] as? String ?? ""
    resolve([
      "configured": Self.configured,
      "mockDeviceKitAvailable": mockAvailable,
      "metaAppId": appId,
      "developerMode": appId == "0",   // the SDK's documented Developer Mode sentinel
      "appLinkURLScheme": info["AppLinkURLScheme"] as? String ?? "",
      // The stream ceiling, read straight from the SDK instead of inferred from one run.
      // `StreamConfiguration()` defaults to .medium, so a single measured stream says nothing
      // about what .high would deliver — and that is the number the stills-vs-frames decision
      // actually turns on. No session or glasses required to read it.
      "streamResolutions": StreamingResolution.allCases.reduce(into: [String: String]()) { acc, res in
        let size = res.videoFrameSize
        acc[String(describing: res)] = "\(size.width)x\(size.height)"
      },
    ])
  }

  // MARK: - 3. Registration

  @objc(status:rejecter:)
  func status(_ resolve: @escaping RCTPromiseResolveBlock,
              rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard Self.configured else {
      reject("wearables_not_configured", "Call configure() first", nil)
      return
    }
    let sdk = Wearables.shared
    resolve([
      "registrationState": Self.registrationStateName(sdk.registrationState),
      "registrationStateRaw": sdk.registrationState.rawValue,
      "deviceCount": sdk.devices.count,
      "devices": sdk.devices.map { String(describing: $0) },
    ])
  }

  @objc(startRegistration:rejecter:)
  func startRegistration(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        try await Wearables.shared.startRegistration()
        resolve(["started": true])
      } catch {
        reject("wearables_registration_failed", "startRegistration failed: \(Self.describe(error))", error)
      }
    }
  }

  @objc(handleUrl:resolver:rejecter:)
  func handleUrl(_ url: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let parsed = URL(string: url) else {
      reject("wearables_bad_url", "Not a URL: \(url)", nil)
      return
    }
    Task {
      do {
        resolve(["handled": try await Wearables.shared.handleUrl(parsed)])
      } catch {
        reject("wearables_handle_url_failed", "handleUrl failed: \(Self.describe(error))", error)
      }
    }
  }

  // MARK: - 4b. Why is there no eligible device?

  /// `noEligibleDevice` is the least informative error this SDK produces. It means exactly one
  /// thing — `AutoDeviceSelector.activeDevice` was nil when `createSession` asked — and it says
  /// nothing about WHICH gate failed. Every gate is readable, so read them all and report them.
  ///
  /// The `immediate` vs `afterWait` pair is the important measurement: `activeDevice` is
  /// published through an async stream, so it is nil for a short window after construction. If
  /// immediate is nil and afterWait is not, the device was never ineligible — the call site was
  /// simply racing the selector.
  @objc(diagnose:rejecter:)
  func diagnose(_ resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard Self.configured else {
      reject("wearables_not_configured", "Call configure() first", nil)
      return
    }
    let sdk = Wearables.shared
    Task {
      let details: [[String: Any]] = sdk.devices.map { id in
        guard let device = sdk.deviceForIdentifier(id) else {
          return ["id": String(describing: id), "resolved": false]
        }
        return [
          "name": device.name,
          // .disconnected here means the glasses are paired for Bluetooth audio but not linked
          // over the DAT transport, which is a completely different connection.
          "linkState": String(describing: device.linkState),
          // .deviceUpdateRequired / .sdkUpdateRequired both make a device ineligible while
          // still leaving it registered and counted.
          "compatibility": String(describing: device.compatibility()),
          "deviceType": device.deviceType().rawValue,
          "supportsDisplay": device.supportsDisplay(),
        ]
      }

      let selector = AutoDeviceSelector(wearables: sdk)
      let immediate = selector.activeDevice
      var afterWait = immediate
      let deadline = Date().addingTimeInterval(8)
      while afterWait == nil, Date() < deadline {
        try? await Task.sleep(nanoseconds: 200_000_000)
        afterWait = selector.activeDevice
      }

      // Read, never request: requestPermission() bounces to Meta AI and back, which is far too
      // heavy for a diagnostic and loses the answer if the round trip breaks.
      var permission: String
      do {
        permission = String(describing: try await sdk.checkPermissionStatus(.camera))
      } catch {
        permission = "error: \(Self.describe(error))"
      }

      resolve([
        "deviceCount": sdk.devices.count,
        "devices": details,
        "cameraPermission": permission,
        "activeDeviceImmediate": immediate.map { String(describing: $0) } ?? "nil",
        "activeDeviceAfterWait": afterWait.map { String(describing: $0) } ?? "nil",
        "verdict": Self.eligibilityVerdict(immediate: immediate, afterWait: afterWait),
      ])
    }
  }

  private static func eligibilityVerdict(immediate: DeviceIdentifier?,
                                         afterWait: DeviceIdentifier?) -> String {
    if immediate != nil { return "eligible immediately — noEligibleDevice is NOT a selector race" }
    if afterWait != nil { return "RACE: nil at first, resolved after waiting. startStream was asking too early." }
    return "genuinely ineligible after 8s — check linkState and compatibility above"
  }

  /// RegistrationState is an @objc Int enum whose default printing is unhelpful.
  private static func registrationStateName(_ state: RegistrationState) -> String {
    switch state {
    case .unavailable: return "unavailable"   // no Meta AI / no glasses reachable
    case .available: return "available"
    case .registering: return "registering"
    case .registered: return "registered"
    @unknown default: return "unknown(\(state.rawValue))"
    }
  }

  // MARK: - 4. Camera permission

  @objc(requestCameraPermission:rejecter:)
  func requestCameraPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        let status = try await Wearables.shared.requestPermission(.camera)
        resolve(["status": String(describing: status)])
      } catch {
        reject("wearables_permission_failed", "requestPermission(.camera) failed: \(Self.describe(error))", error)
      }
    }
  }

  // MARK: - 5/6. Session and stream

  @objc(startStream:rejecter:)
  func startStream(_ resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    // The guard `status()` has and this method did not. `Self.configured` is per-process, so a
    // relaunched app reaches createSession against an unconfigured SDK and gets back
    // `noEligibleDevice` — which blames the glasses for something that happened in here.
    guard Self.configured else {
      reject("wearables_not_configured", "Call configure() first", nil)
      return
    }
    // Clear anything a previous attempt left behind. Every early return below used to abandon
    // a live SDK session, so the NEXT attempt failed with `sessionAlreadyExists` — an error
    // about our own litter that reads like a problem with the glasses. Retrying a diagnostic
    // must not be what breaks it.
    teardown()

    // Captured after the teardown() above, so it reflects this call's own starting point. Every
    // significant await below rechecks this: if it has moved on, a stop() (or a newer
    // startStream()) ran while this Task was waiting, and creating or starting anything past
    // that point would run behind the UI's back.
    let myGeneration = currentTeardownGeneration()

    // Reset the frame measurement synchronously, BEFORE the Task. NSLock's lock()/unlock() are
    // unavailable from async contexts — a task can suspend while holding the lock — and that is
    // a hard error under Swift 6. Nothing here needs to be async, so it simply moves out.
    stateLock.lock()
    firstFrameSize = nil
    firstFrameAt = nil
    streamStartedAt = Date()
    stateLock.unlock()

    Task {
      // Declared out here so the `catch` can reach them; the `let`s inside the `do` cannot
      // be seen from it, so without these a superseded run's catch path can stop nothing.
      var createdRef: DeviceSession?
      var streamRef: MWDATCamera.Stream?
      // The publication this run currently owns, 0 until it publishes. Hoisted for the same reason
      // the refs are: the `catch` cannot see anything declared inside the `do`.
      var publicationTicket = 0
      do {
        let sdk = Wearables.shared
        let selector = AutoDeviceSelector(wearables: sdk)
        // AutoDeviceSelector publishes activeDevice through an async stream, so it is nil for a
        // window after construction. Calling createSession on the next line races that window,
        // and createSession turns a nil activeDevice into `noEligibleDevice` — an error that
        // reads as "your glasses are missing" when it actually means "you asked too early".
        let deadline = Date().addingTimeInterval(8)
        while selector.activeDevice == nil, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard selector.activeDevice != nil else {
          reject(
            "wearables_no_active_device",
            "No active device after 8s (registered: \(sdk.devices.count)). Run rung 4b for link "
              + "state and compatibility.",
            nil
          )
          return
        }
        // Checkpoint 1, now atomic with the creation it guards — see `createAndPublishSession`.
        // A separate check followed by a separate create leaves a gap in which a sweep lands and
        // this superseded task still takes the device.
        //
        // `createdRef` is held outside the `do` so the `catch` can reach it: an un-stopped
        // DeviceSession is not a quiet leak — only one may run on a device at a time, so it blocks
        // every later createSession with the `sessionAlreadyExists` failure this file already calls
        // "our own litter".
        guard let opened = try createAndPublishSession(ifGeneration: myGeneration, {
          try sdk.createSession(deviceSelector: selector)
        }) else {
          reject("wearables_stream_superseded",
                 "startStream was superseded by stop() while waiting for a device", nil)
          return
        }
        let created = opened.session
        createdRef = created
        publicationTicket = opened.ticket
        try created.start()

        // start() only moves the session to .starting. The transition to .started happens
        // asynchronously, and addStream() on a session that has not reached .started returns
        // nil — the same "asked too early" mistake as the selector race, one layer down. nil
        // carries no reason, so the state is reported instead of guessed at.
        let startDeadline = Date().addingTimeInterval(10)
        while created.state != .started, Date() < startDeadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard created.state == .started else {
          let stalled = created.state.description
          // This is reached up to 10s after the wait began, which is ample time for a stop() or a
          // newer startStream() to have taken over. Tear down shared state only if it is still
          // ours; if it is not, `created` is an orphan nobody else has a reference to, so stopping
          // it is this path's own responsibility.
          if !teardownIfCurrent(myGeneration) {
            retract(publicationTicket)
            stopOrphans(stream: nil, session: created)
          }
          reject(
            "wearables_session_not_started",
            "Session never reached .started — stalled in \(stalled) after 10s",
            nil
          )
          return
        }
        // Checkpoint 2: a concurrent teardown() may already have stopped and nilled
        // `self.session` — or, if the user was fast enough, a NEWER startStream() may already
        // own that property. Either way it is no longer safe to touch `self.session` here; only
        // stop the LOCAL `created` reference, which is unambiguously ours.
        guard currentTeardownGeneration() == myGeneration else {
          // `created` is already published, so if the sweep landed before that publish the shared
          // `session` still points at what this line is about to stop.
          retract(publicationTicket)
          stopOrphans(stream: nil, session: created)
          reject("wearables_stream_superseded",
                 "startStream was superseded by stop() after the session reached .started", nil)
          return
        }

        guard let newStream = try created.addStream() else {
          let state = created.state.description
          // Same reasoning as the `.started` timeout above: only tear down what is still ours.
          if !teardownIfCurrent(myGeneration) {
            retract(publicationTicket)
            stopOrphans(stream: nil, session: created)
          }
          reject("wearables_stream_nil", "addStream() returned nil (session state: \(state))", nil)
          return
        }
        // Checkpoint 3: same reasoning as checkpoint 2, one step later. `self.stream` has not
        // been assigned yet, so a concurrent teardown() could not have stopped `newStream` —
        // stopping it here is not defensive, it is the only place it happens.
        guard currentTeardownGeneration() == myGeneration else {
          retract(publicationTicket)
          stopOrphans(stream: newStream, session: created)
          reject("wearables_stream_superseded",
                 "startStream was superseded by stop() after addStream()", nil)
          return
        }
        streamRef = newStream
        publicationTicket = publish(stream: newStream, session: nil)

      // Record what the FIRST frame actually measures. The configuration says what we asked
      // for; only a delivered frame says what the glasses sent.
      frameToken = newStream.videoFramePublisher.listen { [weak self] (frame: VideoFrame) in
        guard let self else { return }
        // Check under the lock before decoding: at 30fps an unguarded read races every write
        // below, and decoding each frame only to discard it is pure waste once we have one.
        self.stateLock.lock()
        let alreadyMeasured = self.firstFrameSize != nil
        self.stateLock.unlock()
        guard !alreadyMeasured, let image = frame.makeUIImage() else { return }

        self.stateLock.lock()
        if self.firstFrameSize == nil {
          self.firstFrameSize = image.size
          self.firstFrameAt = Date()
        }
        self.stateLock.unlock()
      }

      photoToken = newStream.photoDataPublisher.listen { [weak self] (photo: PhotoData) in
        self?.deliverPhoto(photo)
      }

      // Checkpoint 4, and the reason there is a re-check AFTER start() as well.
      //
      // `stream` was published above, so from here a concurrent teardown() can and will stop
      // `newStream`. Checking the generation and then calling start() is check-then-act: a
      // teardown landing in that window stops a stream this line then starts again, leaving a
      // live stream the UI believes it stopped — frames flowing, HFP held, nothing on screen
      // owning it. The window cannot be closed by holding `stateLock` across start(), because
      // the frame listener installed above takes that same lock and NSLock is not recursive.
      //
      // So: check, start, then check again and undo. The stream is briefly started when it should
      // not be, but it does not stay that way, and the resolve() below never reports success for
      // a run that was superseded.
      guard currentTeardownGeneration() == myGeneration else {
        // Retract FIRST, same as every other superseded path. `stream` was published above, so if
        // the sweep landed before that publish it never saw `newStream` — and without this the
        // shared field and the listener tokens keep pointing at a stream this line is about to
        // stop, so `capturePhoto()` accepts a dead stream until something else sweeps.
        retract(publicationTicket)
        stopOrphans(stream: newStream, session: created)
        reject("wearables_stream_superseded",
               "startStream was superseded by stop() before the stream was started", nil)
        return
      }
      newStream.start()
      // Symmetric with the guard above on purpose. `created` is stopped here too even though the
      // sweeper that failed this guard will already have stopped it: for this guard to fail, the
      // bump must have landed during `start()`, and at that instant `self.session` still held
      // `created` and `self.stream` still held `newStream`, so the sweep did reach both. That
      // argument depends on facts several screens apart, and stopping twice costs nothing —
      // relying on it silently is how it rots into a leak the next time the publish order moves.
      guard currentTeardownGeneration() == myGeneration else {
        retract(publicationTicket)
        stopOrphans(stream: newStream, session: created)
        reject("wearables_stream_superseded",
               "startStream was superseded by stop() as the stream was starting", nil)
        return
      }
      resolve(["started": true, "config": String(describing: newStream.streamConfiguration)])
      } catch {
        // A superseded run cannot assume the sweeper saw its objects: the publish above is not
        // generation-checked, so it can land after the sweep. `createdRef`/`streamRef` exist for
        // exactly this path.
        if !teardownIfCurrent(myGeneration) {
          retract(publicationTicket)
          stopOrphans(stream: streamRef, session: createdRef)
        }
        reject("wearables_stream_failed", "startStream failed: \(Self.describe(error))", error)
      }
    }
  }

  @objc(streamInfo:rejecter:)
  func streamInfo(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    stateLock.lock()
    let snapshot = (firstFrameSize, firstFrameAt, streamStartedAt)
    stateLock.unlock()
    guard let size = snapshot.0, let at = snapshot.1, let started = snapshot.2 else {
      resolve(["hasFrame": false])
      return
    }
    resolve([
      "hasFrame": true,
      "width": Int(size.width),
      "height": Int(size.height),
      "megapixels": (size.width * size.height) / 1_000_000.0,
      "firstFrameSeconds": at.timeIntervalSince(started),
    ])
  }

  @objc(stopStream:rejecter:)
  func stopStream(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    teardown()
    resolve(["stopped": true])
  }

  /// Stop and forget the current session and stream. Safe to call when there is nothing to tear
  /// down, which is what lets `startStream` use it as a precondition rather than a cleanup.
  ///
  /// Unconditional: this is what a user-initiated `stopStream()` or the start of a new rung wants.
  /// A long-running rung's OWN failure path must use `teardownIfCurrent(_:)` instead — see there.
  /// All five callers are user-initiated and run on the serial RN method queue: `stopStream()` and
  /// each rung's precondition. That serialisation is load-bearing — it is why the unconditional
  /// form cannot interleave with itself.
  private func teardown() {
    sweep(ifGeneration: nil)
  }

  /// Tear down ONLY if `generation` is still current — i.e. only if nothing has superseded the
  /// caller since it captured that value.
  ///
  /// The rungs below each run a Task that lives for seconds (up to 180 for the measure rungs) and
  /// owns `session`/`stream` for its duration. Their failure and completion paths used to call
  /// `teardown()` unconditionally, which meant a rung the user had already moved on from would,
  /// on its way out, stop the session belonging to whatever is running NOW. The superseded run
  /// then reported a failure caused by nothing but its own lateness, and the current run died
  /// with no explanation at all.
  ///
  /// Returns `true` if this call won the claim and performed the teardown, `false` if it was
  /// superseded. A `false` return means shared state now belongs to someone else, so the caller
  /// must clean up only the local objects it created itself.
  ///
  /// The compare and the bump happen under a single acquisition: checking first and tearing down
  /// afterwards would be the same check-then-act race one level up.
  @discardableResult
  private func teardownIfCurrent(_ generation: Int) -> Bool {
    sweep(ifGeneration: generation)
  }

  /// The ONE place the generation moves and the owned objects are detached. `generation == nil`
  /// means unconditional.
  ///
  /// The compare, the bump and the DETACH all happen inside a single acquisition. Bumping under
  /// the lock but reading `session`/`stream` afterwards would leave the claim atomic and the sweep
  /// not: a sweeper preempted between the two could resume much later and stop objects a newer run
  /// had since published — the very bug this file is fixing, reintroduced by its own fix.
  ///
  /// The `stop()` calls stay OUTSIDE the lock. The frame listener takes `stateLock` and `NSLock`
  /// is not recursive, so stopping under it risks a deadlock if the SDK ever delivers synchronously.
  /// Detaching first makes that safe: once the fields are nil'd under the lock, the objects in hand
  /// are unreachable by anyone else and can be stopped at leisure.
  @discardableResult
  private func sweep(ifGeneration generation: Int?) -> Bool {
    stateLock.lock()
    if let generation, teardownGeneration != generation {
      stateLock.unlock()
      return false
    }
    teardownGeneration += 1
    // Invalidates every outstanding publication ticket, so a rung that publishes AFTER this sweep
    // holds an id that no longer matches and will not retract a newer run's objects.
    publicationId += 1
    let doomedStream = stream
    let doomedSession = session
    stream = nil
    session = nil
    frameToken = nil
    photoToken = nil
    stateLock.unlock()

    // AUDIO: cleared by an UNCONDITIONAL sweep, left alone by a claimed one. The distinction is the
    // whole point.
    //
    // `teardown()` is only ever called by `stopStream()` or a rung's own precondition — i.e. the user
    // has just said "stop that and start this". Superseding IS the intent, so the world must be reset
    // including the audio route. Leaving it to the old task's `defer` meant `measureStreamWithoutAudio`
    // could run its entire 1-180s window under an HFP or phone-audio session belonging to a rung that
    // had not finished exiting, while reporting `audioSessionUsed: false` — corrupting the one
    // comparison that rung exists to make, and the one the shipped design rests on.
    //
    // `teardownIfCurrent` must NOT do this: there the caller is a late run cleaning up after itself,
    // and the audio it would deactivate belongs to whatever superseded it.
    //
    // AN EARLIER REVISION CLAIMED forcing the count was safe because "the old rung's eventual release
    // finds no owners and no-ops". That is only true while nobody else has acquired. If a newer rung
    // takes ownership before the old task reaches its `defer`, the stale release decrements the NEWER
    // count to zero and deactivates a session that rung is mid-measurement on. The epoch bumped below
    // is what actually makes this safe: a release carrying a superseded epoch is refused outright.
    if generation == nil {
        forceReleaseAllAudioOwnership()
    }
    //
    // Serialised so that when this returns, the stopping is genuinely finished and the next
    // `createSession()` cannot race it.
    teardownLock.lock()
    doomedStream?.stop()
    doomedSession?.stop()
    teardownLock.unlock()
    return true
  }

  /// Publish this run's objects and take a ticket that says "these are the live ones".
  private func publish(stream newStream: MWDATCamera.Stream?, session newSession: DeviceSession?) -> Int {
    stateLock.lock()
    publicationId += 1
    let ticket = publicationId
    if let newStream { stream = newStream }
    if let newSession { session = newSession }
    stateLock.unlock()
    return ticket
  }

  /// Drop every audio share and deactivate, for a user-initiated reset. Distinct from
  /// `releaseAudioSession()`, which gives up ONE share.
  private func forceReleaseAllAudioOwnership() {
    audioLock.lock()
    defer { audioLock.unlock() }
    stateLock.lock()
    let hadOwners = audioSessionOwners > 0
    let owed = audioDeactivationOwed
    audioSessionOwners = 0
    // Invalidates every outstanding share, so the deferred releases that still refer to them cannot
    // consume an acquisition made after this reset.
    audioEpoch += 1
    stateLock.unlock()
    guard hadOwners || owed else { return }
    deactivateHoldingAudioLock()
  }

  /// Claim the generation, create the device session and publish it as ONE serialised step.
  ///
  /// Checking the generation and then creating is check-then-act, and the gap is not academic: only
  /// one session may run on a device at a time, so a sweep landing in it lets a SUPERSEDED task take
  /// the device and hold it for its whole 1-180s window, while the newer rung — the one the user is
  /// actually looking at — fails with `sessionAlreadyExists`. Serialised on `teardownLock` so a
  /// concurrent precondition sweep cannot interleave, which is the same lock that already makes a
  /// sweep's stops finish before the next creation.
  ///
  /// Returns nil when superseded, having created nothing.
  private func createAndPublishSession(
    ifGeneration generation: Int,
    _ make: () throws -> DeviceSession?
  ) rethrows -> (session: DeviceSession, ticket: Int)? {
    teardownLock.lock()
    defer { teardownLock.unlock() }

    stateLock.lock()
    let current = teardownGeneration
    stateLock.unlock()
    guard current == generation else { return nil }

    guard let created = try make() else { return nil }
    let ticket = publish(stream: nil, session: created)
    return (created, ticket)
  }

  /// Stop objects this run created that no sweep will ever see, under the SAME serialisation a sweep
  /// uses.
  ///
  /// Stopping them outside `teardownLock` reopened the race the lock exists to close: a newly tapped
  /// rung could run its precondition sweep, find nothing, return, and call `createSession()` while
  /// these stops were still in progress — `sessionAlreadyExists` again, by a different door.
  private func stopOrphans(stream orphanStream: MWDATCamera.Stream?, session orphanSession: DeviceSession?) {
    teardownLock.lock()
    orphanStream?.stop()
    orphanSession?.stop()
    teardownLock.unlock()
  }

  /// Retract a publication, but ONLY while it is still the live one.
  ///
  /// A rung that publishes after a sweep has already passed leaves the shared fields pointing at
  /// objects it then stops locally. Without this, `capturePhoto()` and `recordGlassesAudio()` go on
  /// reporting a live stream that has actually been stopped, until some unrelated future sweep
  /// clears it. Ticketed rather than unconditional, so a run that was superseded by a NEWER publish
  /// does not clear that newer run's fields on its way out.
  private func retract(_ ticket: Int) {
    stateLock.lock()
    if publicationId == ticket {
      stream = nil
      session = nil
      frameToken = nil
      photoToken = nil
    }
    stateLock.unlock()
  }

  /// Take a share of the shared `AVAudioSession`. Called IMMEDIATELY after `setActive(true)` and
  /// before any settling wait: registering after the wait left a window in which the session was
  /// already active but unowned, so a sweep in that window could not hand it back and the rung then
  /// claimed ownership it could no longer act on — HFP live with nobody accountable for it.
  /// Run `activate` (the `setCategory`/`setActive(true)` pair) and take a share, as ONE serialised
  /// transition.
  ///
  /// Acquiring after activating, without this lock, exposed a zero-owner window: a rung releasing the
  /// last share could be between "owners hit 0" and `setActive(false)` while another rung activated
  /// and acquired, and the old release then deactivated the session the new rung had just brought up —
  /// corrupting exactly the route measurements it was about to take.
  ///
  /// `audioLock` is always taken BEFORE `stateLock`, never the other way round, so the two cannot
  /// deadlock against each other.
  /// Returns the epoch this share was taken under — pass it back to `releaseAudioSession(epoch:)`.
  @discardableResult
  private func withAudioSessionActivation(_ activate: () throws -> Void) throws -> Int {
    audioLock.lock()
    defer { audioLock.unlock() }
    try activate()
    stateLock.lock()
    audioSessionOwners += 1
    // Somebody wants it active again, so any deactivation still owed from before is moot.
    audioDeactivationOwed = false
    let epoch = audioEpoch
    stateLock.unlock()
    return epoch
  }

  /// Give up this rung's share, deactivating only when the last one goes.
  ///
  /// Called by the rung itself on EVERY exit — success, failure, and superseded alike — rather than
  /// by whichever sweep happens to win. A superseded rung still owns the audio it activated, and
  /// gating the release on the teardown claim is what left HFP pinned for the life of the process.
  ///
  /// If the deactivation FAILS the share is put back rather than dropped. `setActive(false)` throws
  /// while audio I/O is still running — an `AVAudioRecorder` mid-measurement is exactly that — and
  /// swallowing it while clearing the ownership meant nothing would ever try again, so a
  /// `.playAndRecord` session stayed live and invalidated the next no-audio measurement.
  private func releaseAudioSession(epoch: Int) {
    audioLock.lock()
    defer { audioLock.unlock() }

    stateLock.lock()
    // OUR SHARE WAS ALREADY WIPED. A user-initiated sweep zeroed the count while this rung was still
    // running; the share this release refers to no longer exists, and any owners present now belong
    // to a rung that started afterwards. Decrementing here would deactivate THEIR session.
    guard epoch == audioEpoch else {
      stateLock.unlock()
      return
    }
    guard audioSessionOwners > 0 else {
      let owed = audioDeactivationOwed
      stateLock.unlock()
      // Nothing of ours to give up, but a previous last-owner deactivation may still be owed.
      if owed { deactivateHoldingAudioLock() }
      return
    }
    audioSessionOwners -= 1
    let isLastOwner = audioSessionOwners == 0
    stateLock.unlock()
    guard isLastOwner else { return }
    deactivateHoldingAudioLock()
  }

  /// Deactivate, recording DEBT on failure rather than inventing an owner.
  ///
  /// The previous revision restored `audioSessionOwners` when `setActive(false)` threw. That reads as
  /// "put the share back", but the rung that held it has already exited and its `defer` has already
  /// run — so the restored count belonged to nobody. Every later rung then went 1 -> 2 -> 1, the
  /// last-owner branch was never reached again, and the session stayed active for the life of the
  /// process: the exact failure the retry was added to prevent, made permanent instead of transient.
  ///
  /// A separate flag is retryable without being owned. Caller must hold `audioLock`.
  private func deactivateHoldingAudioLock() {
    do {
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      stateLock.lock()
      audioDeactivationOwed = false
      stateLock.unlock()
    } catch {
      stateLock.lock()
      audioDeactivationOwed = true
      stateLock.unlock()
    }
  }

  /// Reads `teardownGeneration` under `stateLock`. Always call this instead of touching the
  /// property directly — and never from code that might suspend between lock and unlock.
  private func currentTeardownGeneration() -> Int {
    stateLock.lock()
    defer { stateLock.unlock() }
    return teardownGeneration
  }

  // MARK: - 7. THE photo question

  /// `capturePhoto` is fire-and-forget and returns only whether the request was accepted;
  /// the image arrives later on `photoDataPublisher`. `PhotoData` carries bytes and a format
  /// but NO dimensions, so the only way to learn the real resolution is to decode it.
  @objc(capturePhoto:rejecter:)
  func capturePhoto(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let stream else {
      reject("wearables_no_stream", "Start a stream before capturing a photo", nil)
      return
    }
    let accepted = stream.capturePhoto(format: .jpeg)
    resolve(["requested": accepted])
  }

  private func deliverPhoto(_ photo: PhotoData) {
    let bytes = photo.data.count
    var payload: [String: Any] = [
      "bytes": bytes,
      "format": String(describing: photo.format),
    ]
    if let image = UIImage(data: photo.data) {
      let w = image.size.width * image.scale
      let h = image.size.height * image.scale
      payload["width"] = Int(w)
      payload["height"] = Int(h)
      payload["megapixels"] = (w * h) / 1_000_000.0
      // The comparison that decides the architecture: a still meaningfully larger than the
      // 720x1280 stream ceiling means photos are worth capturing on their own.
      payload["largerThanStreamCeiling"] = (w * h) > (720.0 * 1280.0 * 1.5)
    }
    // Written to disk so it can be pulled off the phone and inspected at full size.
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("wearables-photo-\(Int(Date().timeIntervalSince1970)).jpg")
    try? photo.data.write(to: url)
    payload["fileUri"] = url.absoluteString

    if hasListeners { sendEvent(withName: "wearables:photo", body: payload) }
  }

  // MARK: - 8. THE audio question

  /// Record through the glasses' microphones over Bluetooth HFP and report what the route
  /// actually negotiated. Wideband (16 kHz) is exactly what the ASR stage consumes after
  /// downsampling, so it costs nothing; narrowband (8 kHz) would measurably hurt.
  ///
  /// Meta documents an ordering constraint: HFP must be configured and settled BEFORE a DAT
  /// camera stream starts, or the audio route fails silently. This method therefore reports
  /// whether a stream was already running when it was called.
  @objc(recordGlassesAudio:resolver:rejecter:)
  func recordGlassesAudio(_ seconds: NSNumber,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    let streamWasRunning = (stream != nil)

    let proceed: (Bool) -> Void = { granted in
      guard granted else {
        reject("wearables_mic_denied", "Microphone permission denied", nil)
        return
      }
      // Declared outside the `do` so the `catch` below can deactivate it too — anything thrown
      // after `setActive(true)` (constructing AVAudioRecorder, most plausibly) must not leave
      // the glasses pinned in HFP just because the failure path never reaches the deactivate
      // call the success path has.
      let audioSession = AVAudioSession.sharedInstance()
      do {
        // HFP is the correct profile: Meta's guidance is "use HFP when you need microphone
        // input from the wearer", and A2DP is output-only. The two are mutually exclusive —
        // activating HFP drops glasses OUTPUT to 8 kHz mono — which is why the session is
        // deactivated again below rather than left holding the glasses in HFP.
        // `.allowBluetoothHFP` is a rename of `.allowBluetooth`, not a new API, so no
        // availability guard is needed.
        try audioSession.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP])
        try audioSession.setActive(true)

        // "The Bluetooth HFP route needs time to stabilize." Reading currentRoute straight
        // after setActive races the switch: the built-in mic is still the input for a beat,
        // so both the port type AND the negotiated sample rate would describe the phone
        // rather than the glasses. Same "asked too early" class as the startStream races.
        let routeDeadline = Date().addingTimeInterval(3)
        while !audioSession.currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }),
              Date() < routeDeadline {
          Thread.sleep(forTimeInterval: 0.1)
        }

        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent("wearables-audio-\(Int(Date().timeIntervalSince1970)).m4a")
        let recorder = try AVAudioRecorder(url: url, settings: [
          AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
          // Ask for 48k; the hardware reports back what it actually negotiated, which is the
          // number this whole method exists to produce.
          AVSampleRateKey: 48_000.0,
          AVNumberOfChannelsKey: 1,
        ])
        // record() reports startup failure by returning false rather than throwing, so a
        // plain call here is silently ignorable — and was ignored: the delayed callback below
        // would still resolve a nominally-wideband result over a zero-byte file, reporting a
        // capture that never happened as a pass.
        guard recorder.record() else {
          try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
          reject("wearables_audio_record_failed",
                 "AVAudioRecorder.record() returned false — recording did not start", nil)
          return
        }

        let route = audioSession.currentRoute
        let input = route.inputs.first
        let negotiated = audioSession.sampleRate

        DispatchQueue.main.asyncAfter(deadline: .now() + seconds.doubleValue) {
          recorder.stop()
          // Hand the glasses back. HFP and A2DP are mutually exclusive, so an audio session
          // left active after a 10-second recording keeps the glasses in HFP indefinitely and
          // every other app's playback through them stays 8 kHz mono. Deactivating is the
          // other half of choosing HFP deliberately.
          try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
          let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
          let isBluetooth = input?.portType == .bluetoothHFP
          let payload: [String: Any] = [
            "fileUri": url.absoluteString,
            "bytes": (attrs?[.size] as? Int) ?? 0,
            "negotiatedSampleRate": negotiated,
            "wideband": negotiated >= 16_000,
            "inputPortName": input?.portName ?? "none",
            "inputPortType": input?.portType.rawValue ?? "none",
            "isBluetoothInput": isBluetooth,
            "streamWasRunningFirst": streamWasRunning,
          ]
          guard isBluetooth else {
            // The measurement this rung exists to produce is the rate the GLASSES negotiate.
            // A successful recording from the phone or Mac microphone is not a weaker version
            // of that answer, it is a different one, and reporting it green would be a lie.
            reject(
              "wearables_audio_not_glasses",
              "Recorded from \(input?.portName ?? "an unknown input"), not the glasses over "
                + "Bluetooth HFP. \(negotiated) Hz is this device's microphone and says nothing "
                + "about the glasses. Connect them and retry.",
              nil
            )
            return
          }
          resolve(payload)
        }
      } catch {
        // Without this, anything thrown after setActive(true) above — most plausibly
        // AVAudioRecorder's initializer — leaves the glasses pinned in HFP. HFP and A2DP are
        // mutually exclusive, so every other app's playback through them stays 8 kHz mono until
        // something else happens to reset the session.
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        reject("wearables_audio_failed", "HFP capture failed: \(Self.describe(error))", error)
      }
    }

    // AVAudioApplication landed in iOS 17; this app deploys to 15.2, so the older
    // AVAudioSession entry point is still required.
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: proceed)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(proceed)
    }
  }

  // MARK: - 9. Step 0 check: does HFP survive a DAT stream?

  /// A local, disposable frame counter for rung 9 — deliberately NOT the class-level
  /// `frameToken`/`firstFrameSize` pair above, which belongs to `startStream` (rung 6) and must
  /// not be disturbed by a diagnostic rung that can run independently of it.
  ///
  /// `record()` runs on the SDK's frame-delivery thread; `snapshot()` runs on rung 9's Task while
  /// it polls. Both are fully synchronous — lock, touch state, unlock, no `await` in between —
  /// so nothing ever suspends while holding `lock`. That is what makes NSLock usable here at all;
  /// locking around an `await` is the hazard `stateLock`'s own comment already documents.
  private final class FrameObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var frameCount = 0
    private var firstFrameAt: Date?

    func record() {
      lock.lock()
      frameCount += 1
      if firstFrameAt == nil { firstFrameAt = Date() }
      lock.unlock()
    }

    func snapshot() -> (count: Int, firstFrameAt: Date?) {
      lock.lock()
      defer { lock.unlock() }
      return (frameCount, firstFrameAt)
    }
  }

  /// Runs Meta's documented sequence exactly — addStream(), THEN configure HFP and let the route
  /// settle, THEN stream.start() — and reports the route either side of the start. The old code
  /// called addStream() and stream.start() back to back, which leaves no window for HFP at all.
  @objc(checkHfpWithStream:rejecter:)
  func checkHfpWithStream(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard Self.configured else {
      reject("wearables_not_configured", "Call configure() first", nil)
      return
    }
    teardown()
    // This rung's Task owns `session`/`stream` for 12s or more. Without a generation, every
    // `teardown()` below fires unconditionally on the way out — including the one on the SUCCESS
    // path — so a rung the user has already moved on from stops whatever is running now. Captured
    // after the teardown above so it names this run's own starting point.
    let myGeneration = currentTeardownGeneration()

    Task {
      let audio = AVAudioSession.sharedInstance()
      // Declared out here so the `catch` can reach them; the `let`s inside the `do` cannot
      // be seen from it, so without these a superseded run's catch path can stop nothing.
      var createdRef: DeviceSession?
      var streamRef: MWDATCamera.Stream?
      // The publication this run currently owns, 0 until it publishes. Hoisted for the same reason
      // the refs are: the `catch` cannot see anything declared inside the `do`.
      var publicationTicket = 0
      do {
        let sdk = Wearables.shared
        let selector = AutoDeviceSelector(wearables: sdk)
        var deadline = Date().addingTimeInterval(8)
        while selector.activeDevice == nil, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard selector.activeDevice != nil else {
          reject("wearables_no_active_device", "No active device after 8s. Run rung 4b.", nil)
          return
        }
        // Claim, create and publish as ONE step — see `createAndPublishSession`. The device wait
        // above can run for 8s, and a separate checkpoint before a separate `createSession()` still
        // leaves a gap in which a superseded task takes the only permitted device session.
        //
        // `createdRef` is held outside the `do` so the `catch` can still reach it: publication is not
        // free of races even here, and an un-stopped DeviceSession is not a quiet leak — it blocks
        // every later createSession with the `sessionAlreadyExists` failure this file already calls
        // "our own litter".
        guard let opened = try createAndPublishSession(ifGeneration: myGeneration, {
          try sdk.createSession(deviceSelector: selector)
        }) else {
          reject("wearables_rung_superseded",
                 "This check was superseded by another rung while waiting for a device", nil)
          return
        }
        let created = opened.session
        createdRef = created
        publicationTicket = opened.ticket
        try created.start()
        deadline = Date().addingTimeInterval(10)
        while created.state != .started, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard created.state == .started else {
          let stalled = created.state.description
          // Up to 10s after this run began, so only tear down shared state if it is still ours;
          // otherwise `created` is an orphan only this path holds a reference to.
          if !teardownIfCurrent(myGeneration) {
            retract(publicationTicket)
            stopOrphans(stream: nil, session: created)
          }
          reject("wearables_session_not_started", "Stalled in \(stalled) after 10s", nil)
          return
        }

        // Meta step 1: the stream exists but is NOT started.
        guard let newStream = try created.addStream() else {
          if !teardownIfCurrent(myGeneration) {
            retract(publicationTicket)
            stopOrphans(stream: nil, session: created)
          }
          reject("wearables_stream_nil", "addStream() returned nil", nil)
          return
        }
        streamRef = newStream
        publicationTicket = publish(stream: newStream, session: nil)

        // Meta step 2: HFP comes up while the stream is still stopped.
        let activated = try await activateHfpAndSettle()
        defer { releaseAudioSession(epoch: activated.audioEpoch) }
        let before = Self.routeSnapshot(audio)

        // Subscribe BEFORE start(). Reading the route undisturbed proves nothing on its own — a
        // stream that stalls and delivers nothing produces exactly the same undisturbed route as
        // a stream that ran cleanly, and that is the conclusion this rung exists to rule out.
        let observation = FrameObservation()
        let frameListenerToken = newStream.videoFramePublisher.listen { (_: VideoFrame) in
          observation.record()
        }

        // Meta step 3: only now.
        newStream.start()
        let streamStartedAt = Date()

        // First-frame latency measured 2.2-2.5s on this hardware; 8s is a generous deadline
        // against that. Waiting for an actual frame — instead of a flat sleep — is the fix
        // itself: a flat sleep cannot tell "no frame ever arrived" apart from "a frame arrived
        // instantly," which is exactly the blind spot that let this rung PASS for a dead stream.
        let frameDeadline = streamStartedAt.addingTimeInterval(8)
        while observation.snapshot().firstFrameAt == nil, Date() < frameDeadline {
          try? await Task.sleep(nanoseconds: 100_000_000)
        }
        // Keep observing until at least 4s have elapsed since start(), so the route reading
        // still happens well after frames are flowing — the same margin the old fixed sleep
        // gave, just no longer blind to whether anything was ever delivered.
        let routeDeadline = streamStartedAt.addingTimeInterval(4)
        while Date() < routeDeadline {
          try? await Task.sleep(nanoseconds: 100_000_000)
        }
        let after = Self.routeSnapshot(audio)
        let finalObservation = observation.snapshot()
        // Release the subscription before the observation window's data leaves this scope —
        // `teardown()` below stops the whole stream anyway, but cancelling explicitly rather
        // than just dropping the reference is the deterministic version of "release it after."
        await frameListenerToken.cancel()

        // The SUCCESS path needs the claim just as much as the failure paths: arriving here is
        // ~12s after the rung began, and tearing down unconditionally is how a completed rung
        // used to stop a newer run's session. Deactivating the audio session is part of the same
        // claim — if this run no longer owns the world, the HFP session it would deactivate is
        // one the CURRENT run activated for itself.
        if !teardownIfCurrent(myGeneration) {
          // Superseded. `created`/`newStream` may have been published after the superseding
          // teardown already swept, in which case nothing else will ever stop them — and the shared
          // fields would still be pointing at them, so `capturePhoto()` and `recordGlassesAudio()`
          // would go on reporting a stream that is dead. The endurance rungs already retracted here;
          // this one did not, which is the only reason it needed saying twice.
          retract(publicationTicket)
          stopOrphans(stream: newStream, session: created)
        }

        // No frame ever arriving is itself a fact worth reporting, not a rejection: a rejection
        // would throw away the two route snapshots along with it, and the numbers here are worth
        // more than an error. TypeScript decides whether framesDelivered: 0 means "inconclusive."
        let firstFrameSecondsValue: Any
        if let firstFrameAt = finalObservation.firstFrameAt {
          firstFrameSecondsValue = firstFrameAt.timeIntervalSince(streamStartedAt)
        } else {
          firstFrameSecondsValue = NSNull()
        }
        resolve([
          "beforeStreamStart": before,
          "afterStreamStart": after,
          "framesDelivered": finalObservation.count,
          "firstFrameSeconds": firstFrameSecondsValue,
        ])
      } catch {
        // A superseded run cannot assume the sweeper saw its objects: the publish above is not
        // generation-checked, so it can land after the sweep. `createdRef`/`streamRef` exist for
        // exactly this path.
        if !teardownIfCurrent(myGeneration) {
          retract(publicationTicket)
          stopOrphans(stream: streamRef, session: createdRef)
        }
        reject("wearables_hfp_stream_check_failed",
               "checkHfpWithStream failed: \(Self.describe(error))", error)
      }
    }
  }

  // MARK: - 10. Step 0 check: does the phone camera disturb the HFP route?

  /// Bridges `AVCapturePhotoCaptureDelegate`'s completion-handler style into `async`.
  /// `capturePhoto(with:delegate:)` does NOT retain its delegate, so whoever calls `capture()`
  /// below is responsible for keeping this instance alive until it fires — a deallocated
  /// delegate means `photoOutput(_:didFinishProcessingPhoto:error:)` can never run and the
  /// continuation never resumes, hanging the rung forever.
  ///
  /// The delegate callback and a timeout can both fire — a lost callback must not hang the Task,
  /// but a late callback arriving after the timeout already resumed must not resume the
  /// continuation a second time, which crashes at runtime. `lock` picks a single winner. Every
  /// method here is fully synchronous (lock, touch state, unlock, no `await` in between), the
  /// same no-suspension-under-lock discipline as `stateLock`/`FrameObservation` elsewhere in
  /// this file.
  private final class StillCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: (() -> Void)?
    private var timedOut = false
    private var captureError: Error?

    /// Runs the real capture and awaits its outcome, guarded by a timeout so a lost delegate
    /// callback cannot hang the rung. `self` is held by this function's own local `let`, not by
    /// AVFoundation, for the delegate's entire lifetime.
    static func capture(on output: AVCapturePhotoOutput,
                        timeoutSeconds: UInt64 = 5) async -> (timedOut: Bool, error: Error?) {
      let delegate = StillCaptureDelegate()
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        delegate.lock.lock()
        delegate.pending = { continuation.resume() }
        delegate.lock.unlock()

        output.capturePhoto(with: AVCapturePhotoSettings(), delegate: delegate)

        Task {
          try? await Task.sleep(nanoseconds: timeoutSeconds * 1_000_000_000)
          delegate.finish(error: nil, timedOut: true)
        }
      }
      return delegate.result
    }

    /// Synchronous read under `lock` — deployment target is iOS 15.2, so this spells out
    /// lock/unlock rather than reaching for `NSLocking.withLock`, which needs iOS 16.
    private var result: (timedOut: Bool, error: Error?) {
      lock.lock()
      defer { lock.unlock() }
      return (timedOut, captureError)
    }

    private func finish(error: Error?, timedOut: Bool) {
      lock.lock()
      let callback = pending
      pending = nil
      if callback != nil {
        self.captureError = error
        self.timedOut = timedOut
      }
      lock.unlock()
      callback?()
    }

    func photoOutput(_ output: AVCapturePhotoOutput,
                     didFinishProcessingPhoto photo: AVCapturePhoto,
                     error: Error?) {
      finish(error: error, timedOut: false)
    }
  }

  /// The design needs phone stills DURING a glasses walk, and both share one AVAudioSession.
  /// The capture session here is deliberately photo-output only with NO audio input — that is
  /// the configuration the real feature must use, so this tests the actual proposed code path
  /// rather than a worst case nobody would ship.
  @objc(checkPhoneCameraDuringHfp:rejecter:)
  func checkPhoneCameraDuringHfp(_ resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      let audio = AVAudioSession.sharedInstance()
      do {
        // THE PHONE's camera, and nothing to do with the SDK's glasses-camera permission that
        // rung 5 requests — different subsystem, different Info.plist key, different Settings
        // toggle. Checked here, BEFORE HFP is activated, for two reasons: an unauthorized session
        // does not fail, it runs with no input, so the rung would sit through the 5-second shutter
        // timeout and report "capture timed out" for what is actually a permission problem; and
        // failing before `activateHfpAndSettle()` means nothing has put the glasses into
        // hands-free mode that would then need handing back.
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
          break
        case .notDetermined:
          // Asking is the whole answer on a fresh install, and this rung cannot be run any other
          // way. Waiting for the user is fine: nothing has been opened yet.
          guard await AVCaptureDevice.requestAccess(for: .video) else {
            reject("wearables_no_camera",
                   "Camera access was declined, so the phone camera cannot be opened. Tap the rung "
                     + "again and choose OK.", nil)
            return
          }
        default:
          reject("wearables_no_camera",
                 "Camera access for T-Rock Cam is off, so the phone camera cannot be opened — this "
                   + "is the PHONE's camera permission, not the glasses'. Turn it on in Settings > "
                   + "T-Rock Cam > Camera and run this rung again.", nil)
          return
        }

        let activated = try await activateHfpAndSettle()
        defer { releaseAudioSession(epoch: activated.audioEpoch) }
        let before = Self.routeSnapshot(audio)

        let capture = AVCaptureSession()
        // Defaults to YES, which hands AVFoundation permission to reconfigure the app's shared
        // AVAudioSession on its own — category, mode, and route — around startRunning() and the
        // shutter. `activateHfpAndSettle()` just put that session on Bluetooth HFP deliberately,
        // and this rung's entire question is whether opening the phone camera disturbs it.
        //
        // Leaving it YES does not just risk a disturbance; it makes the measurement unable to
        // answer its own question. A route change would be this flag reconfiguring the session
        // rather than the camera hardware contending for the microphone, and the verdict — which
        // decides whether the capture feature gets built on this path at all — cannot tell those
        // apart. Turning it off is what makes a disturbance, if one shows up, attributable.
        capture.automaticallyConfiguresApplicationAudioSession = false
        capture.sessionPreset = .photo
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
          reject("wearables_no_camera", "No video capture device available", nil)
          return
        }
        // Photo output only, no audio input — that is the configuration the real feature will
        // use, and the whole point of this rung is to test that actual path.
        let photo = AVCapturePhotoOutput()
        capture.beginConfiguration()
        guard capture.canAddInput(input) else {
          capture.commitConfiguration()
          reject("wearables_no_camera", "Capture session refused the video input", nil)
          return
        }
        capture.addInput(input)
        guard capture.canAddOutput(photo) else {
          capture.commitConfiguration()
          reject("wearables_no_camera", "Capture session refused the photo output", nil)
          return
        }
        capture.addOutput(photo)
        capture.commitConfiguration()

        capture.startRunning()
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        let during = Self.routeSnapshot(audio)

        // THE fix: actually fire the shutter. The shutter is where a route disturbance would
        // most plausibly happen, and taking a still is what the real feature does — opening the
        // camera without ever capturing only tests "the preview is safe," which is a different
        // and much weaker claim than the one the design spec was written on.
        let captureOutcome = await StillCaptureDelegate.capture(on: photo)
        let duringCapture = Self.routeSnapshot(audio)

        capture.stopRunning()
        // A route lost on teardown can take a moment to renegotiate, and this file already
        // budgets 3s for exactly that in activateHfpAndSettle. Reading after a fixed 1s could
        // catch the route mid-transition and report a recovery failure that never happened.
        // Polling does not mask a genuine loss: if HFP never comes back, the deadline expires
        // and whatever the route actually is gets reported.
        let recoveryDeadline = Date().addingTimeInterval(3)
        while !audio.currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }),
              Date() < recoveryDeadline {
          try? await Task.sleep(nanoseconds: 100_000_000)
        }
        let after = Self.routeSnapshot(audio)


        // Whether the shutter itself succeeded is a raw fact, not a verdict: a route reading
        // taken around a capture that silently failed would repeat exactly the mistake this fix
        // exists to correct, just one layer further in.
        let capturePhotoErrorValue: Any
        if let error = captureOutcome.error {
          capturePhotoErrorValue = Self.describe(error)
        } else {
          capturePhotoErrorValue = NSNull()
        }
        resolve([
          "before": before,
          "during": during,
          "duringCapture": duringCapture,
          "after": after,
          "capturePhotoSucceeded": !captureOutcome.timedOut && captureOutcome.error == nil,
          "capturePhotoTimedOut": captureOutcome.timedOut,
          "capturePhotoError": capturePhotoErrorValue,
          // Reported, not assumed. This rung's answer is only transferable to a shipped feature
          // that configures its capture session the same way; a PASS read without this field
          // says "phone stills are safe" when what was measured is "phone stills are safe WITH
          // automaticallyConfiguresApplicationAudioSession off". Hard-coded rather than read
          // back off `capture`, because the reading that matters is the one in force during the
          // measurement above, and the session is torn down by now.
          "capturePreventedAudioSessionReconfiguration": true,
        ])
      } catch {
        reject("wearables_phone_camera_check_failed",
               "checkPhoneCameraDuringHfp failed: \(Self.describe(error))", error)
      }
    }
  }

  // MARK: - 11. Does the video stream sustain WITHOUT HFP audio?

  /// The question four real walks raised and none could answer.
  ///
  /// Every walk produced 3-8 seconds of video against 23-47 seconds of audio. Instrumentation
  /// established the writer was innocent — 239 frames received, 239 appended, none dropped — so
  /// the glasses stopped sending. Meta documents that HFP and DAT streaming interact, and rung 9
  /// concluded "HFP survives a DAT stream" while observing for only four seconds, which is inside
  /// the window where it still works.
  ///
  /// This runs a stream with NO audio session at all. That absence is the whole experiment.
  /// Frames are reported bucketed per second, so "sustains for a minute" and "dies at eight
  /// seconds" are distinguishable rather than both collapsing into a total.
  @objc(measureStreamWithoutAudio:resolver:rejecter:)
  func measureStreamWithoutAudio(_ seconds: NSNumber,
                                 resolver resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard Self.configured else {
      reject("wearables_not_configured", "Call configure() first", nil)
      return
    }
    teardown()
    // `seconds` is clamped to 180 below, so this Task can own `session`/`stream` for three
    // minutes. It is the longest-lived run in the file and therefore the most likely to outlive
    // the screen that started it; its teardowns must not reach past their own run.
    let myGeneration = currentTeardownGeneration()

    Task {
      // Declared out here so the `catch` can reach them; the `let`s inside the `do` cannot
      // be seen from it, so without these a superseded run's catch path can stop nothing.
      var createdRef: DeviceSession?
      var streamRef: MWDATCamera.Stream?
      // The publication this run currently owns, 0 until it publishes. Hoisted for the same reason
      // the refs are: the `catch` cannot see anything declared inside the `do`.
      var publicationTicket = 0
      do {
        let sdk = Wearables.shared
        let selector = AutoDeviceSelector(wearables: sdk)
        var deadline = Date().addingTimeInterval(8)
        while selector.activeDevice == nil, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard selector.activeDevice != nil else {
          reject("wearables_no_active_device", "No active device after 8s. Run rung 4b.", nil)
          return
        }
        // Claim, create and publish as ONE step — see `createAndPublishSession`. The device wait
        // above can run for 8s, and a separate checkpoint before a separate `createSession()` still
        // leaves a gap in which a superseded task takes the only permitted device session.
        //
        // `createdRef` is held outside the `do` so the `catch` can still reach it: publication is not
        // free of races even here, and an un-stopped DeviceSession is not a quiet leak — it blocks
        // every later createSession with the `sessionAlreadyExists` failure this file already calls
        // "our own litter".
        guard let opened = try createAndPublishSession(ifGeneration: myGeneration, {
          try sdk.createSession(deviceSelector: selector)
        }) else {
          reject("wearables_rung_superseded",
                 "This check was superseded by another rung while waiting for a device", nil)
          return
        }
        let created = opened.session
        createdRef = created
        publicationTicket = opened.ticket
        try created.start()
        deadline = Date().addingTimeInterval(10)
        while created.state != .started, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard created.state == .started else {
          let stalled = created.state.description
          // Up to 10s after this run began, so only tear down shared state if it is still ours;
          // otherwise `created` is an orphan only this path holds a reference to.
          if !teardownIfCurrent(myGeneration) {
            retract(publicationTicket)
            stopOrphans(stream: nil, session: created)
          }
          reject("wearables_session_not_started", "Stalled in \(stalled) after 10s", nil)
          return
        }

        // Same configuration the recorder uses, so this measures the real path rather than a
        // gentler one that might sustain where the real one does not.
        guard let newStream = try created.addStream(
          config: StreamConfiguration(videoCodec: .raw, resolution: .high, frameRate: 30)
        ) else {
          if !teardownIfCurrent(myGeneration) {
            retract(publicationTicket)
            stopOrphans(stream: nil, session: created)
          }
          reject("wearables_stream_nil", "addStream() returned nil", nil)
          return
        }
        streamRef = newStream
        publicationTicket = publish(stream: newStream, session: nil)

        let counter = FrameArrivalCounter()
        frameToken = newStream.videoFramePublisher.listen { _ in counter.tick() }

        // NO AVAudioSession is configured or activated anywhere in this method. That is the
        // experiment: if frames sustain here and die during a walk, HFP is the difference.
        newStream.start()
        let startedAt = Date()

        var perSecond: [Int] = []
        let total = max(1, min(seconds.intValue, 180))
        for _ in 0..<total {
          try? await Task.sleep(nanoseconds: 1_000_000_000)
          perSecond.append(counter.drainCount())
        }
        let lastArrival = counter.lastTick()

        // Up to three minutes after this rung began — the longest window in the file for the
        // screen to have moved on to something else.
        if !teardownIfCurrent(myGeneration) {
          retract(publicationTicket)
          stopOrphans(stream: newStream, session: created)
        }

        resolve([
          "secondsObserved": total,
          "framesPerSecond": perSecond,
          "totalFrames": perSecond.reduce(0, +),
          // -1 when no frame ever arrived. Otherwise: how far into the run the LAST frame landed,
          // which is the number that says whether delivery sustained or stopped.
          "secondsToLastFrame": lastArrival.map { $0.timeIntervalSince(startedAt) } ?? -1,
          "audioSessionUsed": false,
        ])
      } catch {
        if !teardownIfCurrent(myGeneration) {
          retract(publicationTicket)
          stopOrphans(stream: streamRef, session: createdRef)
        }
        reject("wearables_stream_measure_failed",
               "measureStreamWithoutAudio failed: \(Self.describe(error))", error)
      }
    }
  }
}

extension WearablesBridge {
  // MARK: - 12. Glasses video + PHONE microphone

  /// The question rung 11's answer raises.
  ///
  /// Rung 11 established that video sustains a full minute alone and dies at 3-8 seconds once HFP
  /// is active — so the conflict is the Bluetooth PROFILE SWITCH, not audio recording as such.
  /// HFP forces the glasses' radio into hands-free mode, and that is what starves the video
  /// transport.
  ///
  /// Recording from the PHONE's microphone never touches the glasses' radio: no
  /// `.allowBluetoothHFP`, no profile switch, the glasses doing nothing but video. If frames
  /// still sustain here, a walkthrough can have both — and at BETTER audio than HFP, since the
  /// phone's microphone runs at 48 kHz against HFP's 16 kHz ceiling, provided the phone is in
  /// hand rather than a pocket.
  ///
  /// Reports the input actually used, because the whole result is void if the route silently
  /// picked the glasses anyway.
  @objc(measureStreamWithPhoneAudio:resolver:rejecter:)
  func measureStreamWithPhoneAudio(_ seconds: NSNumber,
                                   resolver resolve: @escaping RCTPromiseResolveBlock,
                                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard Self.configured else {
      reject("wearables_not_configured", "Call configure() first", nil)
      return
    }
    teardown()
    // Same clamp and the same three-minute ceiling as the no-audio rung, plus an activated
    // AVAudioSession this run is responsible for deactivating.
    let myGeneration = currentTeardownGeneration()

    Task {
      let audio = AVAudioSession.sharedInstance()
      // Declared out here so the `catch` can reach them; the `let`s inside the `do` cannot
      // be seen from it, so without these a superseded run's catch path can stop nothing.
      var createdRef: DeviceSession?
      var streamRef: MWDATCamera.Stream?
      // The publication this run currently owns, 0 until it publishes. Hoisted for the same reason
      // the refs are: the `catch` cannot see anything declared inside the `do`.
      var publicationTicket = 0
      do {
        let sdk = Wearables.shared
        let selector = AutoDeviceSelector(wearables: sdk)
        var deadline = Date().addingTimeInterval(8)
        while selector.activeDevice == nil, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard selector.activeDevice != nil else {
          reject("wearables_no_active_device", "No active device after 8s. Run rung 4b.", nil)
          return
        }
        // Claim, create and publish as ONE step — see `createAndPublishSession`. The device wait
        // above can run for 8s, and a separate checkpoint before a separate `createSession()` still
        // leaves a gap in which a superseded task takes the only permitted device session.
        //
        // `createdRef` is held outside the `do` so the `catch` can still reach it: publication is not
        // free of races even here, and an un-stopped DeviceSession is not a quiet leak — it blocks
        // every later createSession with the `sessionAlreadyExists` failure this file already calls
        // "our own litter".
        guard let opened = try createAndPublishSession(ifGeneration: myGeneration, {
          try sdk.createSession(deviceSelector: selector)
        }) else {
          reject("wearables_rung_superseded",
                 "This check was superseded by another rung while waiting for a device", nil)
          return
        }
        let created = opened.session
        createdRef = created
        publicationTicket = opened.ticket
        try created.start()
        deadline = Date().addingTimeInterval(10)
        while created.state != .started, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard created.state == .started else {
          let stalled = created.state.description
          // Up to 10s after this run began, so only tear down shared state if it is still ours;
          // otherwise `created` is an orphan only this path holds a reference to.
          if !teardownIfCurrent(myGeneration) {
            retract(publicationTicket)
            stopOrphans(stream: nil, session: created)
          }
          reject("wearables_session_not_started", "Stalled in \(stalled) after 10s", nil)
          return
        }

        guard let newStream = try created.addStream(
          config: StreamConfiguration(videoCodec: .raw, resolution: .high, frameRate: 30)
        ) else {
          if !teardownIfCurrent(myGeneration) {
            retract(publicationTicket)
            stopOrphans(stream: nil, session: created)
          }
          reject("wearables_stream_nil", "addStream() returned nil", nil)
          return
        }
        streamRef = newStream
        publicationTicket = publish(stream: newStream, session: nil)

        // NOTE the absent option: `.playAndRecord` WITHOUT `.allowBluetoothHFP`. That single
        // omission is the experiment — it is what keeps the glasses out of hands-free mode.
        let audioEpochHeld = try withAudioSessionActivation {
          try audio.setCategory(.playAndRecord, mode: .default, options: [])
          try audio.setActive(true)
        }
        defer { releaseAudioSession(epoch: audioEpochHeld) }
        try? await Task.sleep(nanoseconds: 500_000_000)

        let input = audio.currentRoute.inputs.first
        // If the route picked the glasses anyway, this measures HFP again and the answer is void.
        guard input?.portType != .bluetoothHFP else {
          if !teardownIfCurrent(myGeneration) {
            retract(publicationTicket)
            stopOrphans(stream: newStream, session: created)
          }
          reject("wearables_route_is_glasses",
                 "The audio route selected the glasses (\(input?.portName ?? "unknown")) despite "
                   + "not requesting HFP, so this would re-measure HFP rather than the phone mic.",
                 nil)
          return
        }

        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent("phone-audio-\(Int(Date().timeIntervalSince1970)).m4a")
        let recorder = try AVAudioRecorder(url: url, settings: [
          AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
          AVSampleRateKey: 48_000.0,
          AVNumberOfChannelsKey: 1,
        ])
        guard recorder.record() else {
          if !teardownIfCurrent(myGeneration) {
            retract(publicationTicket)
            stopOrphans(stream: newStream, session: created)
          }
          reject("wearables_recorder_not_started", "AVAudioRecorder.record() returned false", nil)
          return
        }

        let counter = FrameArrivalCounter()
        frameToken = newStream.videoFramePublisher.listen { _ in counter.tick() }

        newStream.start()
        let startedAt = Date()

        var perSecond: [Int] = []
        let total = max(1, min(seconds.intValue, 180))
        for _ in 0..<total {
          try? await Task.sleep(nanoseconds: 1_000_000_000)
          perSecond.append(counter.drainCount())
        }
        let lastArrival = counter.lastTick()

        recorder.stop()
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int

        // Read the route AGAIN, after the run and before teardown deactivates the session.
        //
        // `input` above is the route as it stood BEFORE a minute of recording. iOS reroutes audio
        // on its own — the glasses reconnecting, a headset being plugged in, a call ending — so
        // reporting that first reading as "the input this measurement used" can describe a port
        // that stopped being the source seconds into the run. That is not a cosmetic slip here:
        // the whole result is void if the route ended up on the glasses, and the up-front guard
        // cannot see a switch that happens after it. `audio.sampleRate` is read in the same breath
        // for the same reason — a rate quoted against a different port than the one named beside it
        // is worse than no rate at all.
        let finalInput = audio.currentRoute.inputs.first
        let finalSampleRate = audio.sampleRate

        // Same claim as every other exit from this rung, success included — see the no-audio
        // rung and checkHfpWithStream for why the audio deactivation rides on it.
        if !teardownIfCurrent(myGeneration) {
          retract(publicationTicket)
          stopOrphans(stream: newStream, session: created)
        }

        resolve([
          "secondsObserved": total,
          "framesPerSecond": perSecond,
          "totalFrames": perSecond.reduce(0, +),
          "secondsToLastFrame": lastArrival.map { $0.timeIntervalSince(startedAt) } ?? -1,
          "inputPortName": finalInput?.portName ?? "none",
          "inputPortType": finalInput?.portType.rawValue ?? "none",
          "negotiatedSampleRate": finalSampleRate,
          // Carried alongside rather than dropped: the guard above only proves the route was not
          // the glasses at the START, so this is what makes a mid-run switch visible instead of
          // silently corrected away by the re-read.
          "initialInputPortType": input?.portType.rawValue ?? "none",
          "audioBytes": bytes ?? 0,
          "audioFileUri": url.absoluteString,
        ])
      } catch {
        if !teardownIfCurrent(myGeneration) {
          retract(publicationTicket)
          stopOrphans(stream: streamRef, session: createdRef)
        }
        reject("wearables_phone_audio_measure_failed",
               "measureStreamWithPhoneAudio failed: \(Self.describe(error))", error)
      }
    }
  }
}

/// Counts frame arrivals off the SDK's delivery thread.
///
/// Locking happens only inside these synchronous methods — never in an `async` body, where
/// `NSLock.lock()` is unavailable and is a hard error under Swift 6. Callers in a `Task` go
/// through `drainCount()` / `lastTick()` rather than touching the state directly.
private final class FrameArrivalCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  private var lastTickAt: Date?

  func tick() {
    lock.lock()
    count += 1
    lastTickAt = Date()
    lock.unlock()
  }

  /// Reads and resets, so each call returns arrivals since the previous one.
  func drainCount() -> Int {
    lock.lock()
    defer { lock.unlock() }
    let value = count
    count = 0
    return value
  }

  func lastTick() -> Date? {
    lock.lock()
    defer { lock.unlock() }
    return lastTickAt
  }
}

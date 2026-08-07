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
  private let stateLock = NSLock()

  /// Which start attempt is CURRENT. `startStream` spends seconds awaiting a device selector before
  /// it ever assigns `session`, and Stop stays enabled throughout — so a Stop pressed inside that
  /// window called `teardown()` on nothing, and the pending Task then went on to create and start a
  /// stream AFTER the UI had reported it stopped. Nothing owned that Task, so there was nothing to
  /// cancel; a monotonic token gives the awaiting Task a way to ask "am I still the one?" at each
  /// point where it is about to commit state. `teardown()` bumps it, which is what makes Stop
  /// authoritative even when there is nothing yet to tear down.
  ///
  /// Read and written under `stateLock` for the same reason everything else here is: the Task and the
  /// bridge queue are different threads.
  private var streamStartGeneration = 0

  /// `Wearables.configure()` is not idempotent in 0.8.0, so the guard lives here rather
  /// than trusting every JS caller to remember.
  private static var configured = false

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
  private static func activateHfpAndSettle() async throws -> AVAudioSession {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP])
    try session.setActive(true)
    let deadline = Date().addingTimeInterval(3)
    while !session.currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }),
          Date() < deadline {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return session
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

    // Reset the frame measurement synchronously, BEFORE the Task. NSLock's lock()/unlock() are
    // unavailable from async contexts — a task can suspend while holding the lock — and that is
    // a hard error under Swift 6. Nothing here needs to be async, so it simply moves out.
    // `teardown()` above already bumped the generation; this attempt claims the value it left. Read
    // under the same lock as the reset so the claim and the reset are one critical section.
    stateLock.lock()
    firstFrameSize = nil
    firstFrameAt = nil
    streamStartedAt = Date()
    let generation = streamStartGeneration
    stateLock.unlock()

    // Whether this attempt is still the current one — false as soon as Stop (or another start) has
    // run `teardown()`. A closure with an explicit capture rather than a nested func, because a local
    // function that captures `self` is called from inside the escaping Task below.
    let isCurrent: () -> Bool = { [weak self] in
      guard let self else { return false }
      self.stateLock.lock()
      defer { self.stateLock.unlock() }
      return self.streamStartGeneration == generation
    }

    Task {
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

        // THE FIRST COMMIT POINT. Everything above only waited; from here the SDK holds real state,
        // so a Stop pressed during that wait has to stop the attempt HERE — otherwise it creates a
        // session the UI has already reported as stopped, and the next start then fails with
        // `sessionAlreadyExists`, an error about our own litter.
        guard isCurrent() else {
          reject("wearables_stream_cancelled", "Stopped before the stream started", nil)
          return
        }

        let created = try sdk.createSession(deviceSelector: selector)
        session = created
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
          teardown()
          reject(
            "wearables_session_not_started",
            "Session never reached .started — stalled in \(stalled) after 10s",
            nil
          )
          return
        }

        guard let newStream = try created.addStream() else {
          let state = created.state.description
          teardown()
          reject("wearables_stream_nil", "addStream() returned nil (session state: \(state))", nil)
          return
        }
        // THE SECOND COMMIT POINT — and the check and the PUBLISH happen under ONE lock hold.
        //
        // Checking and then assigning as two steps left the race intact: Stop could run `teardown()`
        // in the gap, bumping the generation and stopping a `stream` that was still nil, after which
        // this task published `newStream` anyway. Teardown had nothing to find, so the stream survived
        // a Stop that had already resolved. Doing both inside the same critical section makes that
        // interleaving unrepresentable — teardown takes the same lock to bump, so it either runs
        // entirely before this (and `stillCurrent` is false) or entirely after (and it sees the stream
        // it needs to stop).
        // Via a SYNCHRONOUS helper, not by locking here. `NSLock.lock()` is annotated unavailable from
        // async contexts — a warning in Swift 5 and an ERROR in Swift 6, since a task can suspend while
        // holding the lock. The comment at the top of this method says exactly that and moved code out
        // of the Task for the reason; locking inline here walked straight back into it. `teardown()`
        // and `isCurrent()` are fine because the annotation is checked lexically at the call site and
        // both are synchronous functions that lock internally. So is this one.
        guard publishStreamIfCurrent(newStream, generation: generation) else {
          // Ours to clean up: it was never published, so `teardown()` cannot reach it.
          newStream.stop()
          created.stop()
          reject("wearables_stream_cancelled", "Stopped before the stream started", nil)
          return
        }

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

      // ONE LAST CHECK, because publishing the stream is not the end of the window. A Stop between the
      // publish above and this line runs `teardown()`, which stops `newStream` and clears it — and
      // starting it here would resurrect a stream the UI has already reported as stopped, with nothing
      // left holding a reference to stop it again. Attaching the listeners first is harmless; starting
      // is the irreversible part, so it is what gets guarded.
      guard isCurrent() else {
        newStream.stop()
        reject("wearables_stream_cancelled", "Stopped before the stream started", nil)
        return
      }

      newStream.start()
      resolve(["started": true, "config": String(describing: newStream.streamConfiguration)])
      } catch {
        teardown()
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
  /// Publish `newStream` as the current stream, but ONLY if `generation` is still the live attempt.
  ///
  /// The check and the publish are one critical section on purpose: as two steps, Stop could run
  /// `teardown()` in the gap — bumping the generation and stopping a `stream` that was still nil —
  /// after which the task published anyway and the stream outlived a Stop that had already resolved.
  /// `teardown()` takes the same lock to bump, so it now either runs entirely before this (and this
  /// returns false) or entirely after (and it finds the stream it needs to stop).
  ///
  /// Synchronous because the caller is inside a `Task`, and `NSLock.lock()` is unavailable from an
  /// async context — see the call site.
  private func publishStreamIfCurrent(_ newStream: MWDATCamera.Stream, generation: Int) -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    guard streamStartGeneration == generation else { return false }
    stream = newStream
    return true
  }

  private func teardown() {
    // INVALIDATE ANY PENDING START FIRST. Tearing down what exists is not enough while a start is
    // still awaiting a selector: that Task holds no reference this can reach, so bumping the
    // generation is the only way to tell it that its result is no longer wanted. Done before the
    // stops, so a Task that checks the token mid-teardown already sees itself superseded.
    stateLock.lock()
    streamStartGeneration &+= 1
    stateLock.unlock()

    stream?.stop()
    session?.stop()
    frameToken = nil
    photoToken = nil
    stream = nil
    session = nil
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
      do {
        let audioSession = AVAudioSession.sharedInstance()
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
        // `record()` REPORTS FAILURE BY RETURNING FALSE, and ignoring it was the difference between
        // a green rung and a measurement. If recording cannot begin the delayed callback still fires,
        // reads a nominally wideband sample rate off the session, and resolves — typically with a
        // zero-byte file — so the diagnostic reports that the glasses negotiated 16 kHz when no
        // glasses audio was captured at all. Rejecting immediately, and handing the route back on the
        // way out, because this path also holds HFP.
        guard recorder.record() else {
          try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
          reject(
            "wearables_audio_recorder_not_started",
            "AVAudioRecorder.record() returned false — recording never began, so there is no sample "
              + "rate to report. The session is configured but the recorder could not start.",
            nil
          )
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
        // HAND THE GLASSES BACK ON THE FAILURE PATH TOO. Everything after `setActive(true)` runs
        // inside this do — notably constructing the AVAudioRecorder, which throws on a bad settings
        // dictionary or an unwritable URL. Rejecting without deactivating leaves the session active,
        // and HFP and A2DP are mutually exclusive: the glasses stay pinned to the 8 kHz mono profile
        // for every other app until something else happens to reset the session. The success path
        // already treats deactivation as the other half of choosing HFP deliberately; a failed rung
        // owes the same.
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        reject("wearables_audio_failed", "HFP capture failed: \(Self.describe(error))", error)
      }
    }

    // AVAudioApplication landed in iOS 17; this app deploys to 15.1, so the older
    // AVAudioSession entry point is still required.
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: proceed)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(proceed)
    }
  }

  // MARK: - 9. Step 0 check: does HFP survive a DAT stream?

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

    Task {
      let audio = AVAudioSession.sharedInstance()
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

        let created = try sdk.createSession(deviceSelector: selector)
        session = created
        try created.start()
        deadline = Date().addingTimeInterval(10)
        while created.state != .started, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard created.state == .started else {
          let stalled = created.state.description
          teardown()
          reject("wearables_session_not_started", "Stalled in \(stalled) after 10s", nil)
          return
        }

        // Meta step 1: the stream exists but is NOT started.
        guard let newStream = try created.addStream() else {
          teardown()
          reject("wearables_stream_nil", "addStream() returned nil", nil)
          return
        }
        stream = newStream

        // Meta step 2: HFP comes up while the stream is still stopped.
        _ = try await Self.activateHfpAndSettle()
        let before = Self.routeSnapshot(audio)

        // A DELIVERED FRAME IS THE PRECONDITION OF THE VERDICT, not a detail of it.
        //
        // This rung answers "does the HFP mic route survive a DAT camera stream", and the evidence is
        // that the route is unchanged AFTER the stream is genuinely running. `start()` is
        // asynchronous, so a stream that stalls or never produces a frame also leaves the route
        // unchanged — for the trivial reason that nothing ever happened. Reading the snapshot on a
        // timer alone cannot tell those two apart, and it resolves the benign-looking one as PASS.
        //
        // That is the most expensive failure available here: this verdict decides whether the capture
        // design can use video and glasses audio together. A false PASS ships a design built on a
        // stream that does not run.
        //
        // Observed rather than assumed, using the same publisher `startStream` already measures the
        // first frame with.
        var frameArrivedAt: Date?
        let frameLock = NSLock()
        let observationToken = newStream.videoFramePublisher.listen { (_: VideoFrame) in
          frameLock.lock()
          if frameArrivedAt == nil { frameArrivedAt = Date() }
          frameLock.unlock()
        }

        let startedAt = Date()
        newStream.start()

        // First-frame latency measured 2.2-2.5s on this hardware, so the wait is generous rather
        // than tight: reading early would report a route the stream had not yet had a chance to
        // disturb, and a spurious FAIL here would wrongly push the whole design onto the
        // audio-plus-stills fallback. Polled instead of slept so a healthy stream still spends the
        // full settling time — the deadline bounds the FAILURE case, not the success one.
        let frameDeadline = Date().addingTimeInterval(8)
        while Date() < frameDeadline {
          frameLock.lock()
          let seen = frameArrivedAt != nil
          frameLock.unlock()
          if seen { break }
          try? await Task.sleep(nanoseconds: 200_000_000)
        }

        frameLock.lock()
        let firstFrame = frameArrivedAt
        frameLock.unlock()

        guard let firstFrame else {
          _ = observationToken
          teardown()
          try? audio.setActive(false, options: .notifyOthersOnDeactivation)
          reject(
            "wearables_stream_no_frames",
            "The stream started but delivered NO frames within 8s, so the route snapshot proves "
              + "nothing: an unchanged route is what a stalled stream looks like too. This is not a "
              + "verdict on HFP — the stream itself needs investigating first.",
            nil
          )
          return
        }

        // Let the running stream disturb the route if it is going to, measured from the frame rather
        // than from `start()` so the settling window is the same regardless of startup latency.
        let settleRemaining = 4.0 - Date().timeIntervalSince(firstFrame)
        if settleRemaining > 0 {
          try? await Task.sleep(nanoseconds: UInt64(settleRemaining * 1_000_000_000))
        }
        let after = Self.routeSnapshot(audio)

        _ = observationToken
        teardown()
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)

        resolve([
          "beforeStreamStart": before,
          "afterStreamStart": after,
          // Reported, so the verdict carries its own evidence rather than asking to be trusted.
          "firstFrameLatencyMs": Int(firstFrame.timeIntervalSince(startedAt) * 1000),
          "framesDelivered": true,
        ])
      } catch {
        teardown()
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
        reject("wearables_hfp_stream_check_failed",
               "checkHfpWithStream failed: \(Self.describe(error))", error)
      }
    }
  }

  // MARK: - 10. Step 0 check: does the phone camera disturb the HFP route?

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
        _ = try await Self.activateHfpAndSettle()
        let before = Self.routeSnapshot(audio)

        // NARRATION RUNS DURING THE STILL, so the check has to run one too.
        //
        // The proposed walkthrough records continuously while the estimator takes phone photos, and a
        // shutter can INTERRUPT OR STOP an active recorder while leaving `currentRoute` on Bluetooth
        // HFP — AVFoundation reconfigures the capture graph, and the route is not what notices. All
        // three route snapshots then look perfect and the diagnostic declares the workflow safe while
        // the narration for that moment is gone. Route health was never the whole question; it was the
        // part that was easy to sample.
        //
        // Failing to start the recorder does NOT fail the rung — that is a separate defect, measured
        // by rung 8 — but it is reported, so a route-only result cannot be mistaken for a full one.
        let narrationUrl = FileManager.default.temporaryDirectory
          .appendingPathComponent("wearables-narration-\(Int(Date().timeIntervalSince1970)).m4a")
        let narration = try? AVAudioRecorder(url: narrationUrl, settings: [
          AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
          AVSampleRateKey: 48_000.0,
          AVNumberOfChannelsKey: 1,
        ])
        let narrationStarted = narration?.record() ?? false
        if narrationStarted {
          // Long enough to hold a measurable amount of audio before the shutter, so "it stopped" and
          // "it never really began" are distinguishable by the byte count below.
          try? await Task.sleep(nanoseconds: 1_000_000_000)
        }

        let capture = AVCaptureSession()
        capture.sessionPreset = .photo
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
          try? audio.setActive(false, options: .notifyOthersOnDeactivation)
          reject("wearables_no_camera", "No video capture device available", nil)
          return
        }
        capture.beginConfiguration()
        if capture.canAddInput(input) { capture.addInput(input) }
        let photo = AVCapturePhotoOutput()
        if capture.canAddOutput(photo) { capture.addOutput(photo) }
        capture.commitConfiguration()

        capture.startRunning()
        try? await Task.sleep(nanoseconds: 2_000_000_000)

        // AND ACTUALLY TAKE THE PICTURE. Opening the session is not the operation the design needs
        // to be safe — the feature takes phone STILLS during a glasses walk, and the still-capture
        // and shutter phase is where AVFoundation reconfigures hardware. A disturbance confined to
        // that phase would be absent from all three snapshots while the verdict declared phone stills
        // safe, which is precisely the answer this rung exists to give and the one it would get wrong.
        //
        // SAMPLED THROUGHOUT THE SHUTTER, not once just after submitting it.
        //
        // `capturePhoto` only ENQUEUES the capture; the shutter and the processing happen afterwards,
        // asynchronously. A single snapshot on the next line therefore usually reads the route BEFORE
        // anything has happened — so a route that drops when the shutter fires and recovers before the
        // delegate returns is invisible in every sample, and the rung reports phone stills safe on the
        // strength of having looked in the one moment nothing was going on.
        //
        // A transient drop is not a lesser version of a permanent one here: the walkthrough is
        // narrating continuously, so audio lost for the length of a shutter is exactly the sentence
        // that explains the photo. The WORST route seen across the whole capture is what the verdict
        // needs, so the poll keeps the first non-HFP sample it observes.
        let shutter = PhotoCaptureProbe()
        photo.capturePhoto(with: AVCapturePhotoSettings(), delegate: shutter)

        // ONE OBSERVATION, and the flag DERIVED FROM IT — never two separate reads of `currentRoute`.
        //
        // Taking the snapshot and then asking the route a second question re-opened the exact hole this
        // poll exists to close: if the route dropped between the two lines, `during` held the healthy
        // snapshot while the flag said a loss had been seen — and because every later re-snapshot is
        // gated on that flag, the loss was detected and then permanently discarded. The verdict then
        // read a healthy `during` and passed a run where the route was lost.
        //
        // Worst-sample-wins, and `during` is only ever replaced by a sample that is actually worse.
        // The RATE matters as much as the port. `describePhoneCameraCheck` has a whole branch for a
        // dip on an unchanged port, and it reads `during.sampleRate` — so watching only for port loss
        // would leave that branch reading the pre-shutter sample taken before anything happened, and a
        // shutter that renegotiates HFP to 8 kHz and back would stay exactly as invisible as before.
        //
        // "Worse" therefore means EITHER: the port is no longer HFP, or the rate is lower than the
        // worst seen so far. `during` is only ever replaced by a sample that is genuinely worse.
        var during = Self.routeSnapshot(audio)
        var sawRouteLoss = (during["isBluetoothHFP"] as? Bool) != true
        var worstSampleRate = (during["sampleRate"] as? Double) ?? 0

        // Bounded: a capture that never calls back must not hang the diagnostic, and its absence is
        // itself reportable — an unfinished shutter is a fact about the phone camera, not a reason to
        // stay silent. Polled at 50ms rather than 100ms because the window being hunted is short by
        // nature: a reconfiguration that outlasts a lazy poll was never the hard case.
        let shutterDeadline = Date().addingTimeInterval(5)
        while !shutter.isFinished, Date() < shutterDeadline {
          if !sawRouteLoss,
             !audio.currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }) {
            // FIRST loss wins and is then held: overwriting it with a later healthy sample is how the
            // transient case disappears, which is the whole failure being fixed.
            sawRouteLoss = true
            during = Self.routeSnapshot(audio)
          }
          try? await Task.sleep(nanoseconds: 50_000_000)
        }

        // One final look for a drop that lands on the very last moment of processing.
        if !sawRouteLoss,
           !audio.currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }) {
          during = Self.routeSnapshot(audio)
        }

        let shutterCompleted = shutter.isFinished
        let shutterError = shutter.errorDescription

        // DID THE NARRATION SURVIVE? Asked while the capture session is still up, so a recorder the
        // shutter stopped is caught here rather than being confused with the ordinary teardown below.
        // `isRecording` going false is the signal AVFoundation gives for an interrupted recorder, and
        // it is invisible to `currentRoute`.
        let narrationSurvived = narration?.isRecording ?? false
        narration?.stop()
        let narrationBytes =
          (try? FileManager.default.attributesOfItem(atPath: narrationUrl.path))?[.size] as? Int ?? 0
        try? FileManager.default.removeItem(at: narrationUrl)

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

        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
        resolve([
          "before": before,
          "during": during,
          "after": after,
          // The verdict carries its evidence: "during" only means something if the shutter actually
          // fired. A false here says the route was undisturbed by a capture that never happened.
          "photoCaptured": shutterCompleted,
          "photoError": shutterError ?? "none",
          // The other half of "is this workflow safe": route health says nothing about whether the
          // narration kept running through the shutter.
          "narrationStarted": narrationStarted,
          "narrationSurvivedShutter": narrationSurvived,
          "narrationBytes": narrationBytes,
        ])
      } catch {
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
        reject("wearables_phone_camera_check_failed",
               "checkPhoneCameraDuringHfp failed: \(Self.describe(error))", error)
      }
    }
  }
}

/// Waits for one `AVCapturePhotoOutput` capture to finish, so rung 10 can measure the route while a
/// real shutter is outstanding rather than only while the session is open.
///
/// The photo BYTES are deliberately discarded — this rung is not about image quality, it is about
/// whether taking the picture disturbs the Bluetooth route. What it needs from the delegate is the
/// completion and the error, nothing more.
///
/// `AVCapturePhotoOutput` holds the delegate WEAKLY, so the caller must keep this alive for the
/// duration of the capture; it is held in a local for exactly that reason. The flag is guarded
/// because the delegate callback and the polling loop are different threads.
private final class PhotoCaptureProbe: NSObject, AVCapturePhotoCaptureDelegate {
  private let lock = NSLock()
  private var finished = false
  private var error: String?

  var isFinished: Bool {
    lock.lock()
    defer { lock.unlock() }
    return finished
  }

  var errorDescription: String? {
    lock.lock()
    defer { lock.unlock() }
    return error
  }

  func photoOutput(_ output: AVCapturePhotoOutput,
                   didFinishProcessingPhoto photo: AVCapturePhoto,
                   error: Error?) {
    lock.lock()
    finished = true
    self.error = error.map { String(describing: $0) }
    lock.unlock()
  }
}

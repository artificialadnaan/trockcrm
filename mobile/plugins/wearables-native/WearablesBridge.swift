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
    stateLock.lock()
    firstFrameSize = nil
    firstFrameAt = nil
    streamStartedAt = Date()
    stateLock.unlock()

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
        stream = newStream

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
  private func teardown() {
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

        // Meta step 3: only now.
        newStream.start()
        // First-frame latency measured 2.2-2.5s on this hardware. Four seconds keeps a real
        // margin: reading early would report a route the stream had not yet had a chance to
        // disturb, and a spurious FAIL here would wrongly push the whole design onto the
        // audio-plus-stills fallback.
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        let after = Self.routeSnapshot(audio)

        teardown()
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)

        resolve(["beforeStreamStart": before, "afterStreamStart": after])
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
        let during = Self.routeSnapshot(audio)

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
        resolve(["before": before, "during": during, "after": after])
      } catch {
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
        reject("wearables_phone_camera_check_failed",
               "checkPhoneCameraDuringHfp failed: \(Self.describe(error))", error)
      }
    }
  }
}

/*
 * Records a walkthrough: glasses video muxed with PHONE-microphone audio into one walk.mp4,
 * plus stills on demand.
 *
 * Separate from WearablesBridge deliberately. That file owns the diagnostic ladder and is
 * already large; this owns a session with a lifetime, and mixing the two would put a
 * long-running recording next to one-shot measurements in the same object.
 *
 * WHY THE PHONE'S MICROPHONE AND NOT THE GLASSES'. Measured 2026-08-01, four real walks and
 * three diagnostic rungs:
 *
 *   HFP audio + DAT video   video dies after 3-8s, every walk. The writer was accepting every
 *                           frame it was handed (239 received, 239 appended, 0 dropped) — the
 *                           glasses stopped sending.
 *   video, no audio at all  a steady 30fps for a full 60s.
 *   video + phone mic       a steady 30fps for a full 60s, recording at 48 kHz.
 *
 * So the conflict is the Bluetooth PROFILE SWITCH, not recording. Asking for HFP forces the
 * glasses' radio into hands-free mode and starves the video transport. It is also an upgrade
 * rather than a compromise: HFP caps at 16 kHz mono against the phone's 48 kHz. The remaining
 * tradeoff is physical — a phone in hand is excellent, a phone in a pocket is muffled.
 *
 * Meta's documented ordering constraint (stream created but not started, audio configured and
 * settled, only then stream.start()) is still honoured. It was written for HFP, and this no
 * longer uses HFP, but the sequence costs nothing and the failure it prevents is silent.
 *
 * THE MUXING PROBLEM: the DAT stream carries video only (its `videoFramePublisher` delivers
 * `VideoFrame`s wrapping a `CMSampleBuffer`); audio arrives entirely separately, from
 * `AVAudioEngine`'s input node tap. These are two independent pipelines — one from the glasses'
 * own transport via Meta's SDK, one from CoreAudio — and nothing here can prove they share a
 * clock domain. Trusting each source's own embedded timestamp would let them silently drift, or
 * start minutes apart. Instead, every sample this file appends (video or audio) is re-stamped
 * with `CMClockGetHostTimeClock()`'s time at the moment this class takes custody of it, and the
 * writer's session is opened once, on whichever sample — video or audio — arrives first. Both
 * tracks are always expressed against that one shared origin; neither source's own clock is ever
 * read as a presentation timestamp. See `WalkVideoWriter` below for where this actually happens.
 *
 * THE NARRATION IS ALSO RECORDED ON ITS OWN, to `narration.m4a` beside `walk.mp4`, by an
 * `AVAudioRecorder` that shares nothing with the engine or the writer. Measured 2026-09-02, two
 * production walks: the engine's tap went silent 47.8s and 238s in — cleanly, no holes, no writer
 * refusals — because iOS stops `AVAudioEngine` on an interruption, a route change or a
 * configuration change and nothing restarted it. `WalkAudioCapture` below now restarts it, but a
 * restart that fails still costs the muxed track, and the narration is the input the scope is
 * written from. The standalone file is the copy that does not depend on any of that going right.
 */
import AVFoundation
import CoreMedia
import Foundation
import MWDATCamera
import MWDATCore
import React

@objc(WalkthroughRecorder)
final class WalkthroughRecorder: RCTEventEmitter {
  private var session: DeviceSession?
  private var stream: MWDATCamera.Stream?
  private var photoToken: AnyListenerToken?
  private var frameToken: AnyListenerToken?
  /// The phone-microphone side of the walk — engine, tap, standalone narration file, restart
  /// observers and watchdog — behind one object with one queue. See `WalkAudioCapture`.
  private var audioCapture: WalkAudioCapture?
  private var videoWriter: WalkVideoWriter?
  private var hasListeners = false

  /// EVERY piece of walk state that more than one thread touches, and the single serial queue that
  /// owns all of it.
  ///
  /// Three threads meet on this state: the RN method queue (`captureStill`), the SDK's own
  /// publisher thread (`deliverStill`), and the `Task`s `startWalk`/`endWalk` run in.
  /// `walkDirectoryStorage` and `stillIndexStorage` were bare `var`s read and written across all
  /// three — so two stills delivered close together could read the same index and write over each
  /// other's JPEG, and a still landing while `endWalk` cleared the directory could read it
  /// half-torn-down.
  ///
  /// ONE queue rather than one per field, because the interesting readers want several fields in
  /// the same breath: `deliverStill` needs the in-flight count, the directory and the index
  /// together, and stitching three independent guards would give it a view no single moment ever
  /// had. `DispatchQueue.sync` and not `NSLock`, because `lock()`/`unlock()` are unavailable from
  /// the async contexts `startWalk` and `endWalk` reach this state from under Swift 6.
  ///
  /// Deliberately NOT extended to `session`/`stream`/`videoWriter`/`audioCapture`: those are touched
  /// only by `startWalk` and `endWalk`, and `walkActive` below is what keeps those two from ever
  /// running against each other in the first place. (`audioCapture` restarts its engine from other
  /// threads, but behind its own queue — the REFERENCE is only ever set and cleared here.)
  private let walkStateQueue = DispatchQueue(label: "com.trockcam.walkthrough.state")

  /// Set by the one `startWalk` that wins `claimWalkSlot()`, cleared only by `teardown()`. This
  /// flag *is* the re-entrancy guard — see `claimWalkSlot()` for why it is claimed where it is.
  private var walkActive = false
  private var walkDirectoryStorage: URL?
  private var stillIndexStorage = 0

  /// Stills whose JPEG is actually ON DISK — distinct from `stillIndexStorage`, which only allocates
  /// unique filenames and counts requests that reached the directory whether or not their write
  /// succeeded.
  ///
  /// `endWalk` decides keep-or-discard from THIS, not from the index. The two diverge exactly when a
  /// write fails, and the likeliest reason a write fails is exhausted storage — which is also the
  /// likeliest reason the video's finalize fails, so the two arrive together. Reading the index there
  /// meant `stills > 0` was true with nothing usable on disk: the directory was kept, the recovery
  /// scan refused its unfinalized walk.mp4 and found no still to offer beside it, and a possibly
  /// multi-gigabyte folder stayed on the device permanently, invisible to every path that could have
  /// cleaned it up. On a phone whose storage is the reason walks are deleted after upload at all.
  private var stillsWrittenStorage = 0

  /// Stills that `capturePhoto` ACCEPTED but whose image has not come back on `photoDataPublisher`
  /// yet. `endWalk` waits on this before teardown: tapping Capture and immediately confirming End
  /// walk is a completely ordinary sequence, and without the wait the photo the UI already told the
  /// estimator it took is thrown away when `photoToken` goes nil — silently, since nothing on
  /// either side is expecting a still that never arrives.
  private var stillsInFlightStorage = 0

  /// `.high` per Meta: 720x1280 at 30fps. Read once from here for both the `addStream()` config
  /// below and the video track's `outputSettings`, so the two can never drift apart.
  private static let streamResolution: StreamingResolution = .high

  override static func requiresMainQueueSetup() -> Bool { true }
  /// `audioLevel` (~4/s, `{rms}`) and `audioStalled` (`{attempt, restarted, sinceMs}`) are the two
  /// live microphone signals — the meter and the banner walk.tsx draws while recording. Neither
  /// carries anything the census does not also keep; they exist so a dead microphone is seen in
  /// seconds, on site, rather than read off a title after the walk has been uploaded.
  override func supportedEvents() -> [String] {
    ["walkthrough:still", "walkthrough:error", "walkthrough:audioLevel", "walkthrough:audioStalled"]
  }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  private static func describe(_ error: Error) -> String {
    if let dat = error as? DatError { return dat.description }
    return error.localizedDescription
  }

  /// `error` with `audioUri` added to its `userInfo` — React Native hands a rejected promise's
  /// `NSError.userInfo` to JS as `err.userInfo` (RCTUtils' `RCTJSErrorFromCodeMessageAndNSError`),
  /// which is the only channel a rejection has for anything but a string.
  ///
  /// Wrapped rather than replaced: the original's domain, code and every key it already carried are
  /// preserved, so nothing the writer's own error said is dropped. The explicit `message` passed
  /// alongside still wins over `localizedDescription`, so the census in that string is unaffected.
  private static func rejection(_ error: Error, carrying audioUri: Any) -> NSError {
    let original = error as NSError
    var info = original.userInfo
    info["audioUri"] = audioUri
    return NSError(domain: original.domain, code: original.code, userInfo: info)
  }

  /// Ask iOS for recording permission, and wait for the answer.
  ///
  /// iOS 17 moved this off `AVAudioSession` onto `AVAudioApplication`; the app deploys to 15.2
  /// (withWearablesDat.js's `MIN_IOS_DEPLOYMENT_TARGET`), so both entry points are still required —
  /// the same pair `WearablesBridge.recordGlassesAudio` already carries. Bridged to `async` with a
  /// continuation rather than restructured around the callback: `startWalk` is already one linear
  /// `Task`, and a callback here would either nest the whole start sequence inside it or need a
  /// lock to hand the answer back — and `NSLock` is unavailable from the async context that
  /// sequence runs in.
  private static func requestRecordPermission() async -> Bool {
    await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
      }
    }
  }

  /// Artifacts live in the DOCUMENTS directory, never tmp. iOS purges tmp, and a walk whose
  /// stills vanish before the upload queue drains is a site visit that has to be repeated.
  private static func makeWalkDirectory(_ walkId: String) throws -> URL {
    let docs = try FileManager.default.url(
      for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let dir = docs.appendingPathComponent("walkthroughs/\(walkId)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  // MARK: - Guarded walk state

  /// Claim the recorder for exactly one walk, atomically. Returns false when a walk already owns it.
  ///
  /// `WalkthroughRecorder` is a singleton — React Native builds one instance per bridge — so a
  /// second `startWalk` without this guard silently overwrites `session`, `stream`, `videoWriter`
  /// and the walk directory of a walk that is still recording. The first walk's stream keeps
  /// delivering into a writer nobody can reach any more, and twenty minutes of a site visit end up
  /// in a file that is never finalized.
  ///
  /// Claimed at the VERY TOP of `startWalk`'s Task — before the microphone prompt, before the
  /// directory exists — and that ordering is load-bearing, not tidiness. Every other exit from
  /// `startWalk` calls `teardown()`, and `teardown()` releases this flag and stops the session
  /// unconditionally. If the claim happened any later, a second `startWalk` that failed its own
  /// microphone check would call `teardown()` while holding no claim, and take the FIRST walk's
  /// live recording down with it — the exact damage this guard exists to prevent.
  private func claimWalkSlot() -> Bool {
    walkStateQueue.sync {
      guard !walkActive else { return false }
      walkActive = true
      walkDirectoryStorage = nil
      stillIndexStorage = 0
      stillsWrittenStorage = 0
      // A previous walk that ended while a still was genuinely lost leaves this non-zero; without
      // the reset THIS walk's endWalk would wait out its whole deadline for that dead request.
      stillsInFlightStorage = 0
      return true
    }
  }

  private func setWalkDirectory(_ url: URL) {
    walkStateQueue.sync { walkDirectoryStorage = url }
  }

  /// Read the walk directory and clear it in one step, returning whatever was there so `teardown()`
  /// can delete it. Atomic, and clearing BEFORE the removal, so a `deliverStill` racing teardown
  /// gets one of exactly two clean outcomes: it takes the live URL and writes a JPEG into a
  /// directory that is about to be removed wholesale, or it takes nil and drops the image. Removing
  /// the directory first and clearing after would add a third — a still handed a URL whose parent
  /// no longer exists, which fails the write and reports "Could not save still" about a walk that
  /// was already over.
  private func clearWalkDirectory() -> URL? {
    walkStateQueue.sync {
      let previous = walkDirectoryStorage
      walkDirectoryStorage = nil
      return previous
    }
  }

  /// How many stills have been written for the current walk. Reported by `endWalk`.
  private var stillIndex: Int { walkStateQueue.sync { stillIndexStorage } }
  private var stillsWritten: Int { walkStateQueue.sync { stillsWrittenStorage } }

  // MARK: - Start

  @objc(startWalk:resolver:rejecter:)
  func startWalk(_ walkId: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    // Mirrors the guard in WearablesBridge.startStream(): `Wearables.configure()` must already
    // have succeeded — via the app's one-time startup call in _layout.tsx, or Profile's
    // PairingRow — before `AutoDeviceSelector` below can ever resolve a device. Without this
    // guard, an unconfigured SDK sends that selector into the same 8-second wait as a genuine
    // "no device" case, then fails with `walk_no_device` — blaming the glasses for a failure
    // that actually happened at launch. Reads `WearablesBridge.configured` directly (rather than
    // tracking a second flag here) so the two can never disagree about whether configure() ran.
    guard WearablesBridge.configured else {
      reject(
        "walk_not_configured",
        "Wearables SDK is not configured. The app attempts this once at startup; if that failed "
          + "(bad Meta credentials, SDK init error), a walk cannot start until it succeeds — "
          + "check Profile's \"Pair glasses\" for the real cause.",
        nil
      )
      return
    }
    Task {
      // ONE WALK AT A TIME, and this is claimed before anything else in the method — including the
      // microphone prompt, which is the longest suspension in the whole start sequence and so the
      // widest window for a second Start to land in.
      //
      // This is the ONLY exit below that must not call teardown(): the walk that owns the recorder
      // is still recording, and stopping its session or deleting its directory to report that a
      // SECOND start was refused would destroy the very thing being protected.
      guard claimWalkSlot() else {
        reject(
          "walk_already_running",
          "A walkthrough is already recording. End that walk before starting another — the glasses "
            + "and the recorder handle one walk at a time.",
          nil
        )
        return
      }

      // MICROPHONE PERMISSION IS PART OF READINESS, and it is checked before anything else exists
      // to clean up — before the walk directory, before the DAT session, before the writer.
      //
      // Neither `setActive(true)` below nor `AVAudioEngine.start()` fails on a denied microphone.
      // They succeed and deliver silence. So without this, a fresh install (permission never asked)
      // or a previously refused one produces a walk that records video perfectly and captures no
      // narration at all — and the narration is not an accessory here, it is the input the scope is
      // extracted from. That failure surfaces weeks later, from a site nobody can re-walk.
      //
      // Asking FIRST is also what keeps the refusal cheap: nothing has been created yet, so there
      // is no session to stop, no audio session to deactivate, and no `walkthroughs/<id>/` left on
      // disk for upload.ts's `findRecoverableWalks` to offer back as a recoverable walk holding
      // nothing. The claim above is the one thing that does exist by now, which is why this refusal
      // still goes through teardown() — on this path teardown finds nothing to stop and no
      // directory to delete, and does nothing but hand the recorder back.
      //
      // ONE message, and it always points at Settings. This used to branch on whether iOS had
      // already recorded a denial BEFORE we asked, on the theory that a refusal the estimator had
      // just made could be undone by tapping Start again. It cannot: iOS presents the microphone
      // prompt exactly once per install, and after ANY denial — including the very first "Don't
      // Allow" — `requestRecordPermission` returns false immediately without showing anything.
      // Confirmed on device. So the fresh-denial wording sent whoever needed it most into a loop of
      // tapping a button that could never produce a prompt, while the one place that actually fixes
      // it went unmentioned. The reason stays in the text because it is what makes a trip into
      // Settings worth making mid-walk: without narration there is no scope to extract.
      guard await Self.requestRecordPermission() else {
        await teardown(.discard)
        reject(
          "walk_mic_denied",
          "Microphone access for T-Rock Cam is off, so this walk would record video with no "
            + "narration — and the scope is written from what you say. Turn it on in Settings > "
            + "T-Rock Cam > Microphone, then start the walk again.",
          nil
        )
        return
      }

      let audio = AVAudioSession.sharedInstance()
      do {
        // Published to the guarded state only after it exists on disk, so `deliverStill` can never
        // be handed a directory that failed to be created. `claimWalkSlot()` above already zeroed
        // the still index and the in-flight count for this walk.
        let dir = try Self.makeWalkDirectory(walkId)
        setWalkDirectory(dir)

        let sdk = Wearables.shared
        let selector = AutoDeviceSelector(wearables: sdk)
        var deadline = Date().addingTimeInterval(8)
        while selector.activeDevice == nil, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard selector.activeDevice != nil else {
          await teardown(.discard)
          reject("walk_no_device", "No eligible glasses after 8s", nil)
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
          await teardown(.discard)
          reject("walk_session_not_started", "Session stalled in \(stalled)", nil)
          return
        }

        // Meta step: stream created, NOT started.
        guard let newStream = try created.addStream(
          config: StreamConfiguration(videoCodec: .raw, resolution: Self.streamResolution, frameRate: 30)
        ) else {
          await teardown(.discard)
          reject("walk_stream_nil", "addStream() returned nil", nil)
          return
        }
        stream = newStream

        photoToken = newStream.photoDataPublisher.listen { [weak self] (photo: PhotoData) in
          self?.deliverStill(photo)
        }

        // Audio comes from the PHONE, and the absent option is the point.
        //
        // Measured on hardware 2026-08-01, across four real walks and three diagnostic rungs:
        //   - HFP audio + DAT video: video dies after 3-8 seconds, every time. The writer was
        //     accepting every frame it was handed (239 received, 239 appended, 0 dropped) — the
        //     glasses simply stopped sending.
        //   - Video with no audio session at all: a steady 30fps for a full 60 seconds.
        //   - Video with the PHONE's microphone recording: also a steady 30fps for 60 seconds,
        //     at 48 kHz.
        //
        // So the conflict is the Bluetooth PROFILE SWITCH, not recording. Requesting HFP forces
        // the glasses' radio into hands-free mode and starves the video transport. Leaving
        // `.allowBluetoothHFP` out keeps the glasses doing nothing but video.
        //
        // This is an UPGRADE, not a compromise: HFP caps at 16 kHz mono, the phone records at
        // 48 kHz. The tradeoff is physical rather than technical — a phone in hand is excellent,
        // a phone in a pocket is muffled and full of clothing noise.
        try audio.setCategory(.playAndRecord, mode: .default, options: [])
        try audio.setActive(true)
        // A moment to settle. There is no specific port to wait FOR here — unlike HFP, the
        // built-in microphone is already the default — but the route still switches when the
        // category changes, and reading it mid-switch reports the old one.
        try? await Task.sleep(nanoseconds: 300_000_000)

        let input = audio.currentRoute.inputs.first
        // The guard is INVERTED from what it used to be. It once refused unless the route was the
        // glasses; the glasses are now exactly what must not be selected, because HFP is what
        // kills the video. If they are somehow chosen anyway, a walk would record 3 seconds of
        // video and nobody would find out until the file was inspected.
        guard input?.portType != .bluetoothHFP else {
          await teardown(.discard)
          reject(
            "walk_route_is_glasses",
            "Audio would record from the glasses over Bluetooth HFP, which stops the video stream "
              + "after a few seconds. Disconnect the glasses as an audio device (they stay "
              + "connected for video) and start again.",
            nil
          )
          return
        }

        // The microphone side is built now, against the route that just settled, and held on
        // `audioCapture` from this line — BEFORE its narration recorder or engine start — so every
        // failure path below reaches `teardown()` with something that knows how to stop them.
        //
        // The standalone narration file starts FIRST, ahead of the engine: it is its own client of
        // the audio session, and whatever the hardware does when a second input client arrives is
        // best done before the input node's format is read and the writer is built around it.
        // It never fails the walk — see `WalkAudioCapture.startNarration`.
        let capture = WalkAudioCapture(
          narrationUrl: dir.appendingPathComponent("narration.m4a")
        ) { [weak self] name, body in
          self?.emitAudioEvent(name, body)
        }
        audioCapture = capture
        capture.startNarration()

        // The writer and both its inputs are built only now: video's dimensions were known all
        // along, but audio's format is only known once the route has settled, and AVAssetWriter
        // requires every input to be added before startWriting() — so there is no point building
        // either input before this moment.
        let videoUrl = dir.appendingPathComponent("walk.mp4")
        let writer = try AVAssetWriter(outputURL: videoUrl, fileType: .mp4)

        let frameSize = Self.streamResolution.videoFrameSize
        let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
          AVVideoCodecKey: AVVideoCodecType.h264,
          AVVideoWidthKey: Int(frameSize.width),
          AVVideoHeightKey: Int(frameSize.height),
        ])
        vInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(vInput) else {
          await teardown(.discard)
          reject("walk_writer_video_input_refused", "AVAssetWriter refused the video input", nil)
          return
        }
        writer.add(vInput)

        // AVAudioEngine's input node is read only now, against the route that just settled above
        // and with the narration recorder already running. Reading it any earlier would ask the
        // engine to describe a route that has not switched over yet — the same "asked too early"
        // mistake Meta's ordering constraint exists to prevent, one layer further down.
        let recordingFormat = capture.inputFormat()
        let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
          AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
          // Whatever the route actually negotiated — 48 kHz mono is expected from the phone's
          // microphone, but this reads the
          // format the hardware reports rather than assuming it.
          AVSampleRateKey: recordingFormat.sampleRate,
          AVNumberOfChannelsKey: Int(recordingFormat.channelCount),
        ])
        aInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(aInput) else {
          await teardown(.discard)
          reject("walk_writer_audio_input_refused", "AVAssetWriter refused the audio input", nil)
          return
        }
        writer.add(aInput)

        // Both inputs are attached; nothing may be added after this.
        guard writer.startWriting() else {
          await teardown(.discard)
          reject("walk_writer_start_failed",
                 "AVAssetWriter.startWriting() failed: \(writer.error?.localizedDescription ?? "unknown")",
                 writer.error)
          return
        }

        let vw = WalkVideoWriter(
          writer: writer, videoInput: vInput, audioInput: aInput, audioFormat: recordingFormat, videoUrl: videoUrl
        ) { [weak self] reason in
          self?.reportWriterFailure(reason)
        }
        videoWriter = vw

        // Subscribing here, right before start(), is still well before anything can fire: no
        // frames exist until newStream.start() below, and no audio buffers exist until
        // `capture.start` gets the engine running just after this.
        frameToken = newStream.videoFramePublisher.listen { [weak vw] (frame: VideoFrame) in
          vw?.appendVideoFrame(frame)
        }
        do {
          try capture.start(format: recordingFormat) { [weak vw] buffer in
            vw?.appendAudioBuffer(buffer)
          }
        } catch {
          // `capture` is already on `audioCapture`, so teardown() removes the tap it installed and
          // stops the narration recorder along with everything else.
          await teardown(.discard)
          reject("walk_audio_engine_failed", "AVAudioEngine.start() failed: \(Self.describe(error))", error)
          return
        }

        // Meta step: only now.
        newStream.start()

        resolve([
          "walkId": walkId,
          "directory": dir.absoluteString,
          "videoUri": videoUrl.absoluteString,
          "inputPortName": input?.portName ?? "none",
          "negotiatedSampleRate": audio.sampleRate,
        ])
      } catch {
        await teardown(.discard)
        reject("walk_start_failed", "startWalk failed: \(Self.describe(error))", error)
      }
    }
  }

  // MARK: - Capture

  @objc(captureStill:rejecter:)
  func captureStill(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let stream else {
      reject("walk_not_recording", "No walk is running", nil)
      return
    }
    // Fire-and-forget by design: capturePhoto only reports that the request was ACCEPTED. The
    // image arrives later on photoDataPublisher and is emitted as a walkthrough:still event.
    let requested = stream.capturePhoto(format: .jpeg)
    // Counted only when the SDK actually took the request. A refused capture never produces a
    // publisher event, so counting it would leave endWalk waiting out its whole deadline for an
    // image that was never coming.
    if requested { adjustStillsInFlight(+1) }
    resolve(["requested": requested])
  }

  @discardableResult
  private func adjustStillsInFlight(_ delta: Int) -> Int {
    walkStateQueue.sync {
      stillsInFlightStorage = max(0, stillsInFlightStorage + delta)
      return stillsInFlightStorage
    }
  }

  private var stillsInFlight: Int { walkStateQueue.sync { stillsInFlightStorage } }

  /// Give every accepted-but-undelivered still a bounded chance to land before the publisher that
  /// would deliver it is torn down.
  ///
  /// Five seconds: a Ray-Ban Meta JPEG round trip measures in the low seconds over the link, so
  /// this clears immediately in the normal case and only ever elapses in full when an image is
  /// genuinely never coming. Waiting is the right trade even so — the estimator has already been
  /// told the photo was taken, and a site visit missing a photo it believes it has is worse than an
  /// end-of-walk pause. Bounded rather than unbounded because a lost capture must not strand the
  /// walk: the video is finalized by this point, so the walk completes either way.
  private func awaitPendingStills(timeout: TimeInterval = 5.0) async {
    guard stillsInFlight > 0 else { return }
    let deadline = Date().addingTimeInterval(timeout)
    while stillsInFlight > 0, Date() < deadline {
      // 50ms: short enough that the common case (image already in flight, arriving imminently) adds
      // no perceptible delay, long enough not to spin a cooperative thread on a sync-queue read.
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
  }

  /// Runs on the SDK's publisher thread, which is why all three pieces of walk state it needs are
  /// taken in ONE hop through `walkStateQueue` instead of three:
  ///
  ///   - the in-flight count is released FIRST, and on every path out of this function including
  ///     the nil-directory return and the write failure below. This request has resolved either
  ///     way, and a decrement that only ran on the happy path would leave `endWalk` waiting out its
  ///     full deadline after a photo that failed to save — the one case where the estimator is
  ///     already going to be told something went wrong.
  ///   - the directory is read and the index bumped in the same critical section, so two stills
  ///     delivered back to back cannot take the same number and overwrite each other's JPEG, and a
  ///     still cannot pair this walk's index with a directory `teardown()` has already cleared.
  ///
  /// A nil directory means `teardown()` won: the walk this image belonged to is over, or its start
  /// failed and the directory has been deleted. Dropping the image is the only correct answer —
  /// the alternatives are a JPEG added to a walk that has already been reported and counted, or a
  /// write into a deleted directory that fails and raises "Could not save still" about a walk
  /// nobody is watching any more.
  private func deliverStill(_ photo: PhotoData) {
    let target: URL? = walkStateQueue.sync { () -> URL? in
      guard let dir = walkDirectoryStorage else { return nil }
      stillIndexStorage += 1
      return dir.appendingPathComponent(String(format: "still-%03d.jpg", stillIndexStorage))
    }
    // Released only when this request can no longer produce a manifest entry — after the write AND
    // the event, or on any early return. It used to be released at the TOP of this function, which
    // made `awaitPendingStills` observe zero while the write was still running: `endWalk` resolved,
    // the JS reducer went terminal, and the `walkthrough:still` event that arrived a moment later was
    // ignored by a reducer that had stopped listening. The JPEG existed in the directory, was absent
    // from the upload manifest, and was deleted by cleanup without ever being filed — the one
    // sequence (Capture, then immediately End) this wait exists to protect.
    defer { walkStateQueue.sync { stillsInFlightStorage = max(0, stillsInFlightStorage - 1) } }
    guard let url = target else { return }
    do {
      try photo.data.write(to: url)
    } catch {
      if hasListeners {
        sendEvent(withName: "walkthrough:error",
                  body: ["message": "Could not save still: \(Self.describe(error))"])
      }
      return
    }
    // Counted only now, with the bytes genuinely on disk. See `stillsWrittenStorage`.
    walkStateQueue.sync { stillsWrittenStorage += 1 }
    if hasListeners {
      sendEvent(withName: "walkthrough:still",
                body: ["uri": url.absoluteString, "bytes": photo.data.count, "source": "glasses"])
    }
  }

  /// Called by `WalkVideoWriter` (from `mediaQueue`, via the closure passed to its initializer)
  /// the first time an append fails. `sendEvent` is safe to call off the main thread — `deliverStill`
  /// above already does so for photo-write failures.
  private func reportWriterFailure(_ reason: String) {
    guard hasListeners else { return }
    sendEvent(withName: "walkthrough:error",
              body: ["message": "Walk video recording failed: \(reason)"])
  }

  /// Called by `WalkAudioCapture` (from its own queue) for `walkthrough:audioLevel` and
  /// `walkthrough:audioStalled`. Same off-main-thread `sendEvent` the two callers above rely on.
  private func emitAudioEvent(_ name: String, _ body: [String: Any]) {
    guard hasListeners else { return }
    sendEvent(withName: name, body: body)
  }

  /// The census keys `WalkVideoWriter.finalize()` can still move after `endWalk` has read the
  /// census once — every audio counter its final drain touches. Re-read from the writer after
  /// finalize returns; see `endWalk`. The video counters cannot move there (no frame reaches the
  /// writer once `frameToken` is nil) and `writerStatus` deliberately must not.
  private static let audioCounterKeys = [
    "audioBuffersReceived",
    "audioBuffersAppended",
    "audioBuffersDropped",
    "audioSecondsAppended",
    "longestAudioDropRun",
    "audioBuffersRefusedForFormat",
    "audioBuffersPending",
  ]

  /// The `audio` object of the census `endWalk` resolves — the writer's per-buffer counters and the
  /// capture's restart record, folded into the one shape the server's `captureCensus` pins:
  /// `{ buffersReceived, buffersAppended, buffersDropped, longestDropRun, secondsAppended,
  ///    engineRestarts, standaloneSecondsRecorded, events: [{ atMs, kind }] }`.
  /// Every existing top-level key of the census is left where it was; the JS reducer reads those.
  private static func audioCensus(from census: [String: Any], capture: WalkAudioCapture.Report?) -> [String: Any] {
    [
      "buffersReceived": (census["audioBuffersReceived"] as? Int) ?? 0,
      "buffersAppended": (census["audioBuffersAppended"] as? Int) ?? 0,
      "buffersDropped": (census["audioBuffersDropped"] as? Int) ?? 0,
      "longestDropRun": (census["longestAudioDropRun"] as? Int) ?? 0,
      "secondsAppended": (census["audioSecondsAppended"] as? Double) ?? 0,
      "engineRestarts": capture?.engineRestarts ?? 0,
      "standaloneSecondsRecorded": capture?.narrationSeconds ?? 0,
      "events": capture?.events ?? [],
    ]
  }

  // MARK: - End

  @objc(endWalk:rejecter:)
  func endWalk(_ resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      // Stop production before finalizing: no more frames or audio buffers should reach
      // `videoWriter` once finalize() starts, or markAsFinished()/finishWriting() could race a
      // still-arriving append.
      frameToken = nil
      // Synchronous, and before the census: `stop()` removes the tap, stops the engine, and closes
      // narration.m4a — whose index is written by that close, the same way walk.mp4's is by
      // finishWriting. It also hands back what the capture saw, which the census below carries.
      let narration = audioCapture?.stop()
      audioCapture = nil

      // Taken BEFORE finalize(), while the writer still holds its live state — afterwards
      // `writer.status` reports the outcome of finishWriting rather than what happened during
      // the walk, which is the part in question.
      var census = videoWriter?.census() ?? [:]
      // Resolved beside videoUri, and nil is an ordinary answer: the recorder could not start, or
      // recorded nothing. The walk is never failed over it — see `WalkAudioCapture.startNarration`.
      let audioUri: Any
      if let url = narration?.audioUri { audioUri = url.absoluteString } else { audioUri = NSNull() }

      let result = await videoWriter?.finalize()

      // The AUDIO counters are read again here, and only those. `finalize()` is not a passive step
      // for them: it drains the buffers the input refused during the last seconds of the walk and
      // counts whatever it still will not take, so the numbers read above are stale by up to a full
      // queue — 500 buffers, about ten seconds of narration. Narration that actually landed would be
      // reported as a shortfall (session.ts's `assessAudioCoverage` compares seconds against a
      // five-second tolerance) and the drops the drain could not place would be missing from the
      // filed census entirely. Everything else stays as it was read above, where the writer's own
      // status still described the walk rather than the outcome of finishWriting.
      if let drained = videoWriter?.census() {
        for key in Self.audioCounterKeys {
          if let value = drained[key] { census[key] = value }
        }
      }
      census["audio"] = Self.audioCensus(from: census, capture: narration)

      // Placed AFTER finalize and BEFORE teardown, deliberately. A still that lands here costs
      // nothing — deliverStill only writes a JPEG and emits an event, it never touches the writer —
      // so waiting before finalize would only delay the video for no benefit. Teardown is the hard
      // edge: it nils photoToken and stops the stream, and any image still in transit at that
      // moment is gone. The JS reducer already accepts stills while "finalizing" (session.ts's
      // canAcceptStill), so an event emitted during this window still reaches the walk.
      await awaitPendingStills()

      // Read after the wait, not before it: a still that lands during the window above is part of
      // this walk, and reporting the pre-wait count would undercount exactly the photo this wait
      // exists to save.
      let stills = stillsWritten
      let finalized: Bool
      if case .success = result { finalized = true } else { finalized = false }
      // `.keep`, and this is the one call site where that is true. Everything in
      // `walkthroughs/<walkId>/` by now is the site visit itself — the finalized walk.mp4 and every
      // still — and none of it has been uploaded: the JS queue reads these files off disk AFTER
      // this resolves. `.discard` here would delete the recording on the way to reporting success.
      // Kept on the finalize-FAILURE path too whenever a still made it to disk: a truncated walk.mp4
      // and the photos beside it are still the only record of a walk nobody can repeat, and
      // upload.ts's recovery scan is exactly the mechanism that gets them back.
      //
      // A failed finalize with ZERO stills is the one case where that reasoning runs out, and the
      // difference is not tidiness — it is that NOTHING can ever open the directory again. JS never
      // queues a walk whose endWalk rejected (no videoUri to enqueue), and the recovery scan now
      // reads the container itself: an unfinalized walk.mp4 is refused, and a directory holding
      // nothing but a refused video is skipped rather than offered. So keeping it leaves bytes that
      // every path on the phone agrees to ignore, accumulating for the life of the install on a
      // device whose storage is the reason walks get deleted after upload in the first place.
      // Discarding a recording is the graver mistake, so this asks for a still — one photo of the
      // site is a reason to keep everything — or a narration file, and only discards when the walk
      // produced none of the three.
      //
      // narration.m4a counts for exactly the same reason a still does, and it is the finalize
      // failure this whole class exists for: the muxed track is the thing that broke, and the
      // standalone recording of the same twenty minutes is sitting closed in that directory.
      // `WalkAudioCapture.stop()` ran at the top of this method, so the file's index is written, and
      // upload.ts's recovery scan asks an .m4a the same moov question it asks walk.mp4 and offers
      // the walk on the strength of either — but only while the directory still exists.
      let narrationKept = narration?.audioUri != nil
      await teardown(finalized || stills > 0 || narrationKept ? .keep : .discard)

      switch result {
      case .success(let url):
        resolve(["videoUri": url.absoluteString, "audioUri": audioUri, "stills": stills, "census": census])
      case .failure(let error):
        // A truncated walk.mp4 that the upload queue then ships is worse than a failure here —
        // it looks like success. Reject rather than resolve with a URI nobody finalized.
        // The census rides along in the message: a walk that failed to finalize is exactly when
        // knowing how many frames arrived versus were refused matters most.
        //
        // THE NARRATION RIDES OUT TOO, on `userInfo`, because it is not the video's failure.
        // `stop()` closed narration.m4a before finalize ran and the teardown above kept the
        // directory for it — but a walk that took even one still is filed from that directory and
        // then DELETED (upload.ts's `finishWalkCleanup` removes the whole directory once the
        // artifacts it knows about are filed). A rejection that mentioned only the video would lose
        // the one recording that survived, on exactly the walk this class exists for. JS reads it
        // off `err.userInfo` and queues it as the failed walk's audio artifact.
        reject("walk_video_finalize_failed",
               "endWalk failed to finalize walk.mp4: \(Self.describe(error)) — census: \(census)",
               Self.rejection(error, carrying: audioUri))
      case nil:
        reject("walk_video_finalize_failed",
               "endWalk failed to finalize walk.mp4: no writer was ever created", nil)
      }
    }
  }

  /// What `teardown()` does with `walkthroughs/<walkId>/`. Spelled out at every call site rather
  /// than given a default, because the two cases are one word apart and picking the wrong one
  /// deletes a finished site visit.
  private enum WalkDirectoryDisposition {
    /// A walk that produced nothing anyone can look at: a `startWalk` that failed, or an `endWalk`
    /// whose finalize failed with neither a still nor a narration file on disk. Nothing in the
    /// directory is a recording — at most a `walk.mp4` the writer never finished — and leaving it is
    /// not merely untidy. At login, `upload.ts`'s `findRecoverableWalks` scans `Documents/walkthroughs/` for
    /// directories with no manifest entry; it refuses an unfinalized `walk.mp4` and skips a
    /// directory left holding only that, so nothing on the phone will ever open one of these again.
    /// A failed start additionally reaches this on the one path where the app has ALREADY told the
    /// user the walk could not start, where a phantom "recoverable" walk contradicts it outright.
    case discard
    /// An `endWalk` that ran. The directory holds the walk this whole file exists to produce, and
    /// the upload queue reads those files off disk afterwards.
    case keep
  }

  /// Stop everything, release the audio session, and hand the recorder back for the next walk.
  ///
  /// This no longer requests HFP, so the glasses are not pinned into hands-free mode the way
  /// `WearablesBridge.recordGlassesAudio` has to worry about — but a `.playAndRecord` session left
  /// active still holds the microphone for this app alone, keeps the input route switched for
  /// everything else on the device, and blocks other apps from recording at all. Deactivating with
  /// `.notifyOthersOnDeactivation` is what returns the microphone and lets whatever was playing
  /// before the walk resume.
  ///
  /// Always cancels the video writer rather than finishing it. `endWalk` finalizes the writer
  /// itself, via `WalkVideoWriter.finalize()`, before calling this — by the time this runs, the
  /// writer is already `.completed`, `.cancelled`, or `.failed`, and `cancel()` on any of those
  /// is a no-op. On the startWalk-failure paths, where no finalize ever ran, this is what
  /// actually releases the writer's resources.
  ///
  /// The single release point for `claimWalkSlot()`, and the reason a failed start cannot wedge the
  /// recorder shut: every exit from `startWalk` except the "already running" rejection comes through
  /// here, so the claim is given back whether the walk succeeded, failed, or never got going.
  private func teardown(_ disposition: WalkDirectoryDisposition) async {
    frameToken = nil
    // Idempotent: the endWalk path has already stopped it and pays nothing here. On the startWalk
    // failure paths this is what removes the tap, stops the engine and closes the narration file —
    // before the directory holding that file is removed below, on the `.discard` paths.
    audioCapture?.stop()
    audioCapture = nil
    stream?.stop()
    session?.stop()
    photoToken = nil
    stream = nil
    session = nil
    videoWriter?.cancel()
    videoWriter = nil

    // AFTER the publisher and the writer are gone above, so nothing is left that could put a file
    // back between the clear and the remove: `photoToken = nil` ends still delivery, and
    // `cancel()` makes the writer delete its own output rather than keep writing to it.
    let abandoned = clearWalkDirectory()
    if case .discard = disposition, let abandoned {
      try? FileManager.default.removeItem(at: abandoned)
    }

    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    // Released LAST. A `startWalk` that claimed the slot the moment this cleared would otherwise
    // race the stop()/nil sequence above and build its session against a half-torn-down one.
    walkStateQueue.sync { walkActive = false }
  }
}

/// Owns the `AVAssetWriter` and both of its inputs, and every piece of state that mutates on
/// `mediaQueue`: the writer/input references themselves, whether the writer's session has been
/// opened, and whether an append has failed. Deliberately pulled out of `WalkthroughRecorder`
/// rather than living there as more private properties: the closures that append video and audio
/// samples run on `DispatchQueue.async`/`.sync`, both of which require their closures to be
/// `@Sendable`, and `WalkthroughRecorder` — an `RCTEventEmitter` subclass carrying plenty of
/// state (`session`, `stream`, `videoWriter`, ...) that is NOT confined to one queue — cannot
/// honestly claim `Sendable`. This type is small and fully self-contained instead: everything it
/// owns is either set once at `init` (before any of the closures below exist to race it) or
/// touched only inside a closure submitted to `mediaQueue`. `@unchecked Sendable` documents that
/// discipline rather than asserting it blindly.
///
/// This is also where the file header's clock-reconciliation actually happens: every sample,
/// video or audio, is re-stamped with `mediaClock`'s time at the moment `appendVideoFrame`/
/// `appendAudioBuffer` takes custody of it, and the writer's session opens on whichever sample
/// reaches `append(_:to:track:)` first — see that method.
private final class WalkVideoWriter: @unchecked Sendable {
  private let mediaQueue = DispatchQueue(label: "com.trockcam.walkthrough.mediaWriter")
  private let mediaClock = CMClockGetHostTimeClock()

  private let writer: AVAssetWriter
  private let videoInput: AVAssetWriterInput
  private let audioInput: AVAssetWriterInput
  /// The format `audioInput` was built for. A buffer in any other sample rate or channel count is
  /// declined in `appendAudioBuffer` rather than handed to the writer — see there.
  private let audioFormat: AVAudioFormat
  let videoUrl: URL
  private let onFailure: (String) -> Void

  /// Audio sample buffers the input was not ready for, oldest first, drained at the head of every
  /// later append — video or audio — while the input is ready again. See `append(_:to:track:)`.
  ///
  /// Bounded at ~10 s of narration (1024-frame buffers at 48 kHz are ~21 ms each), which is several
  /// times the longest encoder stall that ever recovers; past it the OLDEST buffer is dropped, so
  /// what survives a long stall is the speech that runs into the moment the writer came back. A
  /// mono buffer is ~4 KB, so a full queue is ~2 MB.
  private var pendingAudio: [CMSampleBuffer] = []
  private static let maxPendingAudio = 500

  private var sessionStarted = false
  private var failed = false
  /// Set alongside `failed`, by the same `fail(reason:)` call, so `finalize()` can report WHY
  /// the latch tripped rather than just that it did.
  private var failureReason: String?

  /// Last presentation timestamp handed to each input. AVAssetWriterInput requires STRICTLY
  /// increasing timestamps per track; a sample that goes backwards stalls the encoder, its queue
  /// stops draining, `isReadyForMoreMediaData` never returns true again, and every later frame is
  /// silently dropped. Measured on a real walk 2026-08-01: 46.8s of audio and 3.4s of video,
  /// because frames were stamped on the SDK's delivery thread BEFORE reaching this serial queue,
  /// so two threads could stamp in one order and arrive in the other.
  /// Video only. The audio tap delivers in order from a single CoreAudio thread and measured
  /// complete on the same walk, so its stamping is deliberately left alone.
  private var lastVideoPts: CMTime = .invalid

  /// Frames dropped because the writer was not ready. Counted so a permanent stall reports itself
  /// instead of producing a short video nobody notices until the file is inspected.
  private var consecutiveVideoDrops = 0

  /// The same run length for audio — measured, but deliberately NOT wired to `fail(reason:)` the
  /// way the video counter above is. Latching makes `endWalk` reject, which marks the walk failed
  /// in JS, and a failed walk queues no video at all (upload-core.ts's `toQueuedWalk`): latching on
  /// audio backpressure would destroy twenty minutes of good footage on top of the narration
  /// already lost. The shortfall rides out in the census instead, and the completion screen says so
  /// plainly. See `audioSecondsAppended`.
  private var consecutiveAudioDrops = 0

  /// Census of what actually happened, reported by `endWalk`.
  ///
  /// Two walks produced ~4s of video against 35-47s of audio, and the file alone cannot say why:
  /// a frame that never arrived and a frame the writer refused look identical afterwards. These
  /// counters separate them. Cheap, and worth keeping — a walk that silently records four seconds
  /// of a forty-second site visit is the single most expensive failure this recorder can have.
  ///
  /// The audio counters answer a DIFFERENT question, because audio fails differently. The glasses
  /// go quiet and never resume, so video is diagnosed by its tail. The phone microphone fails two
  /// ways: the tap keeps delivering while `audioInput.isReadyForMoreMediaData` says no, so losses
  /// land in the MIDDLE of the recording where a tail measurement would call the walk perfect — or
  /// iOS stops the engine and the tap goes quiet for good (measured 2026-09-02; `WalkAudioCapture`
  /// now restarts it and keeps its own record of doing so). `audioSecondsAppended` is what actually
  /// got written, which is the one number that survives both.
  private(set) var videoFramesReceived = 0
  private(set) var videoFramesAppended = 0
  private(set) var videoFramesDropped = 0
  private(set) var audioBuffersReceived = 0
  private(set) var audioBuffersAppended = 0
  private(set) var audioBuffersDropped = 0
  /// Buffers that arrived in a format other than `audioFormat` — after an engine restart against a
  /// route whose hardware format changed. Counted apart from `audioBuffersDropped` because the
  /// remedy is different: these are on narration.m4a, and a census reading only "dropped" would
  /// send someone looking for a writer stall that never happened.
  private(set) var audioBuffersRefusedForFormat = 0
  /// Longest unbroken run of refused audio buffers. Separates one sustained stall (the encoder
  /// never recovered) from scattered hiccups that happen to add up to the same total — the audio
  /// analogue of `secondsSinceLastFrameArrived` being the video discriminator.
  private(set) var longestAudioDropRun = 0
  /// Seconds of phone-microphone audio ACTUALLY written to the audio track, summed from the sample
  /// buffers themselves rather than derived from a buffer count — buffer size is a parameter of the
  /// tap (1024 frames today), and a count would silently change meaning if that were ever retuned.
  private(set) var audioSecondsAppended: Double = 0
  /// Wall-clock seconds from the writer starting to the most recent frame ARRIVING (not appended),
  /// so "frames stopped coming" is distinguishable from "frames kept coming and were refused".
  private(set) var lastFrameArrivedAt: CMTime = .invalid
  private let startedAt = CMClockGetTime(CMClockGetHostTimeClock())

  enum WalkVideoError: LocalizedError {
    case noSessionStarted
    case notCompleted(AVAssetWriter.Status)
    /// `fail(reason:)` latched — e.g. 60 consecutive dropped frames, a failed retime, or an
    /// append() failure — while `AVAssetWriter.status` was still `.writing`. The status alone
    /// would have let `finalize()` sail through to `.completed` with a recording we already know
    /// is truncated; this case is what stops that regardless of what the writer's own status says.
    case latchedFailure(reason: String)

    var errorDescription: String? {
      switch self {
      case .noSessionStarted:
        return "No video frames or audio were ever appended to walk.mp4"
      case .notCompleted(let status):
        return "AVAssetWriter finished in state \(status.rawValue), not .completed"
      case .latchedFailure(let reason):
        return "Recording was already known to have failed before finishing: \(reason)"
      }
    }
  }

  init(writer: AVAssetWriter,
       videoInput: AVAssetWriterInput,
       audioInput: AVAssetWriterInput,
       audioFormat: AVAudioFormat,
       videoUrl: URL,
       onFailure: @escaping (String) -> Void) {
    self.writer = writer
    self.videoInput = videoInput
    self.audioInput = audioInput
    self.audioFormat = audioFormat
    self.videoUrl = videoUrl
    self.onFailure = onFailure
  }

  /// Runs on the SDK's own delivery thread. `VideoFrame.sampleBuffer` is documented as valid
  /// only for the duration of this callback ("Callers must treat this buffer as read-only. The
  /// buffer is only valid for the duration of the listener callback"), so the retimed copy is
  /// made synchronously, right here, via `mediaQueue.sync` rather than `.async` — deferring it
  /// would read the buffer after Meta's own SDK says it may no longer be valid. This blocks the
  /// delivery thread for the duration of one append; `mediaQueue` never blocks on anything else,
  /// so that duration is just the append itself.
  func appendVideoFrame(_ frame: VideoFrame) {
    let sampleBuffer = frame.sampleBuffer
    mediaQueue.sync {
      self.videoFramesReceived += 1
      self.lastFrameArrivedAt = CMClockGetTime(self.mediaClock)
      // Read the clock HERE, on the serial queue, not on the delivery thread. Stamping before
      // `mediaQueue.sync` meant two delivery threads could stamp in one order and arrive in the
      // other, handing the writer timestamps that went backwards. That stalls the H.264 encoder
      // permanently — which is exactly what produced a 3.4s video track alongside 46.8s of audio.
      let pts = self.nextPts(after: self.lastVideoPts)
      self.lastVideoPts = pts
      guard let retimed = Self.retimed(sampleBuffer, to: pts) else {
        self.fail(reason: "could not retime a video frame")
        return
      }
      self.append(retimed, to: self.videoInput, track: "video")
    }
  }

  /// A timestamp guaranteed to be strictly greater than `previous`. Normally that is just the
  /// current clock reading; the nudge only matters when two samples land inside the same clock
  /// tick, where returning an equal timestamp would violate the writer's ordering requirement.
  private func nextPts(after previous: CMTime) -> CMTime {
    let now = CMClockGetTime(mediaClock)
    guard previous.isValid, CMTimeCompare(now, previous) <= 0 else { return now }
    return CMTimeAdd(previous, CMTime(value: 1, timescale: previous.timescale))
  }

  /// Runs on the tap's real-time CoreAudio thread. The PCM bytes are copied out of `buffer`
  /// right here, into a fresh `CMSampleBuffer` — `CMSampleBufferSetDataBufferFromAudioBufferList`
  /// copies, it does not alias — so the handoff to `mediaQueue` carries data that no longer
  /// depends on `AVAudioPCMBuffer`'s own lifetime, unlike the video path above which must stay
  /// synchronous because there is no such copy step available before the SDK's own callback ends.
  func appendAudioBuffer(_ buffer: AVAudioPCMBuffer) {
    let receivedAt = CMClockGetTime(mediaClock)
    // Declined, not converted, when the tap's format no longer matches the input's. `WalkAudioCapture`
    // reinstalls its tap against the input node's CURRENT format after a restart — it has to, the
    // tap raises otherwise — and that format can differ from the one this writer was built around
    // (a 44.1 kHz route after a 48 kHz start). What AVAssetWriterInput does with a mid-stream format
    // change is not documented well enough to bet twenty minutes of video on; narration.m4a has this
    // audio either way. Counted as received AND refused, so the shortfall it leaves in the muxed
    // track is attributed here rather than read as the microphone going quiet.
    guard buffer.format.sampleRate == audioFormat.sampleRate,
          buffer.format.channelCount == audioFormat.channelCount else {
      mediaQueue.async {
        self.audioBuffersReceived += 1
        self.audioBuffersRefusedForFormat += 1
      }
      return
    }
    guard let sampleBuffer = Self.makeAudioSampleBuffer(from: buffer, presentationTime: receivedAt) else {
      // Counted as received even though it never became a sample buffer: the tap DID deliver
      // narration here, and a census that only counted the ones we managed to wrap would make this
      // failure look like the microphone going quiet.
      mediaQueue.async {
        self.audioBuffersReceived += 1
        self.fail(reason: "could not build an audio sample buffer")
      }
      return
    }
    mediaQueue.async {
      self.audioBuffersReceived += 1
      self.append(sampleBuffer, to: self.audioInput, track: "audio")
    }
  }

  /// The single place a sample — video or audio — actually reaches the writer. Runs only on
  /// `mediaQueue`. Opens the writer's session on whichever sample arrives here first, so both
  /// tracks share one origin instead of each defining its own zero.
  private func append(_ sampleBuffer: CMSampleBuffer, to input: AVAssetWriterInput, track: String) {
    guard !failed else { return }
    switch writer.status {
    case .writing:
      break
    case .failed:
      // Not necessarily triggered by an append() call of ours: AVAssetWriter itself fails a
      // writer that is `.writing` when the app is backgrounded. Surface it either way — this is
      // the one place both paths are guaranteed to pass through.
      fail(reason: "\(track) track: writer entered .failed — "
        + "\(writer.error?.localizedDescription ?? "no error reported")")
      return
    default:
      return  // startWriting() hasn't taken effect (or no longer has); nothing to append to.
    }

    if !sessionStarted {
      writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
      sessionStarted = true
    }

    // Whatever audio the input refused earlier goes first, whichever track this sample is on —
    // the writer becoming ready again is only ever observed from inside an append, and video
    // frames arrive thirty times a second whether or not the microphone does.
    drainPendingAudio()
    guard !failed else { return }

    // Real-time input: `expectsMediaDataInRealTime` makes `isReadyForMoreMediaData` say exactly
    // whether the encoder/writer is keeping up.
    //
    // VIDEO IS DROPPED, and A DROP IS NORMAL. A RUN OF DROPS IS NOT. An encoder that stalls never
    // becomes ready again, so an unbounded silent drop turns a dead video track into a walk that
    // looks successful — which is what happened on 2026-08-01: 3.4s of video, 46.8s of audio, no
    // error anywhere. Roughly two seconds of 30fps footage is long enough to rule out ordinary
    // backpressure. (A frame the writer refuses is a frame nobody misses; a queued one would only
    // arrive late, and there is another along in 33 ms.)
    //
    // AUDIO IS QUEUED, NOT DROPPED — AND NEVER LATCHED. Dropping phone-mic buffers was the same
    // defect one track over — the video track stays healthy, the writer reaches `.completed`, and
    // the walk ships with a narration full of holes — but neither of video's remedies fits. Latching
    // makes `endWalk` reject, JS marks the walk failed, and a failed walk queues no video at all, so
    // it would answer "we lost some of the audio" by throwing away all of the video too. And a
    // dropped buffer is a hole in speech, which is the input the scope is written from. So refused
    // audio waits in `pendingAudio`, in order, and is written the moment the input takes it again;
    // a drop is counted only past the queue's cap. The counters travel out in `census()`, and
    // session.ts turns them into a shortfall the completion screen states outright.
    if track == "audio" {
      // Behind a non-empty queue this buffer must queue too, ready or not: the input requires
      // strictly increasing timestamps per track, and this one is newer than everything waiting.
      guard pendingAudio.isEmpty, input.isReadyForMoreMediaData else {
        enqueueAudio(sampleBuffer)
        return
      }
    } else {
      guard input.isReadyForMoreMediaData else {
        videoFramesDropped += 1
        consecutiveVideoDrops += 1
        if consecutiveVideoDrops == 60 {
          fail(reason: "video track: the writer stopped accepting frames and has not recovered "
            + "after 60 consecutive drops — the recording will have little or no video")
        }
        return
      }
      consecutiveVideoDrops = 0
    }

    write(sampleBuffer, to: input, track: track)
  }

  /// Runs on `mediaQueue`. Hold one refused audio buffer for a later append; past the cap the
  /// oldest is let go and counted, exactly as every refused buffer used to be.
  private func enqueueAudio(_ sampleBuffer: CMSampleBuffer) {
    pendingAudio.append(sampleBuffer)
    guard pendingAudio.count > Self.maxPendingAudio else { return }
    pendingAudio.removeFirst()
    audioBuffersDropped += 1
    consecutiveAudioDrops += 1
    longestAudioDropRun = max(longestAudioDropRun, consecutiveAudioDrops)
  }

  /// Runs on `mediaQueue`. Write queued audio, oldest first, for as long as the input will take it.
  /// Stops at the first refusal or failure and leaves the rest queued for the next append.
  private func drainPendingAudio() {
    while !failed, !pendingAudio.isEmpty, audioInput.isReadyForMoreMediaData {
      let next = pendingAudio.removeFirst()
      guard write(next, to: audioInput, track: "audio") else { return }
    }
  }

  /// The actual append, for a sample the input has just said it is ready for. Runs on `mediaQueue`.
  /// Returns false when the write latched a failure.
  @discardableResult
  private func write(_ sampleBuffer: CMSampleBuffer, to input: AVAssetWriterInput, track: String) -> Bool {
    guard input.append(sampleBuffer) else {
      // append() returning false and being ignored is exactly the AVAudioRecorder.record()
      // mistake this codebase was already cleaned of elsewhere — except here it means the
      // walk's video file is quietly corrupt rather than merely silent.
      fail(reason: "\(track) append() returned false — "
        + "\(writer.error?.localizedDescription ?? "no error reported")")
      return false
    }
    if track == "video" {
      videoFramesAppended += 1
    } else {
      consecutiveAudioDrops = 0
      audioBuffersAppended += 1
      // Measured per buffer rather than assumed, and only for buffers the writer actually took.
      // `CMSampleBufferGetDuration` is the total across the buffer's samples (it was built with one
      // timing entry over `frameLength` samples in `makeAudioSampleBuffer`), so this accumulates
      // real recorded narration. The `isFinite` guard is not decoration: an invalid CMTime converts
      // to NaN, and one NaN would poison the running total for the rest of the walk — turning the
      // whole audio verdict into a number that compares false against every threshold and quietly
      // disables the warning it exists to raise.
      let seconds = CMTimeGetSeconds(CMSampleBufferGetDuration(sampleBuffer))
      if seconds.isFinite, seconds > 0 { audioSecondsAppended += seconds }
    }
    return true
  }

  /// What actually happened, read on `mediaQueue` so the counters are consistent with each other.
  /// `secondsSinceLastFrame` is the VIDEO discriminator: near zero means frames were still arriving
  /// and the writer was refusing them; large means the glasses stopped sending.
  ///
  /// `audioSecondsAppended` is the audio one, and it is an absolute rather than a discriminator.
  /// There is no equivalent question to ask — the phone microphone does not stop sending, so the
  /// only thing worth measuring is how much of what it sent the writer actually took.
  func census() -> [String: Any] {
    mediaQueue.sync {
      let quiet: Double = lastFrameArrivedAt.isValid
        ? CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(mediaClock), lastFrameArrivedAt))
        : -1
      return [
        "videoFramesReceived": videoFramesReceived,
        "videoFramesAppended": videoFramesAppended,
        "videoFramesDropped": videoFramesDropped,
        "audioBuffersReceived": audioBuffersReceived,
        "audioBuffersAppended": audioBuffersAppended,
        "audioBuffersDropped": audioBuffersDropped,
        "audioSecondsAppended": audioSecondsAppended,
        "longestAudioDropRun": longestAudioDropRun,
        "audioBuffersRefusedForFormat": audioBuffersRefusedForFormat,
        "audioBuffersPending": pendingAudio.count,
        "secondsSinceLastFrameArrived": quiet,
        "writerStatus": writer.status.rawValue,
        "writerError": writer.error?.localizedDescription ?? "none",
        "failedLatched": failed,
      ]
    }
  }

  /// Runs on `mediaQueue`. Latches once: a writer that starts failing will fail on every
  /// subsequent sample, and re-reporting the same fact dozens of times a second would drown out
  /// everything else on the error channel. `finalize()` checks `writer.status` independently, so
  /// the walk is reported as failed there too rather than resolved with a truncated file.
  private func fail(reason: String) {
    guard !failed else { return }
    failed = true
    failureReason = reason
    onFailure(reason)
  }

  /// Copies `sampleBuffer` with its presentation timestamp replaced by `pts` — mediaClock time,
  /// not whatever the DAT stream embedded — leaving the image buffer and everything else about
  /// the sample untouched.
  private static func retimed(_ sampleBuffer: CMSampleBuffer, to pts: CMTime) -> CMSampleBuffer? {
    let original = CMSampleBufferGetDuration(sampleBuffer)
    var timing = CMSampleTimingInfo(
      duration: original.isValid ? original : CMTime(value: 1, timescale: 30),
      presentationTimeStamp: pts,
      decodeTimeStamp: .invalid
    )
    var out: CMSampleBuffer?
    let status = CMSampleBufferCreateCopyWithNewTiming(
      allocator: kCFAllocatorDefault,
      sampleBuffer: sampleBuffer,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleBufferOut: &out
    )
    return status == noErr ? out : nil
  }

  /// Builds a `CMSampleBuffer` from a tap buffer, stamped with `presentationTime` (mediaClock
  /// time) rather than the `AVAudioTime` CoreAudio attaches to it — the audio half of the same
  /// single-origin rule `retimed(_:to:)` applies to video.
  private static func makeAudioSampleBuffer(from pcmBuffer: AVAudioPCMBuffer,
                                            presentationTime: CMTime) -> CMSampleBuffer? {
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: CMTimeScale(pcmBuffer.format.sampleRate)),
      presentationTimeStamp: presentationTime,
      decodeTimeStamp: .invalid
    )
    var sampleBuffer: CMSampleBuffer?
    let createStatus = CMSampleBufferCreate(
      allocator: kCFAllocatorDefault,
      dataBuffer: nil,
      dataReady: false,
      makeDataReadyCallback: nil,
      refcon: nil,
      formatDescription: pcmBuffer.format.formatDescription,
      sampleCount: CMItemCount(pcmBuffer.frameLength),
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 0,
      sampleSizeArray: nil,
      sampleBufferOut: &sampleBuffer
    )
    guard createStatus == noErr, let sampleBuffer else { return nil }

    // `audioBufferList` (not `mutableAudioBufferList`): its mDataByteSize reflects the buffer's
    // current frameLength. The mutable variant reflects frameCapacity, which would copy
    // uninitialized trailing bytes into the sample buffer whenever frameLength < frameCapacity.
    let fillStatus = CMSampleBufferSetDataBufferFromAudioBufferList(
      sampleBuffer,
      blockBufferAllocator: kCFAllocatorDefault,
      blockBufferMemoryAllocator: kCFAllocatorDefault,
      flags: 0,
      bufferList: pcmBuffer.audioBufferList
    )
    return fillStatus == noErr ? sampleBuffer : nil
  }

  /// Stops new samples from being handed to `mediaQueue`, then finalizes the writer ON
  /// `mediaQueue` — the same queue every append already runs on, so by FIFO ordering this is
  /// guaranteed to run after every sample that was ever going to be appended. The caller
  /// (`WalkthroughRecorder.endWalk`) is responsible for dropping the frame listener and removing
  /// the audio tap BEFORE calling this, so nothing new can be enqueued after it starts. Returns
  /// the finished `walk.mp4` URL, or an error if the writer never produced a usable file.
  func finalize() async -> Result<URL, Error> {
    await withCheckedContinuation { (continuation: CheckedContinuation<Result<URL, Error>, Never>) in
      mediaQueue.async {
        guard self.sessionStarted else {
          // Nothing was ever appended — an extremely short walk, or one where neither source
          // ever delivered anything. There is no valid session to finish.
          self.writer.cancelWriting()
          continuation.resume(returning: .failure(WalkVideoError.noSessionStarted))
          return
        }
        guard self.writer.status == .writing else {
          // Failed (possibly via backgrounding, possibly via a prior append() failure already
          // reported through `fail(reason:)`) or already cancelled/completed some other way.
          self.writer.cancelWriting()
          continuation.resume(returning: .failure(WalkVideoError.notCompleted(self.writer.status)))
          return
        }
        guard !self.failed else {
          // `fail(reason:)` only sets this latch and emits the JS event — it never touches
          // `writer.status`, so the check above is not enough on its own. 60 consecutive dropped
          // video frames (or a retiming/append failure) can leave the writer sitting at
          // `.writing` even though the recording is already known to be truncated: without this
          // guard, `finishWriting` would complete "successfully" and hand back a videoUri for a
          // walk we already know is bad, which the upload queue would then ship as if it were
          // fine. Carry the latched reason through so the rejection actually says why, the same
          // way `.notCompleted` above carries the writer's status.
          self.writer.cancelWriting()
          continuation.resume(
            returning: .failure(WalkVideoError.latchedFailure(reason: self.failureReason ?? "unknown")))
          return
        }
        // One last chance for audio the input refused during the final seconds. Whatever it still
        // will not take is lost with the file closing, and counted so the census says so rather
        // than reporting a queue that quietly emptied itself.
        self.drainPendingAudio()
        if !self.pendingAudio.isEmpty {
          self.audioBuffersDropped += self.pendingAudio.count
          // ADDED to the run already in progress, not compared against it. A queue that overflowed
          // and never recovered has already evicted buffers into `consecutiveAudioDrops`, and those
          // evictions and these leftovers are one uninterrupted loss — nothing was appended between
          // them, which is what would have reset the counter. Taking the larger of the two instead
          // understates a sustained stall by up to the queue's whole capacity and files it as a
          // shorter one, which is the exact distinction `longestAudioDropRun` exists to draw.
          self.consecutiveAudioDrops += self.pendingAudio.count
          self.longestAudioDropRun = max(self.longestAudioDropRun, self.consecutiveAudioDrops)
          self.pendingAudio.removeAll()
        }
        self.videoInput.markAsFinished()
        self.audioInput.markAsFinished()
        self.writer.finishWriting {
          if self.writer.status == .completed {
            continuation.resume(returning: .success(self.videoUrl))
          } else {
            continuation.resume(
              returning: .failure(self.writer.error ?? WalkVideoError.notCompleted(self.writer.status)))
          }
        }
      }
    }
  }

  /// Cancels rather than finishes. Used on `startWalk` failure paths, where `finalize()` never
  /// ran, and unconditionally again at the end of every `teardown()` including the normal
  /// `endWalk` path — safe there because `cancelWriting()` on an already `.completed` writer is
  /// a documented no-op.
  func cancel() {
    mediaQueue.async {
      self.pendingAudio.removeAll()
      guard self.writer.status == .writing else { return }
      self.videoInput.markAsFinished()
      self.audioInput.markAsFinished()
      self.writer.cancelWriting()
    }
  }
}

/// Owns the phone-microphone half of a walk: the `AVAudioEngine` whose input tap feeds
/// `WalkVideoWriter`, the standalone `narration.m4a` recorder that survives whatever happens to that
/// engine, the notification observers that restart the engine when iOS stops it, and the watchdog
/// that notices when nothing has arrived for a while.
///
/// WHY THIS EXISTS. Two production walks on 2026-09-02 (City View at Mueller, 12:10 and 12:25)
/// recorded 274s and 266s of video against audio tracks that end cleanly at 47.8s and 238s — no
/// holes, no writer refusals, just nothing from one moment on. Each stop came seconds after a
/// disturbance on the glasses' video transport, i.e. a Bluetooth event. `AVAudioEngine` STOPS on an
/// audio-session interruption, on a configuration change, and on a media-services reset, and
/// nothing here restarted it: `engine.start()` ran exactly once, in `startWalk`, and the tap simply
/// never fired again. The only thing that noticed was `assessAudioCoverage`, at the end of the
/// walk, which titled it "(audio cut short)". 3.8 minutes of narration were lost between the two —
/// and narration is the input the scope is written from.
///
/// Three defences, in the order of how much each one saves:
///
///   1. The standalone recorder. `AVAudioRecorder` is its own client of the audio session with its
///      own file: a stopped engine costs it nothing, iOS itself carries it across the route changes
///      that stop the engine, and an interruption only pauses it. It is the same shape
///      `WearablesBridge.measureStreamWithPhoneAudio` already records with. Uploaded BESIDE walk.mp4
///      as an audio clip, so the office has the narration whatever the muxed track holds.
///   2. The restart observers, so the MUXED track — the one that plays in sync with the picture —
///      comes back too, instead of staying dead for the remaining twenty minutes.
///   3. The watchdog, for the stops no notification announces. Two seconds without a buffer is
///      ~95 missed deliveries at the tap's cadence; nothing healthy is that quiet.
///
/// Every piece of mutable state below `startedAt` is touched only on `audioQueue`. The tap block
/// (CoreAudio's real-time thread) and the notification blocks (whichever thread posts them) hop
/// onto it carrying nothing but scalars. `@unchecked Sendable` documents that discipline, exactly as
/// `WalkVideoWriter` does for `mediaQueue`.
private final class WalkAudioCapture: @unchecked Sendable {
  /// Its own queue rather than the writer's `mediaQueue`: `AVAudioEngine.start()` takes tens of
  /// milliseconds and sometimes far more, and video frames must not queue behind it.
  private let audioQueue = DispatchQueue(label: "com.trockcam.walkthrough.audio")
  let narrationUrl: URL
  private let onEvent: (String, [String: Any]) -> Void

  /// How long the tap may stay silent before the watchdog acts. ~95 missed buffers at 1024 frames
  /// / 48 kHz — nothing healthy is that quiet — and long enough not to restart an engine over an
  /// interruption iOS is about to end on its own. Also the minimum gap BETWEEN restart attempts:
  /// an engine that started but delivers nothing for two seconds is not going to.
  static let stallThreshold: TimeInterval = 2.0
  /// Consecutive watchdog restarts before it stops trying and says so. Mirrored in session.ts as
  /// `WALK_AUDIO_RESTART_ATTEMPTS`, which is what turns the third failure into "end this walk".
  /// Not a cap on the NOTIFICATION-driven restarts: an interruption ending after the watchdog gave
  /// up still restarts the engine, and a buffer arriving resets the count — that is the escape.
  static let maxWatchdogRestarts = 3
  /// How often the level meter reports. Four times a second reads as live and costs nothing on
  /// the bridge.
  static let levelInterval: TimeInterval = 0.25
  /// The census keeps every event of an ordinary walk (a handful) and stays bounded on a route that
  /// flaps for twenty minutes.
  static let maxEvents = 200

  /// What `stop()` hands back — what `endWalk` folds into the census and resolves beside the video.
  struct Report {
    /// narration.m4a, or nil when there is nothing worth uploading. See `narrationFileUrl`.
    let audioUri: URL?
    let narrationSeconds: Double
    let engineRestarts: Int
    let events: [[String: Any]]
  }

  /// The monotonic reading everything below is measured against — `systemUptime`, which cannot be
  /// set, stepped or corrected. It does not advance while the device sleeps, which a foregrounded
  /// walk holding a keep-awake lock does not do.
  private static func monotonicNow() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

  /// A MONOTONIC origin, in `systemUptime` seconds — not a wall clock. Every elapsed measurement in
  /// this class is taken against it: the census's `atMs`, the watchdog's silence, the spacing
  /// between restarts, the meter's cadence.
  ///
  /// `Date()` is settable and NTP-corrected, and a step backwards mid-walk is not a rounding
  /// nuisance here. It produces a NEGATIVE `atMs`, which the completion contract refuses outright —
  /// and by then the walk's bytes are already in object storage, so the completion retries a fixed
  /// number of times and goes terminal, taking the video and every still with it. The quieter half
  /// is the watchdog: a jumped clock either stops it noticing silence or has it restart an engine
  /// that was fine. `WalkVideoWriter` already stamps every sample against the host clock for the
  /// same reason, one layer over.
  private let startedAt = ProcessInfo.processInfo.systemUptime

  // Owned by audioQueue from here on.
  /// A `var` because a media-services reset invalidates every audio object, the engine included,
  /// and Apple's instruction for that case is to build a new one.
  private var engine = AVAudioEngine()
  private var recorder: AVAudioRecorder?
  private var narrationStarted = false
  private var narrationSeconds: Double = 0
  private var onBuffer: (@Sendable (AVAudioPCMBuffer) -> Void)?
  private var observers: [NSObjectProtocol] = []
  private var watchdog: DispatchSourceTimer?
  private var running = false
  private var report: Report?
  /// When the engine actually started, monotonic. The watchdog measures silence from HERE, not from
  /// `startedAt`: this object is built a few AVAssetWriter calls BEFORE `start(format:onBuffer:)` (the
  /// writer's audio input is built from the format this object reports), and a slow setup would
  /// otherwise read as a stall on the very first tick and restart an engine that had just started —
  /// a tap reinstall, a census entry and a red banner, all for nothing. `startedAt` stays the
  /// census's origin, which is the walk's, not the engine's.
  private var runningSince: TimeInterval?
  private var lastBufferAt: TimeInterval?
  private var lastRestartAt: TimeInterval?
  private var stalled = false
  private var watchdogRestarts = 0
  private var exhaustionReported = false
  private var engineRestarts = 0
  private var events: [[String: Any]] = []
  private var peakRms: Float = 0
  private var lastLevelAt: TimeInterval?

  init(narrationUrl: URL, onEvent: @escaping (String, [String: Any]) -> Void) {
    self.narrationUrl = narrationUrl
    self.onEvent = onEvent
  }

  /// A safety net, not a path. Every exit from `startWalk`/`endWalk` reaches `teardown()`, which
  /// calls `stop()` before dropping the reference — but the cost of being wrong about that is not a
  /// leak. `DispatchSource` traps on the RELEASE of a resumed timer ("BUG IN CLIENT OF LIBDISPATCH"),
  /// so an instance that ever reached `start()` and was then dropped without `stop()` would take the
  /// app down mid-walk; and block-based notification observers are retained by the center until
  /// their token is removed, so they would outlive the object that stopped caring.
  ///
  /// No `audioQueue` hop: `deinit` runs when the last reference is gone, so there is nothing left to
  /// race with, and hopping onto a queue from here would resurrect `self` inside its own closure.
  deinit {
    watchdog?.cancel()
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
  }

  /// The input node's format as it stands right now. `startWalk` builds the writer's audio input
  /// from this, and then hands it back to `start(format:onBuffer:)` for the tap.
  func inputFormat() -> AVAudioFormat {
    audioQueue.sync { engine.inputNode.outputFormat(forBus: 0) }
  }

  /// Start the standalone recorder. Never throws and never fails the walk: a walk without this
  /// file still has its muxed track, and a walk refused over it would upload nothing at all — a
  /// failed walk queues no video (upload-core.ts's `toQueuedWalk`). What went wrong rides out in
  /// the census instead, and `endWalk` resolves `audioUri: null`.
  ///
  /// AAC at 48 kHz mono — the format `WearablesBridge.measureStreamWithPhoneAudio` measured with;
  /// `.m4a` is what the upload queue already sends as `audio/mp4`.
  func startNarration() {
    audioQueue.sync {
      do {
        let recorder = try AVAudioRecorder(url: narrationUrl, settings: [
          AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
          AVSampleRateKey: 48_000.0,
          AVNumberOfChannelsKey: 1,
        ])
        // record() returning false and being ignored is the exact mistake this codebase was
        // cleaned of elsewhere — here it is recorded rather than thrown, for the reason above.
        guard recorder.record() else {
          note("narrationStartRefused")
          return
        }
        self.recorder = recorder
        narrationStarted = true
      } catch {
        note("narrationStartFailed")
      }
    }
  }

  /// Install the tap and start the engine, then arm the observers and the watchdog. Throws only
  /// what `AVAudioEngine.start()` throws — the one microphone failure `startWalk` still refuses a
  /// walk over, exactly as it did before this class existed.
  func start(format: AVAudioFormat, onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void) throws {
    try audioQueue.sync {
      self.onBuffer = onBuffer
      installTap(format: format)
      engine.prepare()
      do {
        try engine.start()
      } catch {
        // The tap was installed above; remove it before the error propagates, or it outlives the
        // engine `stop()` is about to be handed.
        engine.inputNode.removeTap(onBus: 0)
        throw error
      }
      running = true
      runningSince = Self.monotonicNow()
      installObservers()
      startWatchdog()
    }
  }

  /// Tear the microphone side down in the order that loses nothing: observers and watchdog first,
  /// so nothing restarts what is being stopped; then the tap and the engine; then the recorder,
  /// whose `stop()` is what writes the m4a's index. Idempotent — `teardown()` calls this again after
  /// `endWalk` already has, and the second call returns the same report without touching anything.
  @discardableResult
  func stop() -> Report {
    audioQueue.sync { () -> Report in
      if let report { return report }
      running = false
      watchdog?.cancel()
      watchdog = nil
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers.removeAll()
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      if let recorder {
        // Read BEFORE stop(): `currentTime` is zero once the recorder has stopped. It reads zero
        // while the recorder is merely PAUSED, too — which is where an interruption that is still
        // in progress when the walk ends leaves it — so this takes the high-water mark rather than
        // the instantaneous value. See `sampleNarrationSeconds`.
        sampleNarrationSeconds()
        recorder.stop()
      }
      recorder = nil
      let audioUri = narrationFileUrl()
      let built = Report(
        audioUri: audioUri,
        narrationSeconds: narrationSeconds,
        engineRestarts: engineRestarts,
        events: events
      )
      report = built
      return built
    }
  }

  // MARK: - The tap

  /// Runs on `audioQueue`. The block runs on CoreAudio's real-time thread: the buffer goes to the
  /// writer synchronously — `WalkVideoWriter.appendAudioBuffer` copies it out right there, as it
  /// always did — and only one number hops back onto this queue, for the meter and the watchdog.
  private func installTap(format: AVAudioFormat?) {
    guard let sink = onBuffer else { return }
    engine.inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, _ in
      sink(buffer)
      let rms = Self.rms(of: buffer)
      self?.audioQueue.async { self?.bufferArrived(rms: rms) }
    }
  }

  /// Runs on `audioQueue`, once per delivered buffer.
  private func bufferArrived(rms: Float) {
    guard running else { return }
    let now = Self.monotonicNow()
    lastBufferAt = now
    if stalled {
      // Whatever brought the buffers back — a watchdog restart, an interruption ending, iOS on its
      // own — the stall is over, and the watchdog's budget starts again from zero.
      stalled = false
      watchdogRestarts = 0
      exhaustionReported = false
      note("audioResumed")
    }
    peakRms = max(peakRms, rms)
    if let last = lastLevelAt, now - last < Self.levelInterval { return }
    lastLevelAt = now
    // The PEAK since the last report, not the latest buffer: a syllable that lands between two
    // reports would otherwise never move the meter.
    onEvent("walkthrough:audioLevel", ["rms": Double(min(1, max(0, peakRms)))])
    peakRms = 0
  }

  /// Root-mean-square of the buffer's first channel, in its own [-1, 1] float units. The tap's
  /// format on the phone is Float32 (`floatChannelData` non-nil); any other layout reports 0 rather
  /// than being converted — this is a meter, not a measurement.
  private static func rms(of buffer: AVAudioPCMBuffer) -> Float {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
    let samples = channels[0]
    var sum: Float = 0
    for index in 0..<Int(buffer.frameLength) {
      let sample = samples[index]
      sum += sample * sample
    }
    return (sum / Float(buffer.frameLength)).squareRoot()
  }

  // MARK: - Restart

  /// Bring the engine back. Runs on `audioQueue`. Returns whether `start()` succeeded — which is
  /// not yet "buffers are flowing": only the tap can say that, and JS's `audioAlive` waits for it.
  ///
  /// `rebuild` is for the media-services reset, after which the old engine is not an engine any
  /// more. Everywhere else the same instance is restarted, which is what Apple documents for an
  /// interruption or a configuration change.
  private func restartEngine(reason: String, rebuild: Bool) -> Bool {
    guard running else { return false }
    lastRestartAt = Self.monotonicNow()
    let audio = AVAudioSession.sharedInstance()
    do {
      // The same category and options `startWalk` chose — no `.allowBluetoothHFP`, for the reason
      // the file header measures out. An interruption can leave the session deactivated and a route
      // change can leave it active on a configuration the engine no longer matches; re-applying
      // both costs nothing when nothing changed.
      try audio.setCategory(.playAndRecord, mode: .default, options: [])
      try audio.setActive(true)
    } catch {
      // Another app still holds the session (a call that has not ended yet). The watchdog, or the
      // interruption ending, will be back.
      note("restartSessionFailed:\(reason)")
      return false
    }
    if rebuild {
      engine = AVAudioEngine()
    }
    let inputNode = engine.inputNode
    inputNode.removeTap(onBus: 0)
    let format = inputNode.outputFormat(forBus: 0)
    // A 0 Hz format is what the input node reports when there is no input to describe — the session
    // lost the microphone. Installing a tap against it raises an Objective-C exception, which is a
    // crash mid-walk rather than an error, so it is refused here.
    guard format.sampleRate > 0, format.channelCount > 0 else {
      note("restartNoInput:\(reason)")
      return false
    }
    // `format: nil` — the node's CURRENT output format — rather than the format the walk started
    // with. The tap's format must match the node's or `installTap` raises, and the very reason the
    // engine stopped may be that the format changed. `WalkVideoWriter.appendAudioBuffer` checks each
    // buffer against the format the writer was built for and declines the ones that no longer
    // match; narration.m4a carries those regardless.
    installTap(format: nil)
    engine.prepare()
    do {
      try engine.start()
    } catch {
      note("restartFailed:\(reason)")
      return false
    }
    engineRestarts += 1
    note("engineRestarted:\(reason)")
    return true
  }

  /// How long narration.m4a runs, kept as a HIGH-WATER MARK sampled while the recorder is actually
  /// recording. Runs on `audioQueue`.
  ///
  /// `AVAudioRecorder.currentTime` is documented to read zero whenever the recorder is not
  /// recording, and "not recording" includes paused — which is exactly where an interruption still
  /// in progress at `endWalk`, or a media-services reset, leaves it. Read only at `stop()`, those
  /// walks reported zero seconds of narration, and `narrationFileUrl()` reads zero seconds as
  /// "recorded nothing" and DISCARDS the file: the walk that most needed the standalone recording
  /// would have been the one to throw it away. Sampled once a second by the watchdog instead, so
  /// the number survives the recorder going quiet whatever stopped it.
  private func sampleNarrationSeconds() {
    guard let recorder, recorder.isRecording else { return }
    narrationSeconds = max(narrationSeconds, recorder.currentTime)
  }

  /// `AVAudioRecorder` pauses across an interruption and needs `record()` again to continue —
  /// into the same file, appending. A recorder that refuses is noted, never replaced: a new one at
  /// the same URL would truncate everything recorded so far.
  private func resumeNarration(reason: String) {
    guard narrationStarted, let recorder else { return }
    if recorder.isRecording { return }
    note(recorder.record() ? "narrationResumed:\(reason)" : "narrationResumeRefused:\(reason)")
  }

  // MARK: - What iOS announces

  /// Each block reads what it needs out of the notification on the posting thread and carries only
  /// scalars onto `audioQueue` — a `Notification` must not cross into a `@Sendable` closure.
  private func installObservers() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
    ) { [weak self] notification in
      let type = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 0
      let options = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
      self?.audioQueue.async { self?.interruption(typeRaw: type, optionsRaw: options) }
    })
    observers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
    ) { [weak self] notification in
      let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
      self?.audioQueue.async { self?.routeChanged(reasonRaw: reason) }
    })
    observers.append(center.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil
    ) { [weak self] _ in
      self?.audioQueue.async { self?.configurationChanged() }
    })
    observers.append(center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil
    ) { [weak self] _ in
      self?.audioQueue.async { self?.mediaServicesReset() }
    })
  }

  private func interruption(typeRaw: UInt, optionsRaw: UInt) {
    guard running, let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
    switch type {
    case .began:
      // iOS has already stopped the engine and paused the recorder. Restarting now would fail
      // (the session belongs to whoever interrupted), so this is only recorded; the watchdog covers
      // a `.began` that is never followed by an `.ended`.
      note("interruptionBegan")
    case .ended:
      let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
      note(options.contains(.shouldResume) ? "interruptionEnded:shouldResume" : "interruptionEnded")
      // Restarted whether or not iOS says to resume: this is the walk's own recording, not
      // background playback, and a buffer arriving is what tells JS the microphone is back.
      _ = restartEngine(reason: "interruption", rebuild: false)
      resumeNarration(reason: "interruption")
    @unknown default:
      note("interruption:\(typeRaw)")
    }
  }

  private func routeChanged(reasonRaw: UInt) {
    guard running else { return }
    let input = AVAudioSession.sharedInstance().currentRoute.inputs.first
    // The reason and the port the route landed on, because the one this file cannot survive — the
    // route switching to the glasses over HFP mid-walk — would show up here as the video dying a
    // few seconds later, and the census is the only place the two facts sit next to each other.
    note("routeChange:\(reasonRaw):\(input?.portType.rawValue ?? "none")")
    // Only an engine the change actually stopped. Restarting a running one would cut the buffers it
    // is delivering for nothing.
    if !engine.isRunning {
      _ = restartEngine(reason: "routeChange", rebuild: false)
    }
    resumeNarration(reason: "routeChange")
  }

  private func configurationChanged() {
    guard running else { return }
    // A restart can itself post one of these a moment later, for the configuration it just applied.
    // Acting on that would restart an engine that is running fine, and the tap with it.
    if let last = lastRestartAt, Self.monotonicNow() - last < 0.5 {
      note("configurationChange:coalesced")
      return
    }
    note("configurationChange")
    _ = restartEngine(reason: "configurationChange", rebuild: false)
  }

  private func mediaServicesReset() {
    guard running else { return }
    note("mediaServicesReset")
    // Every audio object is invalid after a reset, the engine included — Apple's instruction is to
    // dispose and recreate. The engine is rebuilt below.
    //
    // THE RECORDER IS CLOSED RATHER THAN RESUMED, and it cannot be replaced. A new AVAudioRecorder
    // at the same URL truncates narration.m4a to nothing, and a second file has nowhere to go: a
    // walk files exactly one audio artifact (upload-core.ts's `toQueuedWalk`). Calling `record()` on
    // the recorder the reset invalidated is not the third option it looks like — it is an object
    // the media server no longer knows, which may answer yes and write nothing, and whose `stop()`
    // may never write the m4a's index, leaving an unplayable file where the narration was. So what
    // was recorded up to the reset is closed HERE, while closing it still means something, and the
    // narration from the reset on rides the muxed track the rebuilt engine feeds. The census says
    // which walk this was.
    if let recorder {
      sampleNarrationSeconds()
      recorder.stop()
      self.recorder = nil
      note("narrationClosedAtReset")
    }
    _ = restartEngine(reason: "mediaServicesReset", rebuild: true)
  }

  // MARK: - Watchdog

  private func startWatchdog() {
    let timer = DispatchSource.makeTimerSource(queue: audioQueue)
    timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
    timer.setEventHandler { [weak self] in self?.watchdogTick() }
    timer.resume()
    watchdog = timer
  }

  /// Runs on `audioQueue`, once a second while the walk records. Silence past `stallThreshold` is
  /// a stall; each tick of a stall makes at most one restart, at least `stallThreshold` apart, and
  /// after `maxWatchdogRestarts` it reports once that it has given up — the notification-driven
  /// restarts are still armed, and a buffer arriving from any of them resets all of this.
  private func watchdogTick() {
    guard running else { return }
    // Once a second, whether or not anything is wrong — this is the only place narration.m4a's
    // length is observed while it can still be read. See `sampleNarrationSeconds`.
    sampleNarrationSeconds()
    let now = Self.monotonicNow()
    let since = now - (lastBufferAt ?? runningSince ?? startedAt)
    guard since > Self.stallThreshold else { return }
    stalled = true
    let sinceMs = Int(since * 1000)
    if watchdogRestarts < Self.maxWatchdogRestarts {
      if let last = lastRestartAt, now - last < Self.stallThreshold { return }
      watchdogRestarts += 1
      let restarted = restartEngine(reason: "watchdog", rebuild: false)
      onEvent("walkthrough:audioStalled", [
        "attempt": watchdogRestarts, "restarted": restarted, "sinceMs": sinceMs,
      ])
    } else if !exhaustionReported {
      exhaustionReported = true
      note("watchdogGaveUp")
      onEvent("walkthrough:audioStalled", [
        "attempt": watchdogRestarts, "restarted": false, "sinceMs": sinceMs,
      ])
    }
  }

  // MARK: - Census

  /// One census event, `{ atMs, kind }` with `atMs` measured from the capture starting. Bounded —
  /// see `maxEvents`; the last slot says the list was cut rather than silently dropping the rest.
  private func note(_ kind: String) {
    guard events.count < Self.maxEvents else { return }
    let atMs = Int((Self.monotonicNow() - startedAt) * 1000)
    let last = events.count == Self.maxEvents - 1
    events.append(["atMs": atMs, "kind": last ? "eventsTruncated" : kind])
  }

  /// The narration file, or nil when there is nothing worth uploading: the recorder never started,
  /// recorded nothing, or left no bytes on disk. Checked on disk rather than trusted — a URL to an
  /// empty file would queue an artifact whose PUT fails five times and takes the walk's stills down
  /// with it (upload-core.ts's `isWalkTerminal`). Runs on `audioQueue`, once, from `stop()`.
  private func narrationFileUrl() -> URL? {
    guard narrationStarted else { return nil }
    guard narrationSeconds > 0 else {
      note("narrationEmpty")
      return nil
    }
    let bytes = (try? FileManager.default.attributesOfItem(atPath: narrationUrl.path))?[.size] as? Int
    guard let bytes, bytes > 0 else {
      note("narrationNoBytes")
      return nil
    }
    return narrationUrl
  }
}

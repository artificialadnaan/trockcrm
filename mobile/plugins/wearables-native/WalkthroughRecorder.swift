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
  private var audioEngine: AVAudioEngine?
  private var videoWriter: WalkVideoWriter?
  private var hasListeners = false
  private var walkDirectory: URL?
  private var stillIndex = 0

  /// `.high` per Meta: 720x1280 at 30fps. Read once from here for both the `addStream()` config
  /// below and the video track's `outputSettings`, so the two can never drift apart.
  private static let streamResolution: StreamingResolution = .high

  override static func requiresMainQueueSetup() -> Bool { true }
  override func supportedEvents() -> [String] { ["walkthrough:still", "walkthrough:error"] }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  private static func describe(_ error: Error) -> String {
    if let dat = error as? DatError { return dat.description }
    return error.localizedDescription
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

  // MARK: - Start

  @objc(startWalk:resolver:rejecter:)
  func startWalk(_ walkId: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      let audio = AVAudioSession.sharedInstance()
      do {
        let dir = try Self.makeWalkDirectory(walkId)
        walkDirectory = dir
        stillIndex = 0

        let sdk = Wearables.shared
        let selector = AutoDeviceSelector(wearables: sdk)
        var deadline = Date().addingTimeInterval(8)
        while selector.activeDevice == nil, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard selector.activeDevice != nil else {
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
          await teardown()
          reject("walk_session_not_started", "Session stalled in \(stalled)", nil)
          return
        }

        // Meta step: stream created, NOT started.
        guard let newStream = try created.addStream(
          config: StreamConfiguration(videoCodec: .raw, resolution: Self.streamResolution, frameRate: 30)
        ) else {
          await teardown()
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
          await teardown()
          reject(
            "walk_route_is_glasses",
            "Audio would record from the glasses over Bluetooth HFP, which stops the video stream "
              + "after a few seconds. Disconnect the glasses as an audio device (they stay "
              + "connected for video) and start again.",
            nil
          )
          return
        }

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
          await teardown()
          reject("walk_writer_video_input_refused", "AVAssetWriter refused the video input", nil)
          return
        }
        writer.add(vInput)

        // AVAudioEngine's input node is configured only now, against the route that just
        // settled above. Building it any earlier would ask the engine to describe a route that
        // has not switched over yet — the same "asked too early" mistake Meta's ordering
        // constraint exists to prevent, one layer further down.
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
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
          await teardown()
          reject("walk_writer_audio_input_refused", "AVAssetWriter refused the audio input", nil)
          return
        }
        writer.add(aInput)

        // Both inputs are attached; nothing may be added after this.
        guard writer.startWriting() else {
          await teardown()
          reject("walk_writer_start_failed",
                 "AVAssetWriter.startWriting() failed: \(writer.error?.localizedDescription ?? "unknown")",
                 writer.error)
          return
        }

        let vw = WalkVideoWriter(writer: writer, videoInput: vInput, audioInput: aInput, videoUrl: videoUrl) {
          [weak self] reason in
          self?.reportWriterFailure(reason)
        }
        videoWriter = vw

        // Subscribing here, right before start(), is still well before anything can fire: no
        // frames exist until newStream.start() below, and no audio buffers exist until
        // engine.start() succeeds just after this.
        frameToken = newStream.videoFramePublisher.listen { [weak vw] (frame: VideoFrame) in
          vw?.appendVideoFrame(frame)
        }
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: recordingFormat) { [weak vw] buffer, _ in
          vw?.appendAudioBuffer(buffer)
        }
        engine.prepare()
        do {
          try engine.start()
        } catch {
          // The tap was installed above; remove it before tearing down, or it outlives the
          // engine reference this failure path never got to store.
          inputNode.removeTap(onBus: 0)
          await teardown()
          reject("walk_audio_engine_failed", "AVAudioEngine.start() failed: \(Self.describe(error))", error)
          return
        }
        audioEngine = engine

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
        await teardown()
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
    resolve(["requested": stream.capturePhoto(format: .jpeg)])
  }

  private func deliverStill(_ photo: PhotoData) {
    guard let dir = walkDirectory else { return }
    stillIndex += 1
    let url = dir.appendingPathComponent(String(format: "still-%03d.jpg", stillIndex))
    do {
      try photo.data.write(to: url)
    } catch {
      if hasListeners {
        sendEvent(withName: "walkthrough:error",
                  body: ["message": "Could not save still: \(Self.describe(error))"])
      }
      return
    }
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

  // MARK: - End

  @objc(endWalk:rejecter:)
  func endWalk(_ resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      let stills = stillIndex
      // Stop production before finalizing: no more frames or audio buffers should reach
      // `videoWriter` once finalize() starts, or markAsFinished()/finishWriting() could race a
      // still-arriving append.
      frameToken = nil
      if let engine = audioEngine {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
      }
      audioEngine = nil

      // Taken BEFORE finalize(), while the writer still holds its live state — afterwards
      // `writer.status` reports the outcome of finishWriting rather than what happened during
      // the walk, which is the part in question.
      let census = videoWriter?.census() ?? [:]

      let result = await videoWriter?.finalize()
      await teardown()

      switch result {
      case .success(let url):
        resolve(["videoUri": url.absoluteString, "stills": stills, "census": census])
      case .failure(let error):
        // A truncated walk.mp4 that the upload queue then ships is worse than a failure here —
        // it looks like success. Reject rather than resolve with a URI nobody finalized.
        // The census rides along in the message: a walk that failed to finalize is exactly when
        // knowing how many frames arrived versus were refused matters most.
        reject("walk_video_finalize_failed",
               "endWalk failed to finalize walk.mp4: \(Self.describe(error)) — census: \(census)",
               error)
      case nil:
        reject("walk_video_finalize_failed",
               "endWalk failed to finalize walk.mp4: no writer was ever created", nil)
      }
    }
  }

  /// Stop everything and release the audio session. This no longer requests HFP, so the glasses
  /// are not pinned into hands-free mode — but an active session still holds the microphone away
  /// from every other app, and releasing it
  /// stays 8 kHz mono.
  ///
  /// Always cancels the video writer rather than finishing it. `endWalk` finalizes the writer
  /// itself, via `WalkVideoWriter.finalize()`, before calling this — by the time this runs, the
  /// writer is already `.completed`, `.cancelled`, or `.failed`, and `cancel()` on any of those
  /// is a no-op. On the startWalk-failure paths, where no finalize ever ran, this is what
  /// actually releases the writer's resources.
  private func teardown() async {
    frameToken = nil
    if let engine = audioEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    audioEngine = nil
    stream?.stop()
    session?.stop()
    photoToken = nil
    stream = nil
    session = nil
    videoWriter?.cancel()
    videoWriter = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

/// Owns the `AVAssetWriter` and both of its inputs, and every piece of state that mutates on
/// `mediaQueue`: the writer/input references themselves, whether the writer's session has been
/// opened, and whether an append has failed. Deliberately pulled out of `WalkthroughRecorder`
/// rather than living there as more private properties: the closures that append video and audio
/// samples run on `DispatchQueue.async`/`.sync`, both of which require their closures to be
/// `@Sendable`, and `WalkthroughRecorder` — an `RCTEventEmitter` subclass carrying plenty of
/// state (`session`, `stream`, `stillIndex`, ...) that is NOT confined to one queue — cannot
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
  let videoUrl: URL
  private let onFailure: (String) -> Void

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

  /// Census of what actually happened, reported by `endWalk`.
  ///
  /// Two walks produced ~4s of video against 35-47s of audio, and the file alone cannot say why:
  /// a frame that never arrived and a frame the writer refused look identical afterwards. These
  /// counters separate them. Cheap, and worth keeping — a walk that silently records four seconds
  /// of a forty-second site visit is the single most expensive failure this recorder can have.
  private(set) var videoFramesReceived = 0
  private(set) var videoFramesAppended = 0
  private(set) var videoFramesDropped = 0
  private(set) var audioBuffersAppended = 0
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
       videoUrl: URL,
       onFailure: @escaping (String) -> Void) {
    self.writer = writer
    self.videoInput = videoInput
    self.audioInput = audioInput
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
    guard let sampleBuffer = Self.makeAudioSampleBuffer(from: buffer, presentationTime: receivedAt) else {
      mediaQueue.async { self.fail(reason: "could not build an audio sample buffer") }
      return
    }
    mediaQueue.async {
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

    // Real-time input: if the encoder/writer is behind, drop this sample rather than queue it.
    // `expectsMediaDataInRealTime` makes `isReadyForMoreMediaData` reflect exactly this.
    //
    // A DROP IS NORMAL. A RUN OF DROPS IS NOT. An encoder that stalls never becomes ready again,
    // so an unbounded silent drop turns a dead video track into a walk that looks successful —
    // which is what happened on 2026-08-01: 3.4s of video, 46.8s of audio, no error anywhere.
    // Roughly two seconds of 30fps footage is long enough to rule out ordinary backpressure.
    guard input.isReadyForMoreMediaData else {
      if track == "video" {
        videoFramesDropped += 1
        consecutiveVideoDrops += 1
        if consecutiveVideoDrops == 60 {
          fail(reason: "video track: the writer stopped accepting frames and has not recovered "
            + "after 60 consecutive drops — the recording will have little or no video")
        }
      }
      return
    }
    if track == "video" { consecutiveVideoDrops = 0 }

    guard input.append(sampleBuffer) else {
      // append() returning false and being ignored is exactly the AVAudioRecorder.record()
      // mistake this codebase was already cleaned of elsewhere — except here it means the
      // walk's video file is quietly corrupt rather than merely silent.
      fail(reason: "\(track) append() returned false — "
        + "\(writer.error?.localizedDescription ?? "no error reported")")
      return
    }
    if track == "video" { videoFramesAppended += 1 } else { audioBuffersAppended += 1 }
  }

  /// What actually happened, read on `mediaQueue` so the counters are consistent with each other.
  /// `secondsSinceLastFrame` is the discriminator: near zero means frames were still arriving and
  /// the writer was refusing them; large means the glasses stopped sending.
  func census() -> [String: Any] {
    mediaQueue.sync {
      let quiet: Double = lastFrameArrivedAt.isValid
        ? CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(mediaClock), lastFrameArrivedAt))
        : -1
      return [
        "videoFramesReceived": videoFramesReceived,
        "videoFramesAppended": videoFramesAppended,
        "videoFramesDropped": videoFramesDropped,
        "audioBuffersAppended": audioBuffersAppended,
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
      guard self.writer.status == .writing else { return }
      self.videoInput.markAsFinished()
      self.audioInput.markAsFinished()
      self.writer.cancelWriting()
    }
  }
}

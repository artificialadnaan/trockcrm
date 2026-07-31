/*
 * Records a walkthrough: HFP audio from the glasses, plus stills on demand.
 *
 * Separate from WearablesBridge deliberately. That file owns the diagnostic ladder and is
 * already large; this owns a session with a lifetime, and mixing the two would put a
 * long-running recording next to one-shot measurements in the same object.
 *
 * The start sequence is Meta's documented order and is NOT rearrangeable: the stream is created
 * but not started, HFP is brought up and allowed to settle, and only then does the stream start.
 * Starting the stream first makes the audio route fail silently.
 */
import AVFoundation
import Foundation
import MWDATCamera
import MWDATCore
import React

@objc(WalkthroughRecorder)
final class WalkthroughRecorder: RCTEventEmitter {
  private var session: DeviceSession?
  private var stream: MWDATCamera.Stream?
  private var photoToken: AnyListenerToken?
  private var recorder: AVAudioRecorder?
  private var hasListeners = false
  private var walkDirectory: URL?
  private var stillIndex = 0

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
          config: StreamConfiguration(videoCodec: .raw, resolution: .high, frameRate: 30)
        ) else {
          await teardown()
          reject("walk_stream_nil", "addStream() returned nil", nil)
          return
        }
        stream = newStream

        photoToken = newStream.photoDataPublisher.listen { [weak self] (photo: PhotoData) in
          self?.deliverStill(photo)
        }

        // Meta step: HFP up and settled while the stream is still stopped.
        try audio.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP])
        try audio.setActive(true)
        let routeDeadline = Date().addingTimeInterval(3)
        while !audio.currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }),
              Date() < routeDeadline {
          try? await Task.sleep(nanoseconds: 100_000_000)
        }
        let input = audio.currentRoute.inputs.first
        guard input?.portType == .bluetoothHFP else {
          // Refuse rather than record silently. A walk with no glasses audio is a wasted site
          // visit, and the estimator will not discover it until the scope comes back empty.
          await teardown()
          reject(
            "walk_no_hfp",
            "Audio would record from \(input?.portName ?? "an unknown input"), not the glasses. "
              + "Connect them over Bluetooth and start again.",
            nil
          )
          return
        }

        let audioUrl = dir.appendingPathComponent("audio.m4a")
        let rec = try AVAudioRecorder(url: audioUrl, settings: [
          AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
          AVSampleRateKey: 16_000.0,
          AVNumberOfChannelsKey: 1,
        ])
        // record() reports startup failure by returning false rather than throwing. Ignoring it
        // here is worse than in the diagnostic rung: the estimator walks an entire site
        // believing audio is recording, and the gap is only discovered once the scope comes
        // back with no narration.
        guard rec.record() else {
          await teardown()
          reject("walk_audio_record_failed",
                 "AVAudioRecorder.record() returned false — recording did not start", nil)
          return
        }
        recorder = rec

        // Meta step: only now.
        newStream.start()

        resolve([
          "walkId": walkId,
          "directory": dir.absoluteString,
          "audioUri": audioUrl.absoluteString,
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

  // MARK: - End

  @objc(endWalk:rejecter:)
  func endWalk(_ resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      let audioUri = recorder?.url.absoluteString
      await teardown()
      resolve(["audioUri": audioUri as Any, "stills": stillIndex])
    }
  }

  /// Stop everything and hand the glasses back. HFP and A2DP are mutually exclusive, so an audio
  /// session left active pins the glasses in HFP and every other app's playback through them
  /// stays 8 kHz mono.
  private func teardown() async {
    recorder?.stop()
    recorder = nil
    stream?.stop()
    session?.stop()
    photoToken = nil
    stream = nil
    session = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

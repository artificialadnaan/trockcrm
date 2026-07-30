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
  private var stream: Stream?
  private var photoToken: AnyListenerToken?
  private var frameToken: AnyListenerToken?
  private var hasListeners = false

  /// First frame seen since the stream started, used to report real delivered dimensions
  /// rather than the ones we asked for.
  private var firstFrameSize: CGSize?
  private var firstFrameAt: Date?
  private var streamStartedAt: Date?

  /// `Wearables.configure()` is not idempotent in 0.8.0, so the guard lives here rather
  /// than trusting every JS caller to remember.
  private static var configured = false

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String] { ["wearables:photo", "wearables:frame"] }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

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
      reject("wearables_configure_failed", "Wearables.configure() failed: \(error)", error)
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
      "registrationState": String(describing: sdk.registrationState),
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
        reject("wearables_registration_failed", "startRegistration failed: \(error)", error)
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
        reject("wearables_handle_url_failed", "handleUrl failed: \(error)", error)
      }
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
        reject("wearables_permission_failed", "requestPermission(.camera) failed: \(error)", error)
      }
    }
  }

  // MARK: - 5/6. Session and stream

  @objc(startStream:rejecter:)
  func startStream(_ resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    do {
      let created = try Wearables.shared.createSession(deviceSelector: AutoDeviceSelector())
      session = created
      try created.start()

      guard let newStream = try created.addStream() else {
        reject("wearables_stream_nil", "addStream() returned nil", nil)
        return
      }
      stream = newStream

      firstFrameSize = nil
      firstFrameAt = nil
      streamStartedAt = Date()

      // Record what the FIRST frame actually measures. The configuration says what we asked
      // for; only a delivered frame says what the glasses sent.
      frameToken = newStream.videoFramePublisher.listen { [weak self] frame in
        guard let self, self.firstFrameSize == nil else { return }
        if let image = frame.makeUIImage() {
          self.firstFrameSize = image.size
          self.firstFrameAt = Date()
        }
      }

      photoToken = newStream.photoDataPublisher.listen { [weak self] photo in
        self?.deliverPhoto(photo)
      }

      newStream.start()
      resolve(["started": true, "config": String(describing: newStream.streamConfiguration)])
    } catch {
      reject("wearables_stream_failed", "startStream failed: \(error)", error)
    }
  }

  @objc(streamInfo:rejecter:)
  func streamInfo(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let size = firstFrameSize, let at = firstFrameAt, let started = streamStartedAt else {
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
    stream?.stop()
    session?.stop()
    frameToken = nil
    photoToken = nil
    stream = nil
    session = nil
    resolve(["stopped": true])
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
    AVAudioApplication.requestRecordPermission { [weak self] granted in
      guard granted else {
        reject("wearables_mic_denied", "Microphone permission denied", nil)
        return
      }
      guard let self else { return }
      do {
        let audioSession = AVAudioSession.sharedInstance()
        // .allowBluetoothHFP is what opens the glasses microphone; A2DP output options do
        // not provide input at all.
        if #available(iOS 26.0, *) {
          try audioSession.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP])
        } else {
          try audioSession.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth])
        }
        try audioSession.setActive(true)

        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent("wearables-audio-\(Int(Date().timeIntervalSince1970)).m4a")
        let recorder = try AVAudioRecorder(url: url, settings: [
          AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
          // Ask for 48k; the hardware reports back what it actually negotiated, which is the
          // number this whole method exists to produce.
          AVSampleRateKey: 48_000.0,
          AVNumberOfChannelsKey: 1,
        ])
        recorder.record()

        let route = audioSession.currentRoute
        let input = route.inputs.first
        let negotiated = audioSession.sampleRate

        DispatchQueue.main.asyncAfter(deadline: .now() + seconds.doubleValue) {
          recorder.stop()
          let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
          resolve([
            "fileUri": url.absoluteString,
            "bytes": (attrs?[.size] as? Int) ?? 0,
            "negotiatedSampleRate": negotiated,
            "wideband": negotiated >= 16_000,
            "inputPortName": input?.portName ?? "none",
            "inputPortType": input?.portType.rawValue ?? "none",
            "isBluetoothInput": input?.portType == .bluetoothHFP,
            "streamWasRunningFirst": streamWasRunning,
          ])
        }
      } catch {
        reject("wearables_audio_failed", "HFP capture failed: \(error)", error)
      }
    }
  }
}

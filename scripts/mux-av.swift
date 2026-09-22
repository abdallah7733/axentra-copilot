// Muxes a video track with one or two audio tracks into an MP4.
//   mux-av <video.mp4> <out.mp4> <audio.mp3>[:volume[:loop]] ...
// Each audio track starts at 0 and is truncated to the video's duration.
// A track is repeated to fill the video ONLY with the explicit ":loop" flag,
// which is for the ambient bed. Dialogue must never loop.
import AVFoundation

@main struct Main {
  static func main() async throws {
    let args = CommandLine.arguments
    guard args.count >= 4 else {
      FileHandle.standardError.write("usage: mux-av <video.mp4> <out.mp4> <audio[:vol]>...\n".data(using: .utf8)!)
      exit(1)
    }
    let videoURL = URL(fileURLWithPath: args[1])
    let outURL = URL(fileURLWithPath: args[2])
    try? FileManager.default.removeItem(at: outURL)

    let comp = AVMutableComposition()
    let params = AVMutableAudioMix()
    var mixParams: [AVAudioMixInputParameters] = []

    let videoAsset = AVURLAsset(url: videoURL)
    let vDur = try await videoAsset.load(.duration)
    guard let vSrc = try await videoAsset.loadTracks(withMediaType: .video).first,
          let vDst = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
      FileHandle.standardError.write("no video track\n".data(using: .utf8)!); exit(1)
    }
    try vDst.insertTimeRange(CMTimeRange(start: .zero, duration: vDur), of: vSrc, at: .zero)

    for spec in args.dropFirst(3) {
      let parts = spec.split(separator: ":", maxSplits: 2)
      let path = String(parts[0])
      let vol = parts.count > 1 ? Float(parts[1]) ?? 1.0 : 1.0
      let shouldLoop = parts.count > 2 && parts[2] == "loop"
      let asset = AVURLAsset(url: URL(fileURLWithPath: path))
      guard let src = try await asset.loadTracks(withMediaType: .audio).first,
            let dst = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
      let aDur = try await asset.load(.duration)
      if shouldLoop {
        var remaining = vDur
        var at = CMTime.zero
        while remaining > .zero {
          let chunk = CMTimeMinimum(aDur, remaining)
          try dst.insertTimeRange(CMTimeRange(start: .zero, duration: chunk), of: src, at: at)
          at = at + chunk
          remaining = remaining - chunk
        }
      } else {
        // Play once. Shorter than the video means silence after it ends, which is correct.
        let dur = CMTimeMinimum(aDur, vDur)
        try dst.insertTimeRange(CMTimeRange(start: .zero, duration: dur), of: src, at: .zero)
      }
      let p = AVMutableAudioMixInputParameters(track: dst)
      p.setVolume(vol, at: .zero)
      // Fade the bed out over the final 1.5 s so the file does not end abruptly.
      let fade = CMTime(seconds: 1.5, preferredTimescale: 600)
      p.setVolumeRamp(fromStartVolume: vol, toEndVolume: 0, timeRange: CMTimeRange(start: vDur - fade, duration: fade))
      mixParams.append(p)
    }
    params.inputParameters = mixParams

    guard let export = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality) else {
      FileHandle.standardError.write("cannot create export session\n".data(using: .utf8)!); exit(1)
    }
    export.audioMix = params
    try await export.export(to: outURL, as: .mp4)
    print("wrote \(outURL.path)")
  }
}

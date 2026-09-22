// Encodes a directory of sequentially named PNG frames into an H.264 MP4.
//   pngs2mp4 <framesDir> <fps> <out.mp4>
import Foundation
import AVFoundation
import AppKit

let args = CommandLine.arguments
guard args.count == 4, let fps = Int32(args[2]) else {
    FileHandle.standardError.write("usage: pngs2mp4 <framesDir> <fps> <out.mp4>\n".data(using: .utf8)!)
    exit(1)
}
let dir = args[1]
let outURL = URL(fileURLWithPath: args[3])
try? FileManager.default.removeItem(at: outURL)

let files = try FileManager.default.contentsOfDirectory(atPath: dir).filter { $0.hasSuffix(".png") }.sorted()
guard let first = files.first, let firstImage = NSImage(contentsOfFile: "\(dir)/\(first)"),
      let cg0 = firstImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("no frames\n".data(using: .utf8)!)
    exit(1)
}
let width = cg0.width, height = cg0.height

let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 10_000_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: fps * 2,
    ],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

func pixelBuffer(from cg: CGImage) -> CVPixelBuffer? {
    var pb: CVPixelBuffer?
    guard let pool = adaptor.pixelBufferPool,
          CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb) == kCVReturnSuccess, let buf = pb else { return nil }
    CVPixelBufferLockBaseAddress(buf, [])
    defer { CVPixelBufferUnlockBaseAddress(buf, []) }
    guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: width, height: height, bitsPerComponent: 8,
                              bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
    return buf
}

var i: Int64 = 0
for f in files {
    autoreleasepool {
        guard let img = NSImage(contentsOfFile: "\(dir)/\(f)"),
              let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let buf = pixelBuffer(from: cg) else { return }
        while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
        adaptor.append(buf, withPresentationTime: CMTime(value: i, timescale: fps))
        i += 1
        if i % 300 == 0 { print("encoded \(i) frames") }
    }
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { FileHandle.standardError.write("writer failed: \(String(describing: writer.error))\n".data(using: .utf8)!); exit(1) }
print("wrote \(outURL.path) (\(i) frames at \(fps) fps)")

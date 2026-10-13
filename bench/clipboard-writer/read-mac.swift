import AppKit
import Foundation

// Read-only fixture observer. Native format inspection runs after the timed writer has returned.
guard CommandLine.arguments.count == 2 else { fatalError("Expected owned output directory") }
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let pasteboard = NSPasteboard.general
let formats = (pasteboard.types ?? []).map { $0.rawValue }.sorted()
var images: [[String: Any]] = []
for (type, filename) in [(NSPasteboard.PasteboardType.png, "native.png"), (.tiff, "native.tiff")] {
    let data = pasteboard.data(forType: type)
    if let data = data { try data.write(to: directory.appendingPathComponent(filename)) }
    images.append(["format": type.rawValue, "declared": formats.contains(type.rawValue),
                   "bytes": data?.count ?? 0, "filename": filename])
}
let report: [String: Any] = ["formats": formats, "images": images,
                              "reader": "NSPasteboard.types/data(forType:)", "readOnly": true]
let encoded = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
FileHandle.standardOutput.write(encoded)
FileHandle.standardOutput.write(Data([10]))

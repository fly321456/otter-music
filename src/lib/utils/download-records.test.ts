import {
  buildDownloadedExactKeyFromPath,
  mergeLocalFilesWithDownloadRecords,
  normalizeLocalPath,
} from "./download-records";

describe("download record helpers", () => {
  it("normalizes file uri paths", () => {
    expect(
      normalizeLocalPath(
        "file:///storage/emulated/0/Download/OtterMusic/Test%20Song%20-%20Singer.mp3"
      )
    ).toBe("/storage/emulated/0/Download/OtterMusic/Test Song - Singer.mp3");
  });

  it("builds exact keys from download record file names", () => {
    expect(
      buildDownloadedExactKeyFromPath(
        "file:///storage/emulated/0/Download/OtterMusic/Test Song - Singer A & Singer B.mp3"
      )
    ).toBe("testsong|singera/singerb");
  });

  it("merges missing OtterMusic download records into local files", () => {
    const merged = mergeLocalFilesWithDownloadRecords(
      [
        {
          id: "existing",
          name: "Existing Song",
          artist: "Existing Artist",
          album: null,
          duration: 1000,
          localPath: "/storage/emulated/0/Music/existing.mp3",
          fileSize: 123,
        },
      ],
      {
        "joox:1":
          "file:///storage/emulated/0/Download/OtterMusic/Test Song - Singer.mp3",
      }
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]?.localPath).toBe(
      "/storage/emulated/0/Download/OtterMusic/Test Song - Singer.mp3"
    );
    expect(merged[1]?.name).toBe("Test Song");
    expect(merged[1]?.artist).toBe("Singer");
  });

  it("does not duplicate a downloaded track already present in local scan results", () => {
    const merged = mergeLocalFilesWithDownloadRecords(
      [
        {
          id: "media-store-entry",
          name: "Test Song",
          artist: "Singer",
          album: null,
          duration: 1000,
          localPath: "content://media/external/audio/media/123",
          fileSize: 123,
        },
      ],
      {
        "joox:1":
          "file:///storage/emulated/0/Download/OtterMusic/Test Song - Singer.mp3",
      }
    );

    expect(merged).toHaveLength(1);
  });
});

import type { LocalMusicFile } from "@/plugins/local-music";
import type { MusicTrack } from "@/types/music";
import { STORAGE_CONFIG } from "@/lib/storage-manager";
import { getExactKey, normalizeText, normalizeArtists } from "./music-key";
import { useMusicStore } from "@/store/music-store";

const UNKNOWN_ARTIST = "未知艺术家";
const DEFAULT_DOWNLOAD_ROOT = STORAGE_CONFIG.ROOT.replace(/\\/g, "/");

function safeDecodeUri(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeLocalPath(pathOrUri?: string | null): string | null {
  if (!pathOrUri) return null;
  if (pathOrUri.startsWith("content://")) return pathOrUri;

  const decoded = safeDecodeUri(pathOrUri);
  if (!decoded.startsWith("file://")) {
    return decoded.replace(/\\/g, "/");
  }

  const withoutScheme = decoded.replace(/^file:\/\//, "");
  return withoutScheme.replace(/\\/g, "/");
}

function getDownloadRoot() {
  const customDir = useMusicStore.getState().downloadDirectory;
  if (customDir) {
    return `Download/${customDir}`.replace(/\/+/g, "/");
  }
  return DEFAULT_DOWNLOAD_ROOT;
}

export function isOtterMusicDownloadPath(pathOrUri?: string | null) {
  const normalized = normalizeLocalPath(pathOrUri);
  const downloadRoot = getDownloadRoot();
  return !!normalized && normalized.includes(downloadRoot);
}

function getBasename(pathOrUri: string) {
  const normalized = normalizeLocalPath(pathOrUri);
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function splitArtists(artistText: string | null) {
  if (!artistText) return [UNKNOWN_ARTIST];

  const artists = artistText
    .split(/\s*&\s*|[/、，,]/)
    .map((item) => item.trim())
    .filter(Boolean);

  return artists.length ? artists : [UNKNOWN_ARTIST];
}

export function parseDownloadFileName(pathOrUri: string): {
  name: string;
  artists: string[];
  artistText: string | null;
} | null {
  const basename = getBasename(pathOrUri);
  if (!basename) return null;

  const withoutExt = basename.replace(/\.[^/.]+$/, "").trim();
  if (!withoutExt) return null;

  const separatorIndex = withoutExt.lastIndexOf(" - ");
  if (separatorIndex <= 0 || separatorIndex >= withoutExt.length - 3) {
    return {
      name: withoutExt,
      artists: [UNKNOWN_ARTIST],
      artistText: null,
    };
  }

  const name = withoutExt.slice(0, separatorIndex).trim();
  const artistText = withoutExt.slice(separatorIndex + 3).trim();

  return {
    name: name || withoutExt,
    artists: splitArtists(artistText),
    artistText: artistText || null,
  };
}

function buildExactKeyFromNameArtist(name: string, artists: string[]) {
  const track = {
    id: "",
    name,
    artist: artists,
    album: "",
    pic_id: "",
    url_id: "",
    lyric_id: "",
    source: "local",
  } as MusicTrack;

  return getExactKey(track);
}

function buildTrackDownloadKey(track: Pick<MusicTrack, "source" | "id">) {
  return `${track.source}:${track.id}`;
}

export function buildTrackExactKey(track: Pick<MusicTrack, "name" | "artist">) {
  return buildExactKeyFromNameArtist(track.name, track.artist);
}

export function buildDownloadedExactKeyFromPath(pathOrUri?: string | null) {
  if (!isOtterMusicDownloadPath(pathOrUri)) return null;
  if (!pathOrUri) return null;

  const parsed = parseDownloadFileName(pathOrUri);
  if (!parsed) return null;

  return buildExactKeyFromNameArtist(parsed.name, parsed.artists);
}

export function collectDownloadedExactKeysFromRecords(
  records: Record<string, string>
) {
  const keys = new Set<string>();

  Object.values(records).forEach((uri) => {
    const exactKey = buildDownloadedExactKeyFromPath(uri);
    if (exactKey) keys.add(exactKey);
  });

  return keys;
}

export function findDownloadedRecordByTrack(
  records: Record<string, string>,
  track: Pick<MusicTrack, "id" | "source" | "name" | "artist">
) {
  const directKey = buildTrackDownloadKey(track);
  if (records[directKey]) {
    return {
      key: directKey,
      uri: records[directKey],
      matchedBy: "direct" as const,
    };
  }

  const exactKey = buildTrackExactKey(track);

  for (const [key, uri] of Object.entries(records)) {
    if (buildDownloadedExactKeyFromPath(uri) !== exactKey) continue;
    return {
      key,
      uri,
      matchedBy: "exact" as const,
    };
  }

  const normalizedTrackName = normalizeText(track.name);
  const trackArtists = new Set(normalizeArtists(track.artist));

  for (const [key, uri] of Object.entries(records)) {
    const parsed = parseDownloadFileName(uri);
    if (!parsed) continue;

    const normalizedFileName = normalizeText(parsed.name);
    const fileArtists = new Set(normalizeArtists(parsed.artists));

    const nameMatches =
      normalizedFileName.includes(normalizedTrackName) ||
      normalizedTrackName.includes(normalizedFileName);

    if (!nameMatches) continue;

    const hasCommonArtist =
      track.artist.length === 0 ||
      [...trackArtists].some((a) => fileArtists.has(a));

    if (hasCommonArtist) {
      return {
        key,
        uri,
        matchedBy: "fuzzy" as const,
      };
    }
  }

  return null;
}

export function collectDownloadedExactKeysFromLocalFiles(
  files: LocalMusicFile[]
) {
  const keys = new Set<string>();

  files.forEach((file) => {
    keys.add(
      buildExactKeyFromNameArtist(
        file.name || "未知歌曲",
        splitArtists(file.artist)
      )
    );
  });

  return keys;
}

export function findLocalFileByTrack(
  files: LocalMusicFile[],
  track: Pick<MusicTrack, "name" | "artist">
) {
  const exactKey = buildTrackExactKey(track);
  return files.find(
    (file) =>
      buildExactKeyFromNameArtist(
        file.name || "未知歌曲",
        splitArtists(file.artist)
      ) === exactKey
  );
}

export function hasDownloadedTrack(
  records: Record<string, string>,
  files: LocalMusicFile[],
  track: Pick<MusicTrack, "id" | "source" | "name" | "artist">
) {
  if (track.source === "local") return true;
  return (
    !!findDownloadedRecordByTrack(records, track) ||
    !!findLocalFileByTrack(files, track)
  );
}

export function createLocalFileFromDownloadRecord(
  pathOrUri: string
): LocalMusicFile | null {
  if (!isOtterMusicDownloadPath(pathOrUri)) return null;

  const localPath = normalizeLocalPath(pathOrUri);
  const parsed = parseDownloadFileName(pathOrUri);
  if (!localPath || !parsed) return null;

  return {
    id: `download:${localPath}`,
    name: parsed.name,
    artist: parsed.artistText,
    album: STORAGE_CONFIG.BASE_NAME,
    duration: 0,
    localPath,
    fileSize: 0,
  };
}

export function mergeLocalFilesWithDownloadRecords(
  files: LocalMusicFile[],
  records: Record<string, string>
) {
  const merged = [...files];
  const seenPaths = new Set(
    files.map((file) => normalizeLocalPath(file.localPath)).filter(Boolean)
  );
  const seenExactKeys = collectDownloadedExactKeysFromLocalFiles(files);

  Object.values(records).forEach((uri) => {
    const synthetic = createLocalFileFromDownloadRecord(uri);
    const normalizedPath = normalizeLocalPath(synthetic?.localPath);
    const exactKey = synthetic
      ? buildExactKeyFromNameArtist(
          synthetic.name || "未知歌曲",
          splitArtists(synthetic.artist)
        )
      : null;
    if (
      !synthetic ||
      !normalizedPath ||
      seenPaths.has(normalizedPath) ||
      (exactKey && seenExactKeys.has(exactKey))
    ) {
      return;
    }

    seenPaths.add(normalizedPath);
    if (exactKey) seenExactKeys.add(exactKey);
    merged.push(synthetic);
  });

  return merged;
}

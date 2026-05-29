import { Capacitor } from "@capacitor/core";
import { Filesystem, Encoding } from "@capacitor/filesystem";
import { FileTransfer } from "@capacitor/file-transfer";
import { MusicProviderFactory } from "@/lib/music-provider";
import {
  AppPaths,
  DOWNLOAD_RECORDS_FILE,
  STORAGE_CONFIG,
  buildFileName,
} from "@/lib/storage-manager";
import { MusicSource, MusicTrack } from "@/types/music";
import toast from "react-hot-toast";
import { base64ToBlob } from "@/lib/utils/base64";
import {
  hasDownloadedTrack,
} from "@/lib/utils/download-records";
import { LocalMusicFile } from "@/plugins/local-music";

import { useDownloadStore } from "@/store/download-store";
import { useLocalMusicStore } from "@/store/local-music-store";
import { useMusicStore } from "@/store/music-store";
import { toastUtils } from "./toast";
import { getProxyUrl, isProxyUrl } from "@/lib/api/config";
import { logger } from "@/lib/logger";
import { processBatchIO } from "@/lib/utils";
import { embedMetadata, MAX_EMBED_SIZE } from "./id3-embed";

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

function getCurrentPlayingUrl(
  track: MusicTrack,
  downloadQuality: number
): string | null {
  const state = useMusicStore.getState();
  const currentTrack = state.queue[state.currentIndex];

  if (!currentTrack || !state.currentAudioUrl) return null;

  const isSameTrack =
    currentTrack.source === track.source && currentTrack.id === track.id;
  if (!isSameTrack) return null;

  const currentPlayQuality = parseInt(state.quality) || 192;
  if (currentPlayQuality !== downloadQuality) return null;

  return state.currentAudioUrl;
}

export function buildDownloadKey(source: MusicSource, id: string) {
  return `${source}:${id}`;
}

interface PerformDownloadOpts {
  skipMetadata?: boolean;
}

const NATIVE_BATCH_DOWNLOAD_CONCURRENCY = 1;
const WEB_BATCH_DOWNLOAD_CONCURRENCY = 2;

function getDownloadContext() {
  return {
    records: useDownloadStore.getState().records,
    localFiles: useLocalMusicStore.getState().files,
  };
}

function isTrackAlreadyDownloaded(track: MusicTrack) {
  const { records, localFiles } = getDownloadContext();
  return hasDownloadedTrack(records, localFiles, track);
}

const ALL_QUALITIES = [999, 320, 192, 128];

function getFallbackQualities(primaryBr: number): number[] {
  return ALL_QUALITIES.filter((q) => q !== primaryBr);
}

async function performDownloadOne(
  track: MusicTrack,
  toastId?: string,
  opts?: PerformDownloadOpts
): Promise<void> {
  const fileName = buildFileName(track);
  const isNative = Capacitor.isNativePlatform();
  const br = parseInt(useMusicStore.getState().downloadQuality) || 320;

  if (isTrackAlreadyDownloaded(track)) {
    logger.info("download", "Skip already-downloaded track", {
      trackId: track.id,
      source: track.source,
      name: track.name,
    });
    return;
  }

  let url = getCurrentPlayingUrl(track, br);
  const isReusedUrl = !!url;

  if (!url) {
    url = await MusicProviderFactory.getProvider(track.source).getUrl(track, br);
  }

  if (!url) {
    for (const fallbackBr of getFallbackQualities(br)) {
      url = await MusicProviderFactory.getProvider(track.source).getUrl(
        track,
        fallbackBr
      );
      if (url) break;
    }
  }

  if (!url) throw new Error("无法获取下载链接");

  const doDownload = async (downloadUrl: string) => {
    await (isNative
      ? downloadNative(downloadUrl, fileName, track, toastId, opts)
      : downloadWeb(downloadUrl, fileName, track, toastId, opts));
  };

  try {
    await doDownload(url);
  } catch (err) {
    if (isReusedUrl) {
      logger.warn("Reused URL download failed, falling back to getUrl...", err);
      const freshUrl = await MusicProviderFactory.getProvider(track.source).getUrl(track, br);
      if (!freshUrl) throw new Error("无法获取下载链接");
      try {
        await doDownload(freshUrl);
        return;
      } catch (freshErr) {
        if (isProxyUrl(freshUrl)) throw freshErr;
        logger.warn("Fresh URL download failed, retrying with proxy...", freshErr);
        if (toastId) {
          toast.loading("已切换备用下载线路", { id: toastId, icon: "🌐" });
        }
        await doDownload(getProxyUrl(freshUrl));
        return;
      }
    }

    if (isProxyUrl(url)) throw err;
    logger.warn("Direct download failed, retrying with proxy...", err);
    if (toastId) {
      toast.loading("已切换备用下载线路", { id: toastId, icon: "🌐" });
    }
    await doDownload(getProxyUrl(url));
  }
}

export async function downloadMusicTrack(track: MusicTrack) {
  if (track.source !== "local" && isTrackAlreadyDownloaded(track)) {
    return toastUtils.info("该歌曲已在本地存在，跳过下载");
  }
  if (track.source === "local") {
    return toastUtils.info("本地音乐，无需下载");
  }

  const toastId = toast.loading(`准备下载: ${track.name}`);

  try {
    await performDownloadOne(track, toastId);
  } catch (err: unknown) {
    logger.error("downloadMusicTrack", "Download failed", err, {
      trackId: track.id,
      source: track.source,
    });
    const message = err instanceof Error ? err.message : String(err);
    toast.error(`下载失败: ${message}`, { id: toastId });
  }
}

export async function downloadMusicTrackBatch(tracks: MusicTrack[]) {
  const validTracks = tracks.filter((t) => t.source !== "local" && !isTrackAlreadyDownloaded(t));
  const total = validTracks.length;

  if (!total) {
    return toastUtils.info("所选曲目无需下载");
  }

  let done = 0;
  let failCount = 0;
  const toastId = toast.loading(`准备下载 0/${total}`);

  let lastProgressUpdate = 0;
  const updateProgress = (current: number, isLast = false) => {
    const now = Date.now();
    if (isLast || now - lastProgressUpdate >= 150) {
      lastProgressUpdate = now;
      toast.loading(`下载中 ${current}/${total}`, { id: toastId });
    }
  };

  const concurrency = Capacitor.isNativePlatform()
    ? NATIVE_BATCH_DOWNLOAD_CONCURRENCY
    : WEB_BATCH_DOWNLOAD_CONCURRENCY;

  await processBatchIO(
    validTracks,
    async (track) => {
      try {
        await performDownloadOne(track);
      } catch (err) {
        failCount++;
        logger.error(
          "downloadMusicTrackBatch",
          `Failed: ${track.name || track.id}`,
          err
        );
      } finally {
        done++;
        updateProgress(done, done === total);
      }
    },
    undefined,
    concurrency
  );

  const successCount = total - failCount;

  const failMsg = `下载完成（成功 ${successCount} / 失败 ${failCount}）`;
  const successMsg = `已成功下载全部 ${successCount} 首`;

  failCount > 0
    ? toastUtils.warning(failMsg, { id: toastId, duration: 5000 })
    : toast.success(successMsg, { id: toastId, duration: 3000 });
}

function resolveContentUriToFilePath(contentUri: string, relativePath: string): string | null {
  try {
    const decoded = decodeURIComponent(contentUri);

    const primaryMatch = decoded.match(/\/document\/primary:(.+)/);
    if (primaryMatch) {
      return `/storage/emulated/0/${primaryMatch[1]}`;
    }

    const sdCardMatch = decoded.match(/\/document\/([A-F0-9-]+):(.+)/i);
    if (sdCardMatch) {
      const sdCardId = sdCardMatch[1];
      const filePath = sdCardMatch[2];
      return `/storage/${sdCardId}/${filePath}`;
    }

    const treeMatch = decoded.match(/\/tree\/primary:(.+)/);
    if (treeMatch) {
      const treePath = treeMatch[1];
      const fileName = relativePath.split("/").pop() || "";
      return `/storage/emulated/0/${treePath}/${fileName}`;
    }

    const sdTreeMatch = decoded.match(/\/tree\/([A-F0-9-]+):(.+)/i);
    if (sdTreeMatch) {
      const sdCardId = sdTreeMatch[1];
      const treePath = sdTreeMatch[2];
      const fileName = relativePath.split("/").pop() || "";
      return `/storage/${sdCardId}/${treePath}/${fileName}`;
    }
  } catch {
    // Ignore URI parsing errors
  }
  return null;
}

async function downloadNative(
  url: string,
  fileName: string,
  track: MusicTrack,
  toastId?: string,
  opts?: PerformDownloadOpts
) {
  await ensurePermission();
  const store = useMusicStore.getState();
  const musicPath = store.downloadDirectory || AppPaths.Music;

  const filePath = `${musicPath}/${fileName}`;

  const listener = await FileTransfer.addListener(
    "progress",
    ({ bytes, contentLength }) => {
      if (!toastId) return;
      if (!contentLength) {
        toast.loading(`下载中...`, { id: toastId });
      } else {
        const percent = Math.round((bytes / contentLength) * 100);
        toast.loading(`下载 ${percent}%`, { id: toastId });
      }
    }
  );

  try {
    await ensureDir(musicPath);

    const fileUri = await Filesystem.getUri({
      directory: STORAGE_CONFIG.BASE_DIR,
      path: filePath,
    });

    let downloadPath = fileUri.uri;

    if (downloadPath.startsWith('content://')) {
      const originalUri = downloadPath;
      const resolvedPath = resolveContentUriToFilePath(downloadPath, filePath);
      if (resolvedPath) {
        downloadPath = resolvedPath;
      } else {
        downloadPath = `/storage/emulated/0/${filePath}`;
        logger.warn("download", "Failed to resolve content URI, using fallback path", {
          contentUri: originalUri,
          fallbackPath: downloadPath,
        });
      }
    }

    if (!downloadPath.startsWith('file://')) {
      downloadPath = `file://${downloadPath}`;
    }

    await FileTransfer.downloadFile({
      url,
      path: downloadPath,
    });

    if (!opts?.skipMetadata && (store.embedCover || store.embedLyric)) {
      await embedMetadataNative(filePath, track, toastId);
    }

    const key = buildDownloadKey(track.source, track.id);
    await useDownloadStore.getState().addRecord(key, fileUri.uri);

    if (toastId) toast.success("下载完成", { id: toastId });
  } finally {
    await listener.remove();
  }
}

async function embedMetadataNative(
  filePath: string,
  track: MusicTrack,
  toastId?: string
) {
  try {
    const statResult = await Filesystem.stat({
      path: filePath,
      directory: STORAGE_CONFIG.BASE_DIR,
    });

    if (statResult.size && statResult.size > MAX_EMBED_SIZE) {
      logger.warn(
        "download",
        `文件过大 (${(statResult.size / 1024 / 1024).toFixed(1)}MB)，跳过元数据嵌入`,
        { trackName: track.name, filePath }
      );
      return;
    }

    if (toastId) toast.loading("正在写入元数据...", { id: toastId });

    const readResult = await Filesystem.readFile({
      path: filePath,
      directory: STORAGE_CONFIG.BASE_DIR,
    });

    const ext = filePath.split('.').pop()?.toLowerCase() || 'mp3';
    const mimeMap: Record<string, string> = {
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      aac: 'audio/aac',
      m4a: 'audio/mp4',
      wma: 'audio/x-ms-wma',
      opus: 'audio/opus',
    };
    const mimeType = mimeMap[ext] || 'audio/mpeg';
    const blob = base64ToBlob(readResult.data as string, mimeType);

    const store = useMusicStore.getState();
    const result = await embedMetadata(blob, track, {
      embedCover: store.embedCover,
      embedLyric: store.embedLyric,
    });

    const newBase64 = await blobToBase64(result.blob);

    await Filesystem.writeFile({
      path: filePath,
      data: newBase64,
      directory: STORAGE_CONFIG.BASE_DIR,
    });
  } catch (e) {
    logger.warn("download", "Native 元数据嵌入失败", e);
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function downloadWeb(
  url: string,
  fileName: string,
  track: MusicTrack,
  toastId?: string,
  opts?: PerformDownloadOpts
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const statusText = res.statusText || 'Unknown error';
      throw new Error(`下载失败: HTTP ${res.status} ${statusText}`);
    }

    const total = Number(res.headers.get("content-length")) || 0;
    const contentType = res.headers.get("content-type") || "audio/mpeg";
    const reader = res.body?.getReader();

    if (!reader) {
      const rawBlob = await res.blob();
      const blob = await applyMetadata(rawBlob, track, toastId, opts);
      return triggerBlobDownload(blob, fileName, toastId);
    }

    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;

      if (total && toastId) {
        const percent = Math.round((received / total) * 100);
        toast.loading(`下载 ${percent}%`, { id: toastId });
      }
    }

    const rawBlob = new Blob(chunks as BlobPart[], { type: contentType });
    const blob = await applyMetadata(rawBlob, track, toastId, opts);
    triggerBlobDownload(blob, fileName, toastId);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('下载超时，请检查网络连接');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function applyMetadata(
  blob: Blob,
  track: MusicTrack,
  toastId?: string,
  opts?: PerformDownloadOpts
): Promise<Blob> {
  if (opts?.skipMetadata) return blob;

  const store = useMusicStore.getState();
  if (!store.embedCover && !store.embedLyric) return blob;

  if (toastId) toast.loading("正在写入元数据...", { id: toastId });

  try {
    const result = await embedMetadata(blob, track, {
      embedCover: store.embedCover,
      embedLyric: store.embedLyric,
    });
    return result.blob;
  } catch (e) {
    logger.warn("download", "元数据嵌入失败", e);
    return blob;
  }
}

export async function ensurePermission() {
  const { publicStorage } = await Filesystem.checkPermissions();

  if (publicStorage === "granted") return;

  const req = await Filesystem.requestPermissions();
  if (req.publicStorage !== "granted") {
    throw new Error("需要存储权限才能下载音乐");
  }
}

async function ensureDir(path: string) {
  try {
    await Filesystem.stat({
      directory: STORAGE_CONFIG.BASE_DIR,
      path,
    });
  } catch {
    await Filesystem.mkdir({
      directory: STORAGE_CONFIG.BASE_DIR,
      path,
      recursive: true,
    });
  }
}

export function triggerBlobDownload(
  blob: Blob,
  filename: string,
  toastId?: string
) {
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";

  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);

  if (toastId) toast.success("下载完成", { id: toastId });
}

export async function saveDownloadRecordsToDisk(
  records: Record<string, string>
) {
  if (!Capacitor.isNativePlatform()) return;

  try {
    await ensureDir(AppPaths.Data);

    await Filesystem.writeFile({
      path: AppPaths.join(AppPaths.Data, DOWNLOAD_RECORDS_FILE),
      data: JSON.stringify(records),
      directory: STORAGE_CONFIG.BASE_DIR,
      encoding: Encoding.UTF8,
      recursive: true,
    });
  } catch (e) {
    logger.error("download", "保存下载记录失败", e);
  }
}

export async function loadDownloadRecordsFromDisk(): Promise<Record<
  string,
  string
> | null> {
  if (!Capacitor.isNativePlatform()) return null;

  try {
    const result = await Filesystem.readFile({
      path: AppPaths.join(AppPaths.Data, DOWNLOAD_RECORDS_FILE),
      directory: STORAGE_CONFIG.BASE_DIR,
      encoding: Encoding.UTF8,
    });

    const content =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data);

    return JSON.parse(content);
  } catch (e) {
    logger.warn("download", "读取下载记录失败", e);
    return null;
  }
}

const LOCAL_ARTIST_SPLIT_RE = /[/、,，&＆;；|]/;
const LOCAL_ARTIST_DOUBLE_SPACE_RE = /\s{2,}/;

function getBasename(path: string) {
  const normalized = path.replace(/^file:\/\//, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function isChineseChar(c: string): boolean {
  const charCode = c.charCodeAt(0);
  return (
    (charCode >= 0x4e00 && charCode <= 0x9fff) ||
    (charCode >= 0x3400 && charCode <= 0x4dbf) ||
    (charCode >= 0x20000 && charCode <= 0x2a6df) ||
    (charCode >= 0x2a700 && charCode <= 0x2b73f) ||
    (charCode >= 0x2b740 && charCode <= 0x2b81f) ||
    (charCode >= 0x2b820 && charCode <= 0x2ceaf) ||
    (charCode >= 0xf900 && charCode <= 0xfaff) ||
    (charCode >= 0x3300 && charCode <= 0x33ff) ||
    (charCode >= 0xfe30 && charCode <= 0xfe4f) ||
    (charCode >= 0xf000 && charCode <= 0xf0ff) ||
    (charCode >= 0x2f800 && charCode <= 0x2fa1f)
  );
}

function isValidSeparatorPosition(name: string, sepIndex: number): boolean {
  if (sepIndex <= 0 || sepIndex >= name.length - 3) {
    return false;
  }

  const beforeDash = name[sepIndex - 1];
  const afterDash = name[sepIndex + 3];

  const validPrefixChars = ['）', ')', ']', '"', "'", '’'];
  const validSuffixChars = ['（', '(', '[', '"', "'", '‘'];

  const hasValidPrefix =
    /[a-zA-Z0-9]/.test(beforeDash) ||
    isChineseChar(beforeDash) ||
    validPrefixChars.includes(beforeDash);

  const hasValidSuffix =
    /[a-zA-Z0-9]/.test(afterDash) ||
    isChineseChar(afterDash) ||
    validSuffixChars.includes(afterDash);

  return hasValidPrefix && hasValidSuffix;
}

function parseFilenameFormat(filename: string): { name: string | null; artist: string | null } {
  if (!filename) {
    return { name: null, artist: null };
  }

  const withoutExt = filename.replace(/\.[^/.]+$/, "");
  const sepIndex = withoutExt.lastIndexOf(" - ");

  if (!isValidSeparatorPosition(withoutExt, sepIndex)) {
    return { name: null, artist: null };
  }

  const name = withoutExt.slice(0, sepIndex).trim();
  const artist = withoutExt.slice(sepIndex + 3).trim();

  if (!name || !artist) {
    return { name: null, artist: null };
  }

  return { name, artist };
}

export const convertToMusicTrack = (file: LocalMusicFile): MusicTrack => {
  let album = file.album;

  if (album === STORAGE_CONFIG.BASE_NAME) {
    album = "";
  }

  let trackName = (file.name || "").trim();
  let artistStr = (file.artist || "").trim();

  const basename = getBasename(file.localPath);
  const parsed = parseFilenameFormat(basename);

  if (parsed.name && parsed.artist) {
    trackName = parsed.name;
    artistStr = parsed.artist;
  }

  let artistList: string[] = [];
  if (artistStr) {
    if (LOCAL_ARTIST_SPLIT_RE.test(artistStr)) {
      artistList = artistStr.split(LOCAL_ARTIST_SPLIT_RE);
    } else if (LOCAL_ARTIST_DOUBLE_SPACE_RE.test(artistStr)) {
      artistList = artistStr.split(LOCAL_ARTIST_DOUBLE_SPACE_RE);
    } else {
      artistList = [artistStr];
    }
  }

  artistList = artistList.map((item) => item.trim()).filter(Boolean);
  if (artistList.length === 0) {
    artistList = ["未知艺术家"];
  }

  return {
    id: `local-${file.id}`,
    name: trackName || "未知歌曲",
    artist: artistList,
    album: album || "",
    pic_id: file.localPath,
    url_id: file.localPath,
    lyric_id: file.localPath,
    source: "local" as MusicSource,
  };
};

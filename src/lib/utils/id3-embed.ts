import { ID3Writer } from "browser-id3-writer";

/** ImageType.CoverFront = 3，因 isolatedModules 禁用 const enum，直接用数值 */
const APIC_TYPE_COVER_FRONT = 3;
import { musicApi } from "@/lib/music-api";
import { logger } from "@/lib/logger";
import type { MusicTrack } from "@/types/music";

export const MAX_EMBED_SIZE = 60 * 1024 * 1024; // 60MB

const MP3_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
]);

interface EmbedResult {
  arrayBuffer: ArrayBuffer;
  coverEmbedded: boolean;
  lyricEmbedded: boolean;
}

export async function embedMetadata(
  mp3Buffer: ArrayBuffer,
  track: MusicTrack,
  options: { embedCover: boolean; embedLyric: boolean }
): Promise<EmbedResult> {
  const { embedCover, embedLyric } = options;

  if (!embedCover && !embedLyric) {
    return {
      arrayBuffer: mp3Buffer,
      coverEmbedded: false,
      lyricEmbedded: false,
    };
  }

  // 检查是否为 MP3 格式（通过检查文件头）
  const isMp3 = isMp3Buffer(mp3Buffer);
  if (!isMp3) {
    logger.warn("id3-embed", `跳过非 MP3 格式的元数据嵌入`);
    return {
      arrayBuffer: mp3Buffer,
      coverEmbedded: false,
      lyricEmbedded: false,
    };
  }

  if (mp3Buffer.byteLength > MAX_EMBED_SIZE) {
    logger.warn("id3-embed", `文件过大 (${(mp3Buffer.byteLength / 1024 / 1024).toFixed(1)}MB)，跳过元数据嵌入`);
    return {
      arrayBuffer: mp3Buffer,
      coverEmbedded: false,
      lyricEmbedded: false,
    };
  }

  const writer = new ID3Writer(mp3Buffer);

  let coverEmbedded = false;
  let lyricEmbedded = false;

  // 写入基本标签
  writer.setFrame("TIT2", track.name);
  writer.setFrame("TPE1", track.artist ?? []);
  if (track.album) writer.setFrame("TALB", track.album);

  if (embedCover) {
    const coverData = await fetchCoverData(track);
    if (coverData) {
      writer.setFrame("APIC", {
        type: APIC_TYPE_COVER_FRONT,
        data: coverData.buffer,
        description: "Cover",
      });
      coverEmbedded = true;
    }
  }

  if (embedLyric) {
    const lyricText = await fetchLyricText(track);
    if (lyricText) {
      writer.setFrame("USLT", {
        description: "Lyrics",
        language: "zho",
        lyrics: lyricText,
      });
      lyricEmbedded = true;
    }
  }

  const arrayBuffer = writer.addTag();

  return {
    arrayBuffer,
    coverEmbedded,
    lyricEmbedded,
  };
}

function isMp3Buffer(buffer: ArrayBuffer): boolean {
  // MP3 文件以 ID3 标签或 MPEG 同步字开头
  const bytes = new Uint8Array(buffer.slice(0, 4));
  
  // ID3v2 标签：49 44 33 (ID3)
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  
  // MPEG 同步字：0xFF 0xFB 或 0xFF 0xFA 或 0xFF 0xF3 或 0xFF 0xF2
  if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) {
    return true;
  }
  
  return false;
}

async function fetchCoverData(track: MusicTrack): Promise<Uint8Array | null> {
  try {
    const picUrl = await musicApi.getPic(track.pic_id || track.id, track.source);
    if (!picUrl) return null;
    const res = await fetch(picUrl);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    logger.warn("id3-embed", "获取封面失败", e);
    return null;
  }
}

async function fetchLyricText(track: MusicTrack): Promise<string | null> {
  try {
    const result = await musicApi.getLyric(track.lyric_id || track.id, track.source);
    if (!result) return null;
    const lines = [result.lyric, result.tlyric].filter(Boolean);
    return lines.join("\n\n");
  } catch (e) {
    logger.warn("id3-embed", "获取歌词失败", e);
    return null;
  }
}

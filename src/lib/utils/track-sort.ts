import { MusicTrack } from "@/types/music";

export type SortField = "name" | "artist" | "size";
export type SortDirection = "asc" | "desc";

export interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

const getFirstArtist = (track: MusicTrack): string => {
  if (!track.artist || track.artist.length === 0) return "";
  return track.artist[0] || "";
};

const getTrackSize = (track: MusicTrack): number => {
  if ("fileSize" in track) {
    return (track as any).fileSize || 0;
  }
  return 0;
};

export function sortTracks(
  tracks: MusicTrack[],
  sortConfig: SortConfig | null
): MusicTrack[] {
  if (!sortConfig) return tracks;

  const { field, direction } = sortConfig;
  const multiplier = direction === "asc" ? 1 : -1;

  return [...tracks].sort((a, b) => {
    let comparison = 0;

    switch (field) {
      case "name":
        comparison = a.name.localeCompare(b.name, "zh-CN");
        break;
      case "artist":
        comparison = getFirstArtist(a).localeCompare(getFirstArtist(b), "zh-CN");
        break;
      case "size":
        comparison = getTrackSize(a) - getTrackSize(b);
        break;
      default:
        return 0;
    }

    return comparison * multiplier;
  });
}

import { MarketPlaylist } from "@/lib/netease/netease-types";
import { MusicCover } from "@/components/MusicCover";

interface PlaylistGridProps {
  list: MarketPlaylist[];
  onClick: (id: string) => void;
}

export const PlaylistGrid = ({ list, onClick }: PlaylistGridProps) => (
  <div className="grid grid-cols-2 max-sm:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-2.5 gap-y-3 w-full">
    {list.map((item) => (
      <div 
        key={item.id} 
        className="group flex flex-col gap-2 transition-all hover:translate-y-[-4px] w-full" 
        onClick={() => onClick(item.id)}
      >
        <div className="relative aspect-square rounded-md overflow-hidden shadow-md ring-1 ring-black/5 hover:shadow-xl transition-shadow cursor-pointer w-full">
          <MusicCover 
            src={item.coverUrl} 
            alt={item.name} 
            className="transition-transform duration-500 group-hover:scale-110 w-full" 
          />
        </div>
        <div className="px-0.5 w-full overflow-hidden">
          <h3 className="text-[12px] font-medium leading-snug line-clamp-2 text-foreground/80 group-hover:text-primary transition-colors cursor-pointer">
            {item.name}
          </h3>
        </div>
      </div>
    ))}
  </div>
);

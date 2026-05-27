import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { PopBanner, type BannerType } from "../components/ui/PopBanner";

interface BannerMessage {
  id: string;
  message: string;
  type: BannerType;
  duration?: number;
}

interface BannerContextType {
  showBanner: (message: string, type?: BannerType, duration?: number) => void;
}

const BannerContext = createContext<BannerContextType | undefined>(undefined);

export function BannerProvider({ children }: { children: ReactNode }) {
  const [banners, setBanners] = useState<BannerMessage[]>([]);

  const showBanner = useCallback((message: string, type: BannerType = "info", duration = 3000) => {
    const id = Math.random().toString(36).substring(2, 9);
    setBanners((prev) => [...prev, { id, message, type, duration }]);
  }, []);

  const removeBanner = useCallback((id: string) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
  }, []);

  return (
    <BannerContext.Provider value={{ showBanner }}>
      {children}
      {/* Container for stacked banners if multiple occur */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[10001] flex flex-col gap-2 pointer-events-none">
        <AnimatePresence>
          {banners.map((b) => (
            <div key={b.id} className="pointer-events-auto">
              <PopBanner
                message={b.message}
                type={b.type}
                duration={b.duration}
                onClose={() => removeBanner(b.id)}
              />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </BannerContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBanner() {
  const context = useContext(BannerContext);
  if (!context) {
    throw new Error("useBanner must be used within a BannerProvider");
  }
  return context;
}

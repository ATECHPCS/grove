import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, CheckCircle2, AlertCircle, Info } from "lucide-react";

export type BannerType = "success" | "error" | "info";

interface PopBannerProps {
  message: string;
  type?: BannerType;
  duration?: number;
  onClose: () => void;
}

export function PopBanner({ message, type = "info", duration = 3000, onClose }: PopBannerProps) {
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    if (isHovered) return;
    const timer = setTimeout(onClose, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose, isHovered]);

  const icons = {
    success: <CheckCircle2 className="w-4 h-4 text-[var(--color-success)]" />,
    error: <AlertCircle className="w-4 h-4 text-[var(--color-error)]" />,
    info: <Info className="w-4 h-4 text-[var(--color-highlight)]" />,
  };

  const borderColors = {
    success: "var(--color-success)",
    error: "var(--color-error)",
    info: "var(--color-highlight)",
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -20, x: "-50%" }}
      animate={{ opacity: 1, y: 0, x: "-50%" }}
      exit={{ opacity: 0, y: -20, x: "-50%" }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="fixed top-4 left-1/2 z-[10001] min-w-[300px] max-w-md shadow-2xl rounded-xl border bg-[var(--color-bg-secondary)] overflow-hidden"
      style={{ borderColor: borderColors[type] }}
    >
      <div className="px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1">
          {icons[type]}
          <p className="text-xs font-semibold text-[var(--color-text)] leading-tight">{message}</p>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors text-[var(--color-text-muted)]"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* Progress bar for auto-dismiss */}
      {!isHovered && (
        <motion.div
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={{ duration: duration / 1000, ease: "linear" }}
          className="h-0.5 origin-left"
          style={{ backgroundColor: borderColors[type] }}
        />
      )}
    </motion.div>
  );
}

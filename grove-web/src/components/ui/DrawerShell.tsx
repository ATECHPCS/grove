import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import { useEffect } from "react";

interface DrawerShellProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
  zIndex?: number;
}

/** Shared viewport-level drawer used for object details and management. */
export function DrawerShell({ isOpen, onClose, children, width = "w-[520px]", zIndex = 50 }: DrawerShellProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {isOpen && <>
        <motion.button
          type="button"
          aria-label="Close drawer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/30"
          style={{ zIndex }}
        />
        <motion.aside
          role="dialog"
          aria-modal="true"
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", damping: 30, stiffness: 300 }}
          className={`fixed bottom-0 right-0 top-0 flex max-w-[90vw] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl ${width}`}
          style={{ zIndex }}
        >
          {children}
        </motion.aside>
      </>}
    </AnimatePresence>,
    document.body,
  );
}

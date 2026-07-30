import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";

interface DropdownItem {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  children?: DropdownItem[];
  variant?: "default" | "warning" | "danger";
  disabled?: boolean;
}

interface DropdownMenuProps {
  items: DropdownItem[];
  trigger?: React.ReactNode;
  align?: "left" | "right";
  triggerClassName?: string;
  ariaLabel?: string;
  /** Match the compact, viewport-aware New Session picker surface. */
  portal?: boolean;
  compact?: boolean;
}

export function DropdownMenu({
  items,
  trigger,
  align = "right",
  triggerClassName,
  ariaLabel = "More actions",
  portal = false,
  compact = false,
}: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeSubmenuId, setActiveSubmenuId] = useState<string | null>(null);
  const [portalAnchor, setPortalAnchor] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeSubmenu = items.find(
    (item) => item.id === activeSubmenuId && item.children?.length,
  );
  const visibleItems = activeSubmenu?.children ?? items;

  const closeMenu = () => {
    setIsOpen(false);
    setActiveSubmenuId(null);
  };

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (activeSubmenuId) {
          setActiveSubmenuId(null);
        } else {
          closeMenu();
        }
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [activeSubmenuId, isOpen]);

  useEffect(() => {
    if (!isOpen || !portal) return;
    const close = () => closeMenu();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [isOpen, portal]);

  const getVariantClass = (variant: DropdownItem["variant"]) => {
    switch (variant) {
      case "warning":
        return "text-[var(--color-warning)] hover:bg-[var(--color-warning)]/10";
      case "danger":
        return "text-[var(--color-error)] hover:bg-[var(--color-error)]/10";
      default:
        return "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]";
    }
  };

  const openMenu = () => {
    if (portal && triggerRef.current) {
      const viewportMargin = 8;
      const menuWidth = 192;
      const menuMaxHeight = 256;
      const rect = triggerRef.current.getBoundingClientRect();
      setPortalAnchor({
        top: Math.max(
          viewportMargin,
          Math.min(
            rect.top,
            window.innerHeight - menuMaxHeight - viewportMargin,
          ),
        ),
        left: Math.max(
          viewportMargin,
          Math.min(
            rect.right + viewportMargin,
            window.innerWidth - menuWidth - viewportMargin,
          ),
        ),
      });
    }
    setIsOpen(true);
  };

  const menuItems = (
    <>
      {activeSubmenu && (
        <button
          type="button"
          onClick={() => setActiveSubmenuId(null)}
          className={`flex w-full items-center rounded-t-[7px] border-b border-[var(--color-border)] text-left font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] ${
            compact
              ? "gap-2 px-2.5 py-1.5 text-[12.5px]"
              : "gap-2 px-3 py-1.5 text-sm"
          }`}
        >
          <ChevronLeft className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          <span>{activeSubmenu.label}</span>
        </button>
      )}
      {visibleItems.map((item) => {
        const Icon = item.icon;
        const hasChildren = !!item.children?.length;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              if (!item.disabled) {
                if (hasChildren) {
                  setActiveSubmenuId(item.id);
                } else {
                  item.onClick?.();
                  closeMenu();
                }
              }
            }}
            disabled={item.disabled}
            className={`w-full flex items-center text-left transition-colors focus:outline-none ${
              compact
                ? "gap-2 px-2.5 py-1.5 text-[12.5px]"
                : "gap-2 px-3 py-1.5 text-sm"
            } ${getVariantClass(item.variant)} ${
              item.disabled ? "opacity-50 cursor-not-allowed" : ""
            }`}
          >
            {Icon && (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
              </span>
            )}
            <span className="min-w-0 flex-1">{item.label}</span>
            {hasChildren && (
              <ChevronRight
                className={compact ? "h-3.5 w-3.5" : "h-4 w-4"}
              />
            )}
          </button>
        );
      })}
    </>
  );

  return (
    <div className="relative">
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (isOpen) closeMenu();
          else openMenu();
        }}
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        className={
          triggerClassName ??
          "flex items-center justify-center p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
        }
      >
        {trigger || <MoreHorizontal className="w-4 h-4" />}
      </button>

      {/* Dropdown */}
      {!portal && (
        <AnimatePresence>
          {isOpen && (
          <motion.div
            ref={menuRef}
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className={`absolute z-50 mt-1 ${activeSubmenu ? "min-w-[220px]" : "min-w-[140px]"} py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            {menuItems}
          </motion.div>
          )}
        </AnimatePresence>
      )}
      {portal &&
        isOpen &&
        portalAnchor &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: portalAnchor.top,
              left: portalAnchor.left,
              zIndex: 1000,
            }}
            className="w-48 max-h-64 overflow-x-hidden overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg"
          >
            {menuItems}
          </div>,
          document.body,
        )}
    </div>
  );
}

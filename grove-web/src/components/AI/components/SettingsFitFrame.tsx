import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function SettingsFitFrame({ children }: { children: ReactNode }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content) return;

    let animationFrame = 0;
    const measure = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const availableHeight = frame.clientHeight;
        const contentHeight = content.scrollHeight;
        if (availableHeight <= 0 || contentHeight <= 0) return;
        const next = Math.min(1, availableHeight / contentHeight);
        const rounded = Math.floor(next * 1000) / 1000;
        setScale((current) => Math.abs(current - rounded) > 0.002 ? rounded : current);
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(content);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div ref={frameRef} className="h-full min-h-0 overflow-hidden" data-settings-fit-scale={scale.toFixed(3)}>
      <div ref={contentRef} className="origin-top-left" style={{ width: scale < 0.999 ? `${100 / scale}%` : "100%", transform: scale < 0.999 ? `scale(${scale})` : undefined }}>
        {children}
      </div>
    </div>
  );
}

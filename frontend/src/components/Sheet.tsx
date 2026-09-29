// A right-hand sheet for details that should not crowd the console: evidence, recall, the action log.
import { useEffect, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";

export default function Sheet({ open, title, onClose, children, width = "max-w-xl" }: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-30 bg-black/60 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            aria-label={typeof title === "string" ? title : undefined}
            className={`panel fixed right-2 top-2 z-40 flex h-[calc(100%-1rem)] w-full ${width} flex-col overflow-hidden !rounded-[20px] !bg-[#0c0c0c]`}
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
          >
            <header className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
              <h2 className="text-sm font-semibold text-ink">{title}</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost !p-1.5">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

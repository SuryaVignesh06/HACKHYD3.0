import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BrainCircuit } from "lucide-react";

export default function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDone, 5000);
    return () => window.clearTimeout(timer);
  }, [message, onDone]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center">
      <AnimatePresence>
        {message && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.2 }}
            className="glass-strong flex items-center gap-2 rounded-2xl !border-memory/40 px-4 py-2.5 text-sm text-ink"
          >
            <BrainCircuit className="h-4 w-4 text-memory" aria-hidden="true" />
            {message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

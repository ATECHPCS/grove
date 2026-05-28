import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowRight, GitBranch, Terminal, Layers } from "lucide-react";
import { getVersion } from "../../api";
import { GroveIcon } from "../Layout/GroveIcon";
import { GroveWordmark } from "../Layout/GroveWordmark";

interface WelcomePageProps {
  onGetStarted: () => void;
}

export function WelcomePage({ onGetStarted }: WelcomePageProps) {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getVersion()
      .then((res) => setVersion(res.version))
      .catch(() => {});
  }, []);
  const isRemote = typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>).__GROVE_REMOTE__;

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: "easeInOut" }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)]"
    >
      {/* Animated background gradient */}
      <div className="absolute inset-0 overflow-hidden">
        <motion.div
          animate={{
            scale: [1, 1.2, 1],
            opacity: [0.2, 0.3, 0.2],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut",
          }}
          className="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-[var(--color-highlight)] via-transparent to-transparent rounded-full blur-3xl"
        />
        <motion.div
          animate={{
            scale: [1.2, 1, 1.2],
            opacity: [0.2, 0.3, 0.2],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut",
          }}
          className="absolute -top-1/2 -right-1/2 w-full h-full bg-gradient-to-bl from-[var(--color-highlight)] via-transparent to-transparent rounded-full blur-3xl"
        />
      </div>
      <div className="relative flex flex-col items-center text-center max-w-lg px-6">
        {/* Main Icon with complex glow */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{
            type: "spring",
            stiffness: 100,
            damping: 15,
            delay: 0.2,
          }}
          className="relative mb-8"
        >
          <div className="absolute -inset-4 bg-gradient-to-r from-emerald-500/20 to-teal-500/20 rounded-full blur-3xl opacity-75 animate-pulse" />
          <motion.div
            animate={{
              y: [0, -10, 0],
            }}
            transition={{
              duration: 6,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          >
            <motion.div
              className="relative"
              initial={{ rotate: -10 }}
              animate={{ rotate: 0 }}
              transition={{ delay: 0.15, duration: 1.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <GroveIcon size={160} background shimmer className="rounded-3xl" />
              {isRemote && (
                <span className="absolute bottom-2.5 right-2.5 px-2 py-0.75 text-[9px] font-black uppercase tracking-widest rounded-lg bg-[var(--color-highlight)]/10 text-[var(--color-highlight)] border border-[var(--color-highlight)]/20 backdrop-blur-md shadow-sm shadow-[var(--color-highlight)]/5 select-none">
                  Remote
                </span>
              )}
            </motion.div>
          </motion.div>
        </motion.div>

        {/* Title with shimmer effect */}
        <motion.h1
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 1.0, duration: 0.5 }}
          className="text-7xl font-black mb-4 tracking-tight relative"
        >
          <GroveWordmark height={72} />
        </motion.h1>

        {/* Tagline */}
        <motion.p
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 1.2, duration: 0.5 }}
          className="text-xl text-[var(--color-text-muted)] mb-8 max-w-md"
        >
          Parallel AI coding workflows with Git worktrees
        </motion.p>

        {/* Features */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 1.4, duration: 0.5 }}
          className="flex gap-8 mb-12"
        >
          <Feature icon={GitBranch} label="Git Worktrees" delay={1.5} />
          <Feature icon={Terminal} label="Tmux Sessions" delay={1.6} />
          <Feature icon={Layers} label="Task Management" delay={1.7} />
        </motion.div>

        {/* Get Started Button */}
        <motion.button
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 1.8, duration: 0.5 }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onGetStarted}
          className="group relative flex items-center gap-3 px-8 py-4 bg-gradient-to-r from-[var(--color-highlight)] to-[var(--color-accent)] text-white font-semibold text-lg rounded-2xl shadow-xl shadow-[var(--color-highlight)]/30 hover:shadow-2xl hover:shadow-[var(--color-highlight)]/40 transition-shadow overflow-hidden"
        >
          {/* Button shimmer */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
          <span className="relative">Get Started</span>
          <ArrowRight className="relative w-5 h-5 group-hover:translate-x-1 transition-transform" />
        </motion.button>

        {/* Version */}
        {version && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2.0, duration: 0.5 }}
            className="mt-8 text-sm text-[var(--color-text-muted)]"
          >
            v{version}
          </motion.p>
        )}
      </div>

      {/* CSS for shimmer animation */}
      <style>{`
        @keyframes shimmer {
          0% { background-position: 100% 50%; }
          100% { background-position: -100% 50%; }
        }
        .animate-shimmer {
          animation: shimmer 3s ease-in-out infinite;
        }
      `}</style>
    </motion.div>
  );
}

function Feature({ icon: Icon, label, delay }: { icon: typeof GitBranch; label: string; delay: number }) {
  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ delay, duration: 0.4 }}
      className="flex flex-col items-center gap-2 cursor-default"
    >
      <motion.div
        whileHover={{ y: -4 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex flex-col items-center gap-2"
      >
        <div className="w-14 h-14 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex items-center justify-center hover:border-[var(--color-highlight)]/50 hover:bg-[var(--color-highlight)]/5 transition-colors">
          <Icon className="w-7 h-7 text-[var(--color-highlight)]" />
        </div>
        <span className="text-sm text-[var(--color-text-muted)]">{label}</span>
      </motion.div>
    </motion.div>
  );
}

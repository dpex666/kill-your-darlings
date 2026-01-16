import React from "react";

type SupportBuildProps = {
  /**
   * Optional override.
   * If not provided, defaults to PayPal support link.
   */
  href?: string;
  projectName?: string;
};

const DEFAULT_SUPPORT_URL = "https://paypal.me/xtenzz";

export default function SupportBuild({
  href = DEFAULT_SUPPORT_URL,
  projectName,
}: SupportBuildProps) {
  const subject = projectName ? `${projectName} is` : "This tool is";

  return (
    <section className="relative mt-6 rounded-2xl border border-zinc-800/80 bg-zinc-950/35 p-5 text-sm text-zinc-300 backdrop-blur">
      {/* subtle accent line */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-300">
            Support the build
          </div>

          <p className="mt-2 max-w-xl text-sm text-zinc-300">
            {subject} free and built in public. If it helped you think clearer or
            ship something real, you can support future experiments here.
          </p>
        </div>

        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="
            inline-flex items-center justify-center
            rounded-full px-5 py-2.5
            text-xs font-semibold uppercase tracking-wide
            text-emerald-100
            border border-emerald-400/50
            bg-emerald-400/10
            transition
            hover:border-emerald-300/80
            hover:bg-emerald-400/15
            hover:shadow-[0_0_24px_rgba(16,185,129,0.25)]
            active:scale-[0.98]
          "
        >
          Support this experiment
        </a>
      </div>
    </section>
  );
}

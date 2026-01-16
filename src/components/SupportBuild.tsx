import React from "react";

type SupportBuildProps = {
  href: string;
  projectName?: string;
};

export default function SupportBuild({ href, projectName }: SupportBuildProps) {
  const subject = projectName ? `${projectName} is` : "This tool is";

  return (
    <section className="mt-4 rounded-2xl border border-zinc-800/70 bg-zinc-900/20 p-4 text-sm text-zinc-300 shadow-[0_0_0_1px_rgba(255,255,255,0.03)] backdrop-blur">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">
            Support the build
          </div>
          <p className="mt-2 max-w-xl text-sm text-zinc-400">
            {subject} free and built in public. If it helped you think clearer or ship something real, you can support
            future builds here.
          </p>
        </div>
        <a
          className="inline-flex items-center justify-center rounded-full border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-emerald-100 transition hover:border-emerald-300/70 hover:text-emerald-50"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          Support future builds
        </a>
      </div>
    </section>
  );
}

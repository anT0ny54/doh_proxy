"use client";

import { useState } from "react";

export default function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="min-h-11 shrink-0 rounded-xl border border-zinc-300 bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 active:scale-[0.99]"
      aria-label="Copy public DoH endpoint"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copied" | "failed";

async function writeClipboard(value: string): Promise<boolean> {
  try {
    // Unavailable on non-secure origins (e.g. http://<lan-ip>).
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export default function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await writeClipboard(value);
    setStatus(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus("idle"), 1600);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="min-h-11 shrink-0 rounded-xl border border-zinc-300 bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 active:scale-[0.99]"
      aria-label={label}
    >
      {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

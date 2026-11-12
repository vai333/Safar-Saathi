"use client";
import { Download } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/primitives";

/** "Select this trip": creates a draft and starts the offline bundle now, before any payment. */
export function SelectTrip({ slug, startDate, pax, className }: { slug: string; startDate: string; pax: number; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/trips/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, startDate, pax }) });
      if (r.status === 401) { router.push(`/login?next=${encodeURIComponent(`/itinerary/${slug}?start=${startDate}&pax=${pax}`)}`); return; }
      const j = await r.json().catch(() => ({ message: "The server took too long. Please tap Select this trip again." }));
      if (!r.ok) { setErr(j.message ?? "Could not select this trip."); setBusy(false); return; }
      router.push(`/trips/${j.ref}?setup=1`);
    } catch { setErr("No connection. Selecting a trip needs data once, so it can be saved on your phone."); setBusy(false); }
  };
  return (
    <div className={className}>
      <Button variant="primary" size="lg" onClick={go} disabled={busy} data-testid="select-btn"><Download size={18} /> {busy ? "Preparing your guide…" : "Select this trip"}</Button>
      {err && <p role="alert" className="mt-2 text-[14px] text-danger">{err}</p>}
    </div>
  );
}

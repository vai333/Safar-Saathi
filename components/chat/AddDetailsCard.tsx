"use client";
import { CheckCircle2, Hotel, Plane } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/primitives";

export type DetailsPart = {
  t: "details";
  bookingRef: string;
  kind: "flight" | "hotel";
  prefill: { airline?: string; flightNo?: string; from?: string; to?: string; departLocal?: string; arriveLocal?: string; pnr?: string; name?: string; address?: string; city?: string; checkin?: string; checkout?: string; phone?: string };
};

const field = "mt-1 min-h-12 w-full rounded-xl border-[1.5px] border-line bg-surface-2 px-3 text-[16px] text-ink";
const dt = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 16) : "");
const d = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");

/** A form to add a flight or hotel that is missing from the trip. The traveller checks it and taps Save: the agent never saves it. */
export function AddDetailsCard({ part, online, onSaved }: { part: DetailsPart; online: boolean; onSaved: (summary: string, kind: "flight" | "hotel") => void }) {
  const [kind, setKind] = useState(part.kind);
  const f = part.prefill;
  const [airline, setAirline] = useState(f.airline ?? "");
  const [flightNo, setFlightNo] = useState(f.flightNo ?? "");
  const [from, setFrom] = useState(f.from ?? "");
  const [to, setTo] = useState(f.to ?? "");
  const [depart, setDepart] = useState(dt(f.departLocal));
  const [arrive, setArrive] = useState(dt(f.arriveLocal));
  const [pnr, setPnr] = useState(f.pnr ?? "");
  const [name, setName] = useState(f.name ?? "");
  const [address, setAddress] = useState(f.address ?? "");
  const [city, setCity] = useState(f.city ?? "");
  const [checkin, setCheckin] = useState(d(f.checkin));
  const [checkout, setCheckout] = useState(d(f.checkout));
  const [phone, setPhone] = useState(f.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const body = kind === "flight"
      ? { kind, airline, flightNo, from, to, departLocal: depart, arriveLocal: arrive, ...(pnr ? { pnr } : {}) }
      : { kind, name, address, city, checkin, checkout, ...(phone ? { phone } : {}) };
    try {
      const r = await fetch(`/api/trips/${part.bookingRef}/details`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({ message: "The server took too long. Check your trip in a moment, then try again if it is not there." }));
      if (!r.ok) { setErr(j.message ?? "Could not save. Check the details and try again."); return; }
      setSaved(j.summary);
      onSaved(j.summary, kind);
    } catch {
      setErr("No connection. Nothing was saved. Try again when you have data.");
    } finally {
      setBusy(false);
    }
  };

  if (saved) {
    return <section data-testid="details-saved" className="card flex items-start gap-3 border-ok p-4"><CheckCircle2 className="mt-0.5 shrink-0 text-ok" size={22} /><div><p className="font-semibold">Saved to your trip</p><p className="text-[15px]">{saved}</p></div></section>;
  }
  return (
    <section data-testid="details-card" className="card space-y-3 p-4">
      <h3 className="flex items-center gap-2 text-[20px] font-semibold">{kind === "flight" ? <Plane size={20} className="text-accent" /> : <Hotel size={20} className="text-accent" />} Add {kind === "flight" ? "a flight" : "a hotel"}</h3>
      <div className="grid grid-cols-2 gap-1 rounded-full border border-line bg-surface-2 p-1" role="group" aria-label="What to add">
        {(["flight", "hotel"] as const).map((k) => <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k} data-testid={`details-kind-${k}`} className={`min-h-11 rounded-full px-3 text-[15px] font-semibold ${kind === k ? "bg-lime text-lime-ink" : "text-muted"}`}>{k === "flight" ? "Flight" : "Hotel"}</button>)}
      </div>
      <form onSubmit={submit} className="space-y-3">
        {kind === "flight" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-[15px] text-muted">Airline<input required value={airline} onChange={(e) => setAirline(e.target.value)} placeholder="IndiGo" autoComplete="off" maxLength={60} className={field} data-testid="df-airline" /></label>
              <label className="block text-[15px] text-muted">Flight number<input required value={flightNo} onChange={(e) => setFlightNo(e.target.value)} placeholder="6E 1234" autoCapitalize="characters" autoComplete="off" maxLength={10} className={`${field} font-mono`} data-testid="df-flightno" /></label>
              <label className="block text-[15px] text-muted">From (airport code)<input required value={from} onChange={(e) => setFrom(e.target.value.toUpperCase())} placeholder="DEL" pattern="[A-Za-z]{3}" maxLength={3} autoCapitalize="characters" autoComplete="off" className={`${field} font-mono`} data-testid="df-from" /></label>
              <label className="block text-[15px] text-muted">To (airport code)<input required value={to} onChange={(e) => setTo(e.target.value.toUpperCase())} placeholder="SGN" pattern="[A-Za-z]{3}" maxLength={3} autoCapitalize="characters" autoComplete="off" className={`${field} font-mono`} data-testid="df-to" /></label>
              <label className="block text-[15px] text-muted">Departs (local time there)<input required type="datetime-local" value={depart} onChange={(e) => setDepart(e.target.value)} className={field} data-testid="df-depart" /></label>
              <label className="block text-[15px] text-muted">Arrives (local time there)<input required type="datetime-local" value={arrive} onChange={(e) => setArrive(e.target.value)} className={field} data-testid="df-arrive" /></label>
            </div>
            <label className="block text-[15px] text-muted">Booking code, PNR (optional)<input value={pnr} onChange={(e) => setPnr(e.target.value)} maxLength={12} autoCapitalize="characters" autoComplete="off" className={`${field} font-mono`} data-testid="df-pnr" /></label>
          </>
        ) : (
          <>
            <label className="block text-[15px] text-muted">Hotel name<input required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="off" className={field} data-testid="df-name" /></label>
            <label className="block text-[15px] text-muted">Address<input required value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} autoComplete="off" className={field} data-testid="df-address" /></label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-[15px] text-muted">City<input required value={city} onChange={(e) => setCity(e.target.value)} maxLength={60} autoComplete="off" className={field} data-testid="df-city" /></label>
              <label className="block text-[15px] text-muted">Check-in<input required type="date" value={checkin} onChange={(e) => setCheckin(e.target.value)} className={field} data-testid="df-checkin" /></label>
              <label className="block text-[15px] text-muted">Check-out<input required type="date" value={checkout} min={checkin} onChange={(e) => setCheckout(e.target.value)} className={field} data-testid="df-checkout" /></label>
            </div>
            <label className="block text-[15px] text-muted">Hotel phone (optional, for your offline guide)<input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+84 …" autoComplete="off" className={field} data-testid="df-phone" /></label>
          </>
        )}
        {err && <p role="alert" className="text-danger" data-testid="df-error">{err}</p>}
        <Button type="submit" variant="primary" size="lg" block disabled={busy || !online} data-testid="df-submit">{busy ? "Saving and updating your guide…" : "Save to my trip"}</Button>
        <p className="text-[13px] text-muted">{online ? "This only adds details you already have. Nothing is booked or paid. Your offline guide, map and SOS are updated." : "You are offline. Adding details needs data."}</p>
      </form>
    </section>
  );
}

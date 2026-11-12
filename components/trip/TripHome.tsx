"use client";
import { Car, Clock, Hotel, MapPin, Phone, Plane, Printer, Sun } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { TripGate } from "./TripGate";
import { useTrip } from "./TripProvider";
import { OfflineStatus } from "./OfflineStatus";
import { DayPlan } from "./DayPlan";
import { TripHero } from "./TripHero";
import { Badge, Card, LinkButton, SectionTitle } from "@/components/ui/primitives";
import { InstallPrompt } from "@/components/ui/InstallPrompt";
import { nextItem, pickupItem, relTime, telHref } from "@/lib/trip/derive";
import { currentStay } from "@/lib/rules/context";
import { fmtDate, fmtTimeZ, inr, localTime, tzLabel } from "@/lib/time";

export function TripHome() {
  return <TripGate>{(pack) => <Inner pack={pack} />}</TripGate>;
}

function Inner({ pack }: { pack: import("@/lib/packs/types").OfflinePack }) {
  const t = useTrip();
  const { now } = t;
  const stay = currentStay(pack, now);
  const hotel = pack.places[stay.hotelId];
  const { item: next, status } = nextItem(pack, now);
  const { item: pu } = pickupItem(pack, now);
  const [weather, setWeather] = useState<{ tempC: number | null; summary: string } | null>(null);
  useEffect(() => {
    if (t.net !== "online") return;
    fetch(`/api/weather?lat=${hotel.lat}&lon=${hotel.lon}`).then((r) => (r.ok ? r.json() : null)).then(setWeather).catch(() => {});
  }, [t.net, hotel.lat, hotel.lon]);

  return (
    <div className="space-y-5">
      <TripHero pack={pack} now={now} />
      <div>
        <p className="text-[15px] text-muted">{fmtDate(pack.booking.dates[0])} to {fmtDate(pack.booking.dates[1], true)} · {pack.booking.pax} travellers · <span className="font-mono">{pack.booking.ref}</span></p>
        <h1 className="mt-1 text-[32px] font-bold leading-tight">{pack.booking.title}</h1>
      </div>

      {pack.booking.status === "draft" && (
        <Card className="space-y-3 border-warn" data-testid="draft-banner">
          <p className="flex items-center gap-2 text-[17px] font-semibold"><Badge tone="warn">Draft · not paid yet</Badge></p>
          <p className="text-[15px]">You selected this trip. Your offline guide is already saved on this phone. Book it when you are ready: payment confirms the booking and unlocks changes through the agent.</p>
          <LinkButton href={`/checkout?ref=${pack.booking.ref}`} variant="primary" data-testid="book-trip">Book this trip · {inr(pack.booking.totalInr)}</LinkButton>
        </Card>
      )}
      <OfflineStatus />
      {(pack.flights.length === 0 || pack.stays.every((st) => pack.places[st.hotelId]?.kind !== "hotel")) && pack.booking.status !== "draft" && (
        <Card className="space-y-3 border-lime" data-testid="missing-details">
          <h2 className="text-[17px] font-semibold">Add your missing details</h2>
          <p className="text-[15px]">{pack.flights.length === 0 && pack.stays.every((st) => pack.places[st.hotelId]?.kind !== "hotel") ? "Your trip has no flight or hotel yet." : pack.flights.length === 0 ? "Your trip has no flight yet." : "Your trip has no hotel yet."} Add {pack.flights.length === 0 ? "them" : "it"} now or later. Your day plan, map and guide update when you save.</p>
          <div className="flex flex-wrap gap-2">
            {pack.flights.length === 0 && <LinkButton href={`/trips/${pack.booking.ref}/chat?add=flight`} size="md" data-testid="add-flight">Add flight</LinkButton>}
            {pack.stays.every((st) => pack.places[st.hotelId]?.kind !== "hotel") && <LinkButton href={`/trips/${pack.booking.ref}/chat?add=hotel`} size="md" data-testid="add-hotel">Add hotel</LinkButton>}
          </div>
        </Card>
      )}

      <Card className="space-y-2" data-testid="next-plan">
        <div className="flex items-center justify-between"><h2 className="flex items-center gap-2 text-[17px] font-semibold"><Plane size={20} strokeWidth={1.75} className="text-accent" /> {status === "before" ? "Your trip starts with" : status === "after" ? "Trip finished" : "Next plan"}</h2>{next && <Badge>{relTime(next.at, now)}</Badge>}</div>
        {next ? (
          <>
            <p className="text-[24px] font-semibold leading-snug">{next.time} · {next.title}</p>
            <p className="text-muted">{fmtDate(next.date)} · {next.cityName} · {tzLabel(next.at, next.tz)}</p>
            {next.notes && <p className="text-[15px]">{next.notes}</p>}
          </>
        ) : <p className="text-muted">Nothing left on your plan. We hope the trip was great.</p>}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="space-y-2" data-testid="pickup-card">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Car size={20} strokeWidth={1.75} className="text-accent" /> Your pickup</h2>
          <p className="text-[22px] font-semibold">{pu ? `Your pickup is at ${pu.time}` : stay.driver.pickup_time}</p>
          <p className="text-[15px] text-muted">{pu ? `${fmtDate(pu.date)}, ${stay.cityName}. ` : ""}Driver {stay.driver.name}, {stay.driver.vendor}</p>
          <div className="rounded-xl border-[1.5px] border-line bg-surface-2 p-3"><p className="text-[13px] text-muted">Show this pickup code</p><p className="font-mono text-[28px] font-semibold tracking-widest">{stay.driver.pickup_code}</p></div>
          <LinkButton href={telHref(stay.driver.phone)} size="md"><Phone size={18} /> Call driver <span className="text-[13px] font-normal text-muted">(sample number)</span></LinkButton>
        </Card>
        <Card className="space-y-2" data-testid="hotel-card">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Hotel size={20} strokeWidth={1.75} className="text-accent" /> Your hotel</h2>
          <p className="text-[22px] font-semibold leading-snug">{hotel.name}</p>
          <p className="text-[15px]">{hotel.address}</p>
          <p className="text-[15px] text-muted">Check in {fmtDate(stay.from)} · out {fmtDate(stay.to)}</p>
          <div className="flex flex-wrap gap-2">
            <LinkButton href={telHref(hotel.phone ?? "")} size="md"><Phone size={18} /> Call</LinkButton>
            <LinkButton href={`/trips/${pack.booking.ref}/map?route=${encodeURIComponent(`${stay.airportId}__${stay.hotelId}`)}`} size="md"><MapPin size={18} /> Route</LinkButton>
          </div>
        </Card>
      </div>

      <Card className="grid grid-cols-2 items-start gap-4" data-testid="local-time">
        <div><h2 className="flex items-center gap-2 text-[15px] text-muted"><Clock size={18} strokeWidth={1.75} /> Local time in {stay.cityName}</h2><p className="text-[28px] font-semibold">{fmtTimeZ(now, stay.tz)}</p><p className="text-[15px] text-muted">India: {fmtTimeZ(now, "Asia/Kolkata")}</p></div>
        <div><h2 className="flex items-center gap-2 text-[15px] text-muted"><Sun size={18} strokeWidth={1.75} /> Weather</h2>{weather ? <div><p className="text-[28px] font-semibold">{weather.tempC !== null ? `${Math.round(weather.tempC)}°C` : "—"}</p><p className="text-[15px] leading-tight text-muted">{weather.summary}</p></div> : <p className="text-[15px] text-muted">{t.net === "online" ? "Loading…" : "Online only"}</p>}</div>
      </Card>

      <DayPlan pack={pack} today={now.toISOString().slice(0, 10)} />

      <div>
        <SectionTitle>Quick help</SectionTitle>
        <div className="grid grid-cols-2 gap-3">
          <LinkButton href={`/trips/${pack.booking.ref}/chat`} variant="primary" size="lg">Ask the agent</LinkButton>
          <LinkButton href={`/trips/${pack.booking.ref}/guide`} size="lg">Offline guide</LinkButton>
          <LinkButton href={`/trips/${pack.booking.ref}/map`} size="lg">Offline map</LinkButton>
          <LinkButton href={`/trips/${pack.booking.ref}/sos`} variant="danger" size="lg">SOS</LinkButton>
        </div>
      </div>

      <Card className="space-y-3">
        <h2 className="text-[17px] font-semibold">Install on your phone</h2>
        <InstallPrompt />
        <Link href={`/trips/${pack.booking.ref}/voucher`} className="inline-flex items-center gap-2 text-accent underline"><Printer size={18} /> Booking voucher · {inr(pack.booking.totalInr)}</Link>
      </Card>
      <p className="pb-4 text-[14px] text-muted">{pack.disclaimer} All trip details are sample data. Local time now: {localTime(now, stay.tz)}.</p>
    </div>
  );
}

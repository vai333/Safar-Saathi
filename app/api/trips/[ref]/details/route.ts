import { bookingForSession } from "@/lib/server/access";
import { GateError } from "@/lib/gate/errors";
import { handle, json, readJson } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/ratelimit";
import { requireSession } from "@/lib/server/session";
import { addTripDetails, DetailsInput } from "@/lib/server/trip-details";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The traveller adds a flight or hotel that was missing from their uploaded plan. Their own record; nothing is booked or paid. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ ref: string }> }) => {
  const sess = await requireSession();
  rateLimit(`details:${sess.uid}`, 20, 60_000);
  const { ref } = await ctx.params;
  const input = await readJson(req, DetailsInput);
  const booking = await bookingForSession(ref, sess);
  if (booking.userId !== sess.uid) throw new GateError("FORBIDDEN", 403, "That booking belongs to someone else.");
  return json(await addTripDetails(booking.id, input), 201);
});

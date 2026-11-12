/**
 * Topic guard for the Trip agent. It only talks about travel and what goes with it (the trip itself, flights, stays, visas,
 * safety, health and hygiene on the road, packing, money, food, local tips). Obvious off-topic requests and attempts to
 * override these rules are refused here, before any model call. The system prompt repeats the rule for everything subtler.
 */
export const SCOPE_REFUSAL = "I can only help with travel: your trip, flights and stays, visas, safety, health and hygiene on the road, packing, money, food and local tips. Ask me something about your trip.";

/** Words that show the message is about travel. A message with one of these goes to the agent. */
const TRAVEL = /\b(trip|travel\w*|tour\w*|journey|itinerar\w*|holiday|vacation|flight\w*|airline|airport|boarding|layover|transit|visa\w*|passport|immigration|customs|luggage|baggage|suitcase|pack(ing)?|hotel\w*|hostel|stay\w*|check[- ]?(in|out)|room|booking|ticket\w*|pickup|transfer|driver|cab|taxi|uber|metro|train|bus|ferry|sightsee\w*|museum|temple|beach|city|country|abroad|foreign|overseas|destination|forex|currency|exchange rate|sim card|esim|roaming|wifi|insurance|vaccin\w*|medicine|medical|hospital|doctor|pharmacy|hygiene|sanitis\w*|sanitiz\w*|toilet|washroom|bathroom|wash|clean|germs?|stomach|diarrh\w*|food poisoning|tap water|bottled water|drink(ing)? water|street food|restaurant|vegetarian|jain|halal|allerg\w*|jet ?lag|altitude|sunscreen|mosquito|malaria|dengue|safe|safety|scam\w*|pickpocket|theft|stolen|lost|emergency|embassy|consulate|sos|police|weather|season|tip(ping)?|etiquette|dress code|language|plug|adapter|power bank|tourist|local|guide|map|route|directions?|souvenir|shopping|duty[- ]free|offline|itinerary|day plan|plan)\b/i;

/** Clearly unrelated subjects. Only refused when the message has no travel word. */
const OFF_TOPIC = /\b(python|javascript|typescript|java|c\+\+|html|css|sql|react|code|coding|program(ming)?|script|algorithm|debug|compile|regex|leetcode|homework|assignment|essay|poem|poetry|song|lyrics|story|joke|riddle|rap|translate this|math problem|equation|integral|derivative|solve for|calculate|stocks?|shares?|mutual fund|crypto\w*|bitcoin|ethereum|trading|forex trading|lottery|bet(ting)?|casino|horoscope|astrology|politic\w*|election|vote|prime minister|president|religion debate|dating|girlfriend|boyfriend|marriage advice|relationship|breakup|resume|cv|cover letter|interview question|exam|neet|jee|upsc|syllabus|recipe for|movie review|web series|cricket score|ipl|football score|celebrity|gossip|diagnos\w+|prescri\w+|lawsuit|tax return|itr|loan|emi|credit score)\b/i;

/** Attempts to change the agent's rules or role. Refused even if a travel word is present. */
const OVERRIDE = /(ignore|forget|disregard|override|bypass)\s+(all\s+|any\s+|your\s+|the\s+|previous\s+|prior\s+|above\s+)*(instructions?|rules?|prompt|guidelines?|restrictions?)|system\s*prompt|developer\s*mode|jailbreak|\bDAN\b|pretend (you are|to be)|act as (a |an )?(?!travel)|you are now|roleplay as|reveal your (instructions|prompt)/i;

/** A quick check on the raw message. Returns the refusal text when the message must not reach the model, otherwise null. */
export function scopeRefusal(message: string): string | null {
  const m = message.trim();
  if (!m) return null;
  if (OVERRIDE.test(m)) return SCOPE_REFUSAL;
  if (OFF_TOPIC.test(m) && !TRAVEL.test(m)) return SCOPE_REFUSAL;
  return null;
}

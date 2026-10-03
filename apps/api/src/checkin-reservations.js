import { isCheckinToken, readCheckinToken, checkinTokenMatches } from "./checkin-links.js";

export async function resolveCheckinBooking(token, { secret, config, readSnapshots, findRecord }) {
  if (!isCheckinToken(token)) return null;
  const signed = readCheckinToken(token, secret);
  if (token.startsWith("v2.") && !signed) return null;
  const locationFor = clubId => clubId === config.viennaClubId ? "vienna" : "st-poelten";
  const cached = (await readSnapshots(signed)).find(row => signed
    ? row.clubId === signed.clubId && row.bookingId === signed.bookingId
    : checkinTokenMatches(token, secret, row.clubId, row.bookingId));
  if (cached) return { location: locationFor(cached.clubId), clubId: cached.clubId, ...cached.snapshot };
  const locations = signed
    ? [{ clubId: signed.clubId }]
    : [{ clubId: config.defaultClubId }, { clubId: config.viennaClubId }].filter(item => item.clubId);
  for (const { clubId } of locations) {
    const matches = bookingId => /^[a-z0-9]{26}$/.test(bookingId)
      && (signed ? bookingId === signed.bookingId : checkinTokenMatches(token, secret, clubId, bookingId));
    let visit = null, booking = null, appError = null;
    try {
      visit = await findRecord(clubId, item => matches(String(item?.booking_id || item?.booking?.id || "")), false);
    } catch (error) { appError = error; }
    if (!visit) {
      booking = await findRecord(clubId, item => matches(String(item?.id || "")), true);
      if (booking) visit = checkinVisitFromBooking(booking);
      else if (appError) throw appError;
    }
    if (visit) return { location: locationFor(clubId), clubId, visit, booking };
  }
  return null;
}

// App visits are paginated even when no upcoming filter is supplied. Never
// mistake a booking beyond page 1 for an invalid link.
export async function findPaginatedCheckinRecord(fetchPage, matches) {
  const seenPages = new Set();
  let received = 0;
  for (let page = 1; ; page += 1) {
    const payload = await fetchPage(page);
    if (!Array.isArray(payload?.data)) throw new Error("Invalid Time to Grow booking list");
    const rows = payload.data;
    received += rows.length;
    const found = rows.find(matches);
    if (found) return found;
    if (!rows.length) return null;
    const pageKey = JSON.stringify(rows.map(row => row.id));
    if (seenPages.has(pageKey)) throw new Error("Time to Grow pagination did not advance");
    seenPages.add(pageKey);
    const pagination = payload.pagination;
    const lastPage = Number(pagination?.last_page ?? pagination?.total_pages);
    if (lastPage > 0 && page >= lastPage) return null;
    const total = Number(pagination?.total);
    if (Number.isFinite(total) && total >= 0 && received >= total) return null;
    // Request the following page even for a short page: upstream can cap the
    // requested page size and omit pagination metadata.
  }
}

export function checkinVisitFromBooking(booking) {
  return {
    id: booking.id,
    booking_id: booking.id,
    start: booking.start,
    size: booking.size,
    name: booking.owner?.name || booking.customer?.name,
    product: booking.product,
  };
}

import { HttpEvent, HttpHandlerFn, HttpRequest } from "@angular/common/http";
import { Observable, shareReplay, tap } from "rxjs";

const responseCache = new Map<string, Observable<HttpEvent<unknown>>>();

const isCachedTimeToGrowRead = (request: HttpRequest<unknown>) =>
  request.method === "GET"
  && (request.url === "/api/time-to-grow/clubs" || request.url === "/api/time-to-grow/bookings");

export function timeToGrowCacheInterceptor(
  request: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  if (request.url.startsWith("/api/time-to-grow/") && request.method !== "GET") {
    responseCache.clear();
    return next(request);
  }

  if (!isCachedTimeToGrowRead(request)) return next(request);

  const key = `${request.urlWithParams}|${request.headers.get("authorization") || ""}`;
  const cached = responseCache.get(key);
  if (cached) return cached;

  const response = next(request).pipe(
    tap({ error: () => responseCache.delete(key) }),
    shareReplay({ bufferSize: 1, refCount: false }),
  );
  responseCache.set(key, response);
  return response;
}

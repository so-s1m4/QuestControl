import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Router } from "@angular/router";
import { Observable, finalize, map, shareReplay, throwError } from "rxjs";

type RefreshResponse = { accessToken: string };

@Injectable({ providedIn: "root" })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private refreshRequest?: Observable<string>;

  refreshAccessToken(): Observable<string> {
    const refreshToken = localStorage.getItem("refresh_token");
    if (!refreshToken) return throwError(() => new Error("NO_REFRESH_TOKEN"));

    if (!this.refreshRequest) {
      this.refreshRequest = this.http
        .post<RefreshResponse>("/api/auth/refresh", { refreshToken })
        .pipe(
          map(({ accessToken }) => {
            sessionStorage.setItem("access_token", accessToken);
            return accessToken;
          }),
          finalize(() => { this.refreshRequest = undefined; }),
          shareReplay({ bufferSize: 1, refCount: false }),
        );
    }

    return this.refreshRequest;
  }

  clearSession() {
    sessionStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
  }

  redirectToLogin() {
    this.clearSession();
    void this.router.navigateByUrl("/login");
  }
}

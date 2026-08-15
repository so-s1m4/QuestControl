import { inject } from "@angular/core";
import { CanActivateFn, Router } from "@angular/router";
import { catchError, map, of } from "rxjs";
import { AuthService } from "./auth.service";

export const authGuard: CanActivateFn = () => {
  if (sessionStorage.getItem("access_token")) return true;
  const router=inject(Router);
  const auth=inject(AuthService);
  if (!localStorage.getItem("refresh_token")) return router.createUrlTree(["/login"]);
  return auth.refreshAccessToken().pipe(
    map(()=>true),
    catchError(()=>{
      auth.clearSession();
      return of(router.createUrlTree(["/login"]));
    }),
  );
};

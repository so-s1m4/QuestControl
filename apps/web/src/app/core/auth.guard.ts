import { inject } from "@angular/core";
import { CanActivateFn, Router } from "@angular/router";
import { catchError, map, of } from "rxjs";
import { AuthService } from "./auth.service";

export const authGuard: CanActivateFn = (_route,state) => {
  const current=sessionStorage.getItem("access_token");
  if (current) {
    try { if(JSON.parse(atob(current.split(".")[1])).role==="CAMERA_VIEWER" && state.url!=="/cameras") return inject(Router).createUrlTree(["/cameras"]); } catch {}
    return true;
  }
  const router=inject(Router);
  const auth=inject(AuthService);
  if (!localStorage.getItem("refresh_token")) return router.createUrlTree(["/login"]);
  return auth.refreshAccessToken().pipe(
    map(token=>{try{return JSON.parse(atob(token.split(".")[1])).role==="CAMERA_VIEWER"&&state.url!=="/cameras"?router.createUrlTree(["/cameras"]):true}catch{return true}}),
    catchError(()=>{
      auth.clearSession();
      return of(router.createUrlTree(["/login"]));
    }),
  );
};

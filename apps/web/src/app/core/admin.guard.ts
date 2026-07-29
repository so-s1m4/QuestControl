import { inject } from "@angular/core";
import { CanActivateFn, Router } from "@angular/router";

export const adminGuard: CanActivateFn = () => {
  try {
    const token=sessionStorage.getItem("access_token");
    const role=token ? JSON.parse(atob(token.split(".")[1])).role : null;
    if (role==="OWNER" || role==="ADMIN") return true;
  } catch {}
  return inject(Router).createUrlTree(["/"]);
};

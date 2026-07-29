import { HttpErrorResponse, HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { Router } from "@angular/router";
import { catchError, EMPTY, throwError } from "rxjs";

export const authInterceptor:HttpInterceptorFn=(req,next)=>{
  const router=inject(Router);
  const token=sessionStorage.getItem("access_token");
  const authorizedReq=token?req.clone({setHeaders:{Authorization:`Bearer ${token}`}}):req;
  return next(authorizedReq).pipe(catchError((error:HttpErrorResponse)=>{
    if(error.status===401&&!req.url.includes("/auth/login")){
      sessionStorage.removeItem("access_token");
      localStorage.removeItem("refresh_token");
      void router.navigateByUrl("/login");
      return EMPTY;
    }
    return throwError(()=>error);
  }));
};

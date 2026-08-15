import { HttpErrorResponse, HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { catchError, switchMap, throwError } from "rxjs";
import { AuthService } from "./auth.service";

export const authInterceptor:HttpInterceptorFn=(req,next)=>{
  const auth=inject(AuthService);
  const token=sessionStorage.getItem("access_token");
  const authorizedReq=token?req.clone({setHeaders:{Authorization:`Bearer ${token}`}}):req;
  return next(authorizedReq).pipe(catchError((error:HttpErrorResponse)=>{
    const isAuthRequest=req.url.includes("/auth/login")||req.url.includes("/auth/refresh");
    if(error.status===401&&!isAuthRequest){
      return auth.refreshAccessToken().pipe(
        switchMap(accessToken=>next(req.clone({setHeaders:{Authorization:`Bearer ${accessToken}`}}))),
        catchError(refreshError=>{
          auth.redirectToLogin();
          return throwError(()=>refreshError);
        }),
      );
    }
    return throwError(()=>error);
  }));
};
